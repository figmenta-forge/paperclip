import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeOptions } from "acpx/runtime";

type McpServer = NonNullable<AcpRuntimeOptions["mcpServers"]>[number];

/**
 * `adapterConfig.extraArgs` is a Claude/Codex *CLI* concept: the CLI lane
 * appends it to argv verbatim. The ACP lane has no argv to append to — the
 * agent process is launched by acpx and configured over the protocol — so
 * every extraArgs entry used to be dropped in silence, `--mcp-config`
 * included. This module translates the one flag that has a real ACP
 * equivalent (`--mcp-config`, whose servers map onto `session/new`
 * mcpServers) and reports everything it cannot honor so the drop is never
 * silent again.
 */

export interface ExtraArgsMcpIdentity {
  name: string;
  /**
   * The server's address as *written* in the config — url for http/sse,
   * `command args…` for stdio — never the resolved form. See `toServer`.
   */
  url: string;
  connectionId: string;
}

export interface ExtraArgsMcpResolution {
  servers: McpServer[];
  identities: ExtraArgsMcpIdentity[];
  /** Human-readable lines to surface on the run log. */
  warnings: string[];
  /** `--mcp-config` values that produced at least one mounted server. */
  honoredSources: string[];
}

export interface ResolveExtraArgsMcpInput {
  extraArgs: string[];
  /** Execution cwd — relative `--mcp-config` paths resolve against it. */
  cwd: string;
  /** Resolved child env, used to expand `${VAR}` / `${VAR:-default}`. */
  env: Record<string, string>;
  /**
   * ACPX agent id this config is bound for (`execute.ts` `acpxAgent`). Whether
   * a `${VAR}` may travel unexpanded is a property of *this*, not of the
   * execution target: only the claude CLI expands the syntax itself. Required
   * so a new lane cannot inherit the claude assumption by omission.
   */
  agent: string;
  /**
   * True when the child expands `${VAR}` against an env this process did not
   * hand it — substituting here is then the only way the value can arrive.
   *
   * Deliberately not `executionTargetIsRemote`, which answers a different
   * question (where does the config *file* live) and only stood in for this
   * one. A sandbox target is remote and still runs its child under the env
   * this process shipped it, so "remote" over-reports foreignness and buys a
   * gratuitous argv exposure. Required, like `agent`, so a caller has to
   * answer rather than inherit an assumption by omission.
   */
  childEnvIsForeign: boolean;
  /** Remote targets keep their config files on the remote host. */
  executionTargetIsRemote?: boolean;
  /** Names already taken by Paperclip tool connections; those win. */
  reservedNames?: string[];
  /** Injectable for tests. */
  readFile?: (filePath: string) => Promise<string>;
}

const MCP_CONFIG_FLAG = "--mcp-config";
const ENV_PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

interface CollectedArgs {
  values: string[];
  unsupported: string[];
}

function collectMcpConfigValues(extraArgs: string[]): CollectedArgs {
  const values: string[] = [];
  const unsupported: string[] = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const arg = extraArgs[index];
    if (typeof arg !== "string" || arg.trim().length === 0) continue;
    if (arg === MCP_CONFIG_FLAG) {
      const value = extraArgs[index + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        values.push(value.trim());
        index += 1;
        continue;
      }
      unsupported.push(arg);
      continue;
    }
    if (arg.startsWith(`${MCP_CONFIG_FLAG}=`)) {
      const value = arg.slice(MCP_CONFIG_FLAG.length + 1).trim();
      if (value.length > 0) {
        values.push(value);
        continue;
      }
      unsupported.push(arg);
      continue;
    }
    unsupported.push(arg);
  }
  return { values, unsupported };
}

class UnresolvedPlaceholderError extends Error {
  constructor(readonly variable: string) {
    super(`unresolved \${${variable}}`);
  }
}

function collectPlaceholderNames(value: string, into: Set<string>): void {
  for (const match of value.matchAll(ENV_PLACEHOLDER)) into.add(match[1] as string);
}

/**
 * `typeof resolved === "string"` and not `resolved.length > 0`: an empty value
 * counts as *set*, because that is what the agent that re-expands this does.
 * Measured on the served claude binary: `if (typeof d === "string") return d`,
 * so `${A:-anon}` with `A=""` yields `""` there. Reading `""` as unset here
 * would validate against `anon` while the child ships the empty string — the
 * two sides must answer "is it set?" the same way or the value on the wire is
 * not the value we checked.
 */
function expandEnv(
  value: string,
  env: Record<string, string>,
  onSubstitute?: (name: string) => void,
): string {
  return value.replace(ENV_PLACEHOLDER, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (typeof resolved === "string") {
      if (resolved.length > 0) onSubstitute?.(name);
      return resolved;
    }
    if (typeof fallback === "string") return fallback;
    throw new UnresolvedPlaceholderError(name);
  });
}

/**
 * A value resolved here does not stay here: it is handed to the agent over
 * `session/new`, and the Claude Agent SDK serializes those servers straight
 * into the child's argv (`--mcp-config <inline JSON>`). `/proc/<pid>/cmdline`
 * is world-readable (0444) while `/proc/<pid>/environ` is not (0400), so
 * substituting a `${TOKEN}` here republishes it to every local uid, while
 * leaving the placeholder alone keeps it in the private surface it came from.
 *
 * This is sound only where the destination agent expands the very same syntax
 * against the very same env — the claude CLI does, measured on the served
 * binary (`expandVars` on the `--mcp-config` path, same
 * `${VAR}` / `${VAR:-default}` grammar). `makeResolvePlan` is what restricts
 * the pass-through to that one agent; everywhere else the placeholder would
 * ship literally and break the server.
 *
 * Validation still runs first, so a server whose `${VAR}` is unset is skipped
 * here exactly as before. What that does *not* buy is a guarantee about the
 * wire: it holds in this process, not in the child. The child does not fail
 * closed — on a missing variable its expander returns the original `${VAR}`
 * match, records it as missing, and mounts the server anyway with a broken
 * value. Any drift between the env validated here and the env the child
 * expands against therefore turns a skip here into a live server with a bad
 * header there. Treat this as an assumption about the child, not as an
 * invariant this module enforces.
 */
function validateOnly(value: string, env: Record<string, string>): string {
  expandEnv(value, env);
  return value;
}

type Resolver = (value: string) => string;

interface ResolvePlan {
  resolve: Resolver;
  /** False when placeholders travel unexpanded (claude, local). */
  substituting: boolean;
  /** Names whose value was substituted into a *mounted* server, hence into argv. */
  substituted: Set<string>;
  /** Names left unexpanded inside a *mounted* stdio server's `args`. */
  stdioArgPlaceholders: Set<string>;
  /**
   * Resolution happens before we know whether the server survives (a later
   * placeholder in the same entry can be unset and skip the whole thing), so
   * names land here first and are promoted only once the server is mounted.
   * Reporting an exposure for a server that was skipped would be a false
   * claim, and these warnings exist to be believed.
   */
  pendingSubstituted: Set<string>;
  pendingStdioArgs: Set<string>;
}

function settlePending(plan: ResolvePlan, mounted: boolean): void {
  if (mounted) {
    for (const name of plan.pendingSubstituted) plan.substituted.add(name);
    for (const name of plan.pendingStdioArgs) plan.stdioArgPlaceholders.add(name);
  }
  plan.pendingSubstituted.clear();
  plan.pendingStdioArgs.clear();
}

function makeResolvePlan(input: ResolveExtraArgsMcpInput): ResolvePlan {
  // The condition is "does the destination agent expand `${VAR}` itself", a
  // property of the agent — not of local-vs-remote, which only ever stood in
  // for it. `resolveExtraArgsMcpServers` runs for every acpx lane
  // (claude/codex/gemini/custom, see constants.ts) and only claude expands:
  // the codex ACP bridge copies headers verbatim
  // (`http_headers: Object.fromEntries(mcpServer.headers.map(...))`) and the
  // codex binary resolves credentials through `bearer_token_env_var` /
  // `env_http_headers` instead, so a placeholder handed to it goes on the wire
  // literally and earns a 401. Deciding on the target instead of the agent
  // would have made that a silent regression — the exact "config field that
  // looks applied and does nothing" this module exists to end (FIG-1536).
  //
  // The second reason to substitute is separate and narrower than "remote":
  // a child that expands against an env this process never handed it cannot
  // resolve a placeholder, so the value has to travel resolved. `remote` was
  // the stand-in for that and over-reports it — see `childEnvIsForeign`.
  const substituting = input.agent !== "claude" || input.childEnvIsForeign;
  const pendingSubstituted = new Set<string>();
  const resolve: Resolver = substituting
    ? (value) => expandEnv(value, input.env, (name) => pendingSubstituted.add(name))
    : (value) => validateOnly(value, input.env);
  return {
    resolve,
    substituting,
    substituted: new Set<string>(),
    stdioArgPlaceholders: new Set<string>(),
    pendingSubstituted,
    pendingStdioArgs: new Set<string>(),
  };
}

/**
 * Substituting is the correct call on these lanes, but it is also the FIG-1550
 * exposure: say so instead of leaking the credential quietly.
 */
function describeSubstitution(input: ResolveExtraArgsMcpInput, plan: ResolvePlan): string | null {
  if (plan.substituted.size === 0) return null;
  const names = [...plan.substituted].map((name) => `\${${name}}`).join(", ");
  const reason =
    input.agent !== "claude"
      ? `the "${input.agent}" agent does not expand \${VAR} itself (only "claude" does), so the placeholder cannot be passed through`
      : "the child expands against an env this process does not supply, so the placeholder would not resolve there";
  return (
    `--mcp-config: ${names} substituted into the MCP config because ${reason}. ` +
    `The value transits the child's argv, which /proc/<pid>/cmdline exposes to every local uid (0444); ` +
    `prefer a credential the agent reads from its own environment.`
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readServerMap(parsed: unknown): Record<string, unknown> | null {
  const record = asRecord(parsed);
  if (!record) return null;
  const nested = asRecord(record.mcpServers);
  return nested ?? record;
}

function toHeaderList(
  value: unknown,
  resolve: Resolver,
): Array<{ name: string; value: string }> {
  const record = asRecord(value);
  if (!record) return [];
  const headers: Array<{ name: string; value: string }> = [];
  for (const [name, raw] of Object.entries(record)) {
    if (typeof raw !== "string") continue;
    headers.push({ name, value: resolve(raw) });
  }
  return headers;
}

/**
 * The server carries resolved values; the identity carries the ones as
 * written. They are different objects with different destinations: the server
 * goes to the agent over `session/new`, the identity goes back to the host in
 * the run's `sessionParams` and into the config fingerprint. Only the first
 * needs the value, so on a substituting lane a resolved identity would put a
 * credential on a surface that has no use for it — the same class as FIG-1550,
 * one surface over. Nothing is lost: a rotation still invalidates the warm
 * session through the resolved adapter env, which is hashed into the same
 * fingerprint, and the placeholder is the more stable name for the server
 * anyway.
 */
function toServer(
  name: string,
  entry: Record<string, unknown>,
  plan: ResolvePlan,
): { server: McpServer; identity: ExtraArgsMcpIdentity } | null {
  const resolve = plan.resolve;
  const type = asTrimmedString(entry.type).toLowerCase();
  const url = asTrimmedString(entry.url);
  const command = asTrimmedString(entry.command);

  if (url && type !== "stdio") {
    const expandedUrl = resolve(url);
    const headers = toHeaderList(entry.headers, resolve);
    const server = (type === "sse"
      ? { type: "sse", name, url: expandedUrl, headers }
      : { type: "http", name, url: expandedUrl, headers }) as McpServer;
    return { server, identity: { name, url, connectionId: "adapter-config:extraArgs" } };
  }

  if (command) {
    const expandedCommand = resolve(command);
    const rawArgs = Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const args = rawArgs.map((arg) => {
      // Passing a placeholder through keeps it out of *this* child's argv, but
      // a stdio server is then spawned by that child from the expanded args —
      // the value lands in the MCP server process's own cmdline. Record it so
      // the residue is reported, not implied away.
      if (!plan.substituting) collectPlaceholderNames(arg, plan.pendingStdioArgs);
      return resolve(arg);
    });
    const serverEnv = toHeaderList(entry.env, resolve);
    const server = {
      name,
      command: expandedCommand,
      args,
      env: serverEnv,
    } as McpServer;
    return {
      server,
      identity: {
        name,
        url: [command, ...rawArgs].join(" "),
        connectionId: "adapter-config:extraArgs",
      },
    };
  }

  return null;
}

async function readConfigDocument(
  source: string,
  input: ResolveExtraArgsMcpInput,
  warnings: string[],
): Promise<unknown | null> {
  if (source.startsWith("{")) {
    try {
      return JSON.parse(source);
    } catch (error) {
      warnings.push(`inline --mcp-config JSON is not parseable (${(error as Error).message}).`);
      return null;
    }
  }
  if (input.executionTargetIsRemote) {
    warnings.push(
      `--mcp-config "${source}" was not mounted: file-based MCP config is not read for remote execution targets.`,
    );
    return null;
  }
  const filePath = path.isAbsolute(source) ? source : path.resolve(input.cwd, source);
  const readFile = input.readFile ?? ((candidate: string) => fs.readFile(candidate, "utf8"));
  let raw: string;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    warnings.push(`--mcp-config "${filePath}" was not mounted: ${(error as Error).message}.`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    warnings.push(`--mcp-config "${filePath}" is not parseable JSON (${(error as Error).message}).`);
    return null;
  }
}

/**
 * Translate `--mcp-config` entries carried by `extraArgs` into ACP
 * `session/new` MCP servers. Anything that cannot be honored comes back as a
 * warning instead of disappearing.
 */
export async function resolveExtraArgsMcpServers(
  input: ResolveExtraArgsMcpInput,
): Promise<ExtraArgsMcpResolution> {
  const servers: McpServer[] = [];
  const identities: ExtraArgsMcpIdentity[] = [];
  const warnings: string[] = [];
  const honoredSources: string[] = [];
  const taken = new Set(input.reservedNames ?? []);
  const plan = makeResolvePlan(input);

  const { values, unsupported } = collectMcpConfigValues(input.extraArgs);
  if (unsupported.length > 0) {
    warnings.push(
      `the ACP engine ignores these adapterConfig.extraArgs entries (they are CLI-lane only): ${unsupported.join(" ")}.`,
    );
  }

  for (const source of values) {
    const parsed = await readConfigDocument(source, input, warnings);
    if (parsed === null) continue;
    const serverMap = readServerMap(parsed);
    if (!serverMap || Object.keys(serverMap).length === 0) {
      warnings.push(`--mcp-config "${source}" declares no MCP server.`);
      continue;
    }
    let mounted = 0;
    for (const [rawName, rawEntry] of Object.entries(serverMap)) {
      const name = rawName.trim();
      const entry = asRecord(rawEntry);
      if (!name || !entry) continue;
      if (taken.has(name)) {
        warnings.push(`MCP server "${name}" from --mcp-config was skipped: that name is already mounted.`);
        continue;
      }
      let built: { server: McpServer; identity: ExtraArgsMcpIdentity } | null;
      try {
        built = toServer(name, entry, plan);
      } catch (error) {
        settlePending(plan, false);
        if (error instanceof UnresolvedPlaceholderError) {
          warnings.push(
            `MCP server "${name}" from --mcp-config was skipped: \${${error.variable}} is not set in this agent's env.`,
          );
          continue;
        }
        throw error;
      }
      settlePending(plan, built !== null);
      if (!built) {
        warnings.push(`MCP server "${name}" from --mcp-config was skipped: neither a url nor a command is declared.`);
        continue;
      }
      taken.add(name);
      servers.push(built.server);
      identities.push(built.identity);
      mounted += 1;
    }
    if (mounted > 0) honoredSources.push(source);
  }

  const substitutionNote = describeSubstitution(input, plan);
  if (substitutionNote) warnings.push(substitutionNote);
  if (plan.stdioArgPlaceholders.size > 0) {
    const names = [...plan.stdioArgPlaceholders].map((name) => `\${${name}}`).join(", ");
    warnings.push(
      `--mcp-config: ${names} is passed through unexpanded in a stdio server's args, but the agent expands args ` +
        `before spawning that server, so the value still reaches that process's own argv (0444). ` +
        `A stdio server's env is the only field kept off argv end to end.`,
    );
  }

  return { servers, identities, warnings, honoredSources };
}
