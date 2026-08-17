import { describe, expect, it } from "vitest";
import { resolveExtraArgsMcpServers } from "./mcp-config.js";

const FLEET_CONFIG = JSON.stringify({
  mcpServers: {
    "vps-mcp-figmenta": {
      type: "http",
      url: "https://vps-mcp.example/mcp",
      headers: { Authorization: "Bearer ${VPS_MCP_TOKEN}" },
    },
  },
});

function readFileFrom(files: Record<string, string>) {
  return async (filePath: string) => {
    const contents = files[filePath];
    if (contents === undefined) throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    return contents;
  };
}

describe("resolveExtraArgsMcpServers", () => {
  it("mounts an http server from a --mcp-config file without resolving the credential into it", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
      readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
    });

    // The placeholder travels; the secret does not. Whatever we put here is
    // serialized into the child's argv, which every local uid can read. For an
    // http header this is the whole trip: claude expands it in-process when it
    // opens the connection, so the value never becomes anyone's argv.
    expect(result.servers).toEqual([
      {
        type: "http",
        name: "vps-mcp-figmenta",
        url: "https://vps-mcp.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer ${VPS_MCP_TOKEN}" }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("t0ken");
    expect(result.identities).toEqual([
      {
        name: "vps-mcp-figmenta",
        url: "https://vps-mcp.example/mcp",
        connectionId: "adapter-config:extraArgs",
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.honoredSources).toEqual(["/etc/fleet-mcp.json"]);
  });

  it("substitutes for an agent that does not expand ${VAR} itself, and says so", async () => {
    for (const agent of ["codex", "gemini", "custom"]) {
      const result = await resolveExtraArgsMcpServers({
        extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
        cwd: "/work",
        childEnvIsForeign: false,
        agent,
        env: { VPS_MCP_TOKEN: "t0ken" },
        readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
      });

      // Only claude re-expands the placeholder downstream. Handing `${VAR}` to
      // the codex bridge — which copies headers verbatim into `http_headers` —
      // would put the literal on the wire and earn a 401, so the value is
      // substituted here and the argv exposure is reported rather than hidden.
      expect(result.servers).toEqual([
        {
          type: "http",
          name: "vps-mcp-figmenta",
          url: "https://vps-mcp.example/mcp",
          headers: [{ name: "Authorization", value: "Bearer t0ken" }],
        },
      ]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("${VPS_MCP_TOKEN}");
      expect(result.warnings[0]).toContain(`the "${agent}" agent does not expand`);
      expect(result.warnings[0]).toContain("argv");
    }
  });

  it("keeps a stdio server's args and env unresolved, and reports what args still leak", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [
        `--mcp-config={"mcpServers":{"s":{"command":"srv","args":["--key","\${VPS_MCP_TOKEN}"],"env":{"KEY":"\${VPS_MCP_TOKEN}"}}}}`,
      ],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
    });

    expect(result.servers).toEqual([
      {
        name: "s",
        command: "srv",
        args: ["--key", "${VPS_MCP_TOKEN}"],
        env: [{ name: "KEY", value: "${VPS_MCP_TOKEN}" }],
      },
    ]);

    // Scope, deliberately narrow: the secret is absent from *this module's*
    // output, which is not the same as absent from the system. claude expands
    // stdio args before spawning the server, so `--key t0ken` still lands in
    // that server process's /proc/<pid>/cmdline. The exposure moves one process
    // over; only the stdio `env` field is genuinely off argv end to end. The
    // warning is what keeps that residue visible.
    expect(result.warnings).toEqual([
      '--mcp-config: ${VPS_MCP_TOKEN} is passed through unexpanded in a stdio server\'s args, but the agent ' +
        "expands args before spawning that server, so the value still reaches that process's own argv (0444). " +
        "A stdio server's env is the only field kept off argv end to end.",
    ]);
  });

  it("treats an empty env value as set, exactly as the child's expander does", async () => {
    const config = JSON.stringify({
      mcpServers: {
        a: { type: "http", url: "https://a.example/mcp", headers: { Authorization: "Bearer ${A:-anon}" } },
      },
    });
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/c.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      // Reachable: execute.ts filters out non-strings only, so an adapterConfig
      // value or a secret_ref that resolves to "" arrives here as an empty
      // string. The child reads that as *set* (`typeof d === "string"`) and
      // expands to "", never to `anon`.
      env: { A: "" },
      readFile: readFileFrom({ "/etc/c.json": config }),
    });

    // Validation must agree with the child, so the fallback does not apply and
    // the server mounts. Answering "unset" here would have validated against
    // `anon` while the child put an empty credential on the wire.
    expect(result.servers.map((server) => server.name)).toEqual(["a"]);
    expect(result.warnings).toEqual([]);

    // Same input on a lane that substitutes: "" wins over the fallback there
    // too, which is what makes the two answers one answer.
    const substituting = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/c.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "codex",
      env: { A: "" },
      readFile: readFileFrom({ "/etc/c.json": config }),
    });
    expect(substituting.servers).toEqual([
      {
        type: "http",
        name: "a",
        url: "https://a.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer " }],
      },
    ]);
    // Nothing secret entered argv, so no substitution warning is raised.
    expect(substituting.warnings).toEqual([]);
  });

  it("does not claim an argv exposure for a server that was skipped", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [
        `--mcp-config={"mcpServers":{"s":{"type":"http","url":"https://s.example/\${SET}","headers":{"Authorization":"Bearer \${MISSING}"}}}}`,
      ],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "codex",
      env: { SET: "t0ken" },
    });

    // ${SET} is substituted while building the entry, then ${MISSING} throws
    // and the whole server is dropped — nothing reached the wire, so the
    // exposure warning must not fire. A warning nobody can trust is worse than
    // no warning.
    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([
      'MCP server "s" from --mcp-config was skipped: ${MISSING} is not set in this agent\'s env.',
    ]);
  });

  it("still applies a ${VAR:-default} fallback decision without substituting a set value", async () => {
    const config = JSON.stringify({
      mcpServers: {
        a: { type: "http", url: "https://a.example/mcp", headers: { Authorization: "Bearer ${A:-anon}" } },
        b: { type: "http", url: "https://b.example/mcp", headers: { Authorization: "Bearer ${B:-anon}" } },
      },
    });
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/c.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { A: "secret" },
      readFile: readFileFrom({ "/etc/c.json": config }),
    });

    // Both mount: the child resolves ${A} from the same env we validated
    // against, and falls back to `anon` for the unset ${B} exactly as we would.
    expect(result.servers.map((server) => server.name)).toEqual(["a", "b"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("substitutes when the child expands against an env this process does not supply", async () => {
    const inline = JSON.stringify({
      mcpServers: {
        r: { type: "http", url: "https://r.example/mcp", headers: { Authorization: "Bearer ${VPS_MCP_TOKEN}" } },
      },
    });
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [`--mcp-config=${inline}`],
      cwd: "/work",
      childEnvIsForeign: true,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
      executionTargetIsRemote: true,
    });

    expect(result.servers).toEqual([
      {
        type: "http",
        name: "r",
        url: "https://r.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer t0ken" }],
      },
    ]);
    expect(result.warnings[0]).toContain("an env this process does not supply");
    expect(result.warnings[0]).toContain("${VPS_MCP_TOKEN}");
  });

  it("passes the placeholder through on a remote target that runs the child under our own env", async () => {
    const inline = JSON.stringify({
      mcpServers: {
        r: { type: "http", url: "https://r.example/mcp", headers: { Authorization: "Bearer ${VPS_MCP_TOKEN}" } },
      },
    });
    // The sandbox shape: remote enough that file-based configs stay unread
    // (their files live on the remote host), but the child is launched with the
    // env this process shipped it, so it resolves `${VAR}` itself exactly as a
    // local claude does. Substituting here would buy nothing and republish the
    // token into the sandbox child's argv.
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [`--mcp-config=${inline}`],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
      executionTargetIsRemote: true,
    });

    expect(result.servers).toEqual([
      {
        type: "http",
        name: "r",
        url: "https://r.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer ${VPS_MCP_TOKEN}" }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("t0ken");
    expect(result.warnings).toEqual([]);

    // The pass-through is claude's alone: the same target on a lane that does
    // not re-expand still substitutes, because there the literal would go on
    // the wire and earn a 401.
    const codex = await resolveExtraArgsMcpServers({
      extraArgs: [`--mcp-config=${inline}`],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "codex",
      env: { VPS_MCP_TOKEN: "t0ken" },
      executionTargetIsRemote: true,
    });
    expect(codex.servers[0]).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer t0ken" }],
    });
    expect(codex.warnings[0]).toContain('the "codex" agent does not expand');
  });

  it("names the config's own text in the identity, never the resolved credential", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [
        `--mcp-config={"mcpServers":{"s":{"command":"srv-\${VPS_MCP_TOKEN}","args":["--key","\${VPS_MCP_TOKEN}"]},"h":{"type":"http","url":"https://h.example/\${VPS_MCP_TOKEN}"}}}`,
      ],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "codex",
      env: { VPS_MCP_TOKEN: "t0ken" },
    });

    // "codex" substitutes, so the servers carry the resolved value — correct,
    // that is what makes them work. The identities must not follow: they travel
    // back to the host in `sessionParams` and into the config fingerprint, and
    // neither needs the value.
    expect(result.servers).toEqual([
      { name: "s", command: "srv-t0ken", args: ["--key", "t0ken"], env: [] },
      { type: "http", name: "h", url: "https://h.example/t0ken", headers: [] },
    ]);
    expect(result.identities).toEqual([
      {
        name: "s",
        url: "srv-${VPS_MCP_TOKEN} --key ${VPS_MCP_TOKEN}",
        connectionId: "adapter-config:extraArgs",
      },
      {
        name: "h",
        url: "https://h.example/${VPS_MCP_TOKEN}",
        connectionId: "adapter-config:extraArgs",
      },
    ]);
    expect(JSON.stringify(result.identities)).not.toContain("t0ken");
  });

  it("accepts --mcp-config=<path>, relative paths, and inline JSON", async () => {
    const inline = await resolveExtraArgsMcpServers({
      extraArgs: [`--mcp-config={"mcpServers":{"inline":{"command":"npx","args":["-y","srv"]}}}`],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: {},
    });
    expect(inline.servers).toEqual([{ name: "inline", command: "npx", args: ["-y", "srv"], env: [] }]);

    const relative = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config=cfg/mcp.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
      readFile: readFileFrom({ "/work/cfg/mcp.json": FLEET_CONFIG }),
    });
    expect(relative.servers.map((server) => server.name)).toEqual(["vps-mcp-figmenta"]);
  });

  it("skips a server whose placeholder has no value instead of mounting a broken credential", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: {},
      readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings).toEqual([
      'MCP server "vps-mcp-figmenta" from --mcp-config was skipped: ${VPS_MCP_TOKEN} is not set in this agent\'s env.',
    ]);
  });

  it("lets an already-mounted tool connection win the name and reports the collision", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
      reservedNames: ["vps-mcp-figmenta"],
      readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
    });

    expect(result.servers).toEqual([]);
    expect(result.warnings[0]).toContain("already mounted");
  });

  it("reports a missing file, an unreadable remote path, and CLI-only args instead of dropping them", async () => {
    const missing = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/gone.json", "--strict-mcp-config"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: {},
      readFile: readFileFrom({}),
    });
    expect(missing.warnings.join(" ")).toContain("--strict-mcp-config");
    expect(missing.warnings.join(" ")).toContain("/etc/gone.json");

    const remote = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: { VPS_MCP_TOKEN: "t0ken" },
      executionTargetIsRemote: true,
      readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
    });
    expect(remote.servers).toEqual([]);
    expect(remote.warnings[0]).toContain("remote execution targets");
  });

  it("returns nothing for extraArgs that carry no --mcp-config", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [],
      cwd: "/work",
      childEnvIsForeign: false,
      agent: "claude",
      env: {},
    });
    expect(result).toEqual({ servers: [], identities: [], warnings: [], honoredSources: [] });
  });
});
