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
  it("mounts an http server from a --mcp-config file and expands env placeholders", async () => {
    const result = await resolveExtraArgsMcpServers({
      extraArgs: ["--mcp-config", "/etc/fleet-mcp.json"],
      cwd: "/work",
      env: { VPS_MCP_TOKEN: "t0ken" },
      readFile: readFileFrom({ "/etc/fleet-mcp.json": FLEET_CONFIG }),
    });

    expect(result.servers).toEqual([
      {
        type: "http",
        name: "vps-mcp-figmenta",
        url: "https://vps-mcp.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer t0ken" }],
      },
    ]);
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
