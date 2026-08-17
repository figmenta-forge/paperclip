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
      env: { VPS_MCP_TOKEN: "t0ken" },
      readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
    });

    // The placeholder travels; the secret does not. Whatever we put here is
    // serialized into the child's argv, which every local uid can read.
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

  it("keeps a stdio server's args and env unresolved too", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [
        `--mcp-config={"mcpServers":{"s":{"command":"srv","args":["--key","\${VPS_MCP_TOKEN}"],"env":{"KEY":"\${VPS_MCP_TOKEN}"}}}}`,
      ],
      cwd: "/work",
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
    expect(JSON.stringify(result)).not.toContain("t0ken");
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
      env: { A: "secret" },
      readFile: readFileFrom({ "/etc/c.json": config }),
    });

    // Both mount: the child resolves ${A} from the same env we validated
    // against, and falls back to `anon` for the unset ${B} exactly as we would.
    expect(result.servers.map((server) => server.name)).toEqual(["a", "b"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("keeps substituting for a remote target, whose child env this process does not own", async () => {
    const inline = JSON.stringify({
      mcpServers: {
        r: { type: "http", url: "https://r.example/mcp", headers: { Authorization: "Bearer ${VPS_MCP_TOKEN}" } },
      },
    });
    const result = await resolveExtraArgsMcpServers({
      extraArgs: [`--mcp-config=${inline}`],
      cwd: "/work",
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
  });

  it("accepts --mcp-config=<path>, relative paths, and inline JSON", async () => {
    const inline = await resolveExtraArgsMcpServers({
      extraArgs: [`--mcp-config={"mcpServers":{"inline":{"command":"npx","args":["-y","srv"]}}}`],
      cwd: "/work",
      env: {},
    });
    expect(inline.servers).toEqual([{ name: "inline", command: "npx", args: ["-y", "srv"], env: [] }]);

    const relative = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config=cfg/mcp.json"],
      cwd: "/work",
      env: { VPS_MCP_TOKEN: "t0ken" },
      readFile: readFileFrom({ "/work/cfg/mcp.json": FLEET_CONFIG }),
    });
    expect(relative.servers.map((server) => server.name)).toEqual(["vps-mcp-figmenta"]);
  });

  it("skips a server whose placeholder has no value instead of mounting a broken credential", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
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
      env: {},
      readFile: readFileFrom({}),
    });
    expect(missing.warnings.join(" ")).toContain("--strict-mcp-config");
    expect(missing.warnings.join(" ")).toContain("/etc/gone.json");

    const remote = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
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
      env: {},
    });
    expect(result).toEqual({ servers: [], identities: [], warnings: [], honoredSources: [] });
  });
});
