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

function expandEnv(value: string, env: Record<string, string>): string {
  return value.replace(ENV_PLACEHOLDER, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    if (typeof resolved === "string" && resolved.length > 0) return resolved;
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
 * The child expands the very same syntax against the very same env — the env
 * this module validates against is the resolved child env — so passing the
 * placeholder through is not a downgrade: the credential still arrives, it
 * just never transits argv. Validation is unchanged and still runs first, so
 * a server whose `${VAR}` is unset is skipped here exactly as before and a
 * literal `${VAR}` can never reach the wire as a broken header.
 */
function validateOnly(value: string, env: Record<string, string>): string {
  expandEnv(value, env);
  return value;
}

type Resolver = (value: string) => string;

function makeResolver(input: ResolveExtraArgsMcpInput): Resolver {
  // A remote target runs the child under an env this process does not own, so
  // a placeholder there would be expanded against the wrong environment, or
  // not at all. Remote keeps the substitution, and the argv exposure with it.
  const resolve = input.executionTargetIsRemote ? expandEnv : validateOnly;
  return (value: string) => resolve(value, input.env);
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

function toServer(
  name: string,
  entry: Record<string, unknown>,
  resolve: Resolver,
): { server: McpServer; identity: ExtraArgsMcpIdentity } | null {
  const type = asTrimmedString(entry.type).toLowerCase();
  const url = asTrimmedString(entry.url);
  const command = asTrimmedString(entry.command);

  if (url && type !== "stdio") {
    const expandedUrl = resolve(url);
    const headers = toHeaderList(entry.headers, resolve);
    const server = (type === "sse"
      ? { type: "sse", name, url: expandedUrl, headers }
      : { type: "http", name, url: expandedUrl, headers }) as McpServer;
    return { server, identity: { name, url: expandedUrl, connectionId: "adapter-config:extraArgs" } };
  }

  if (command) {
    const expandedCommand = resolve(command);
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string").map((arg) => resolve(arg))
      : [];
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
        url: [expandedCommand, ...args].join(" "),
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
  const resolve = makeResolver(input);

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
        built = toServer(name, entry, resolve);
      } catch (error) {
        if (error instanceof UnresolvedPlaceholderError) {
          warnings.push(
            `MCP server "${name}" from --mcp-config was skipped: \${${error.variable}} is not set in this agent's env.`,
          );
          continue;
        }
        throw error;
      }
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

  return { servers, identities, warnings, honoredSources };
}
