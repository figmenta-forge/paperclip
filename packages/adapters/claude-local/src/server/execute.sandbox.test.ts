import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
});

import { execute } from "./execute.js";

describe("claude local process sandbox mounts", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("binds the agent instructions directory read-only under a workspace filesystem scope", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-sandbox-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const instructionsDir = path.join(rootDir, "instructions");
    const instructionsPath = path.join(instructionsDir, "AGENTS.md");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(instructionsDir, { recursive: true });
    await writeFile(instructionsPath, "Agent instructions.\n", "utf8");
    await writeFile(path.join(instructionsDir, "HEARTBEAT.md"), "Heartbeat procedure.\n", "utf8");

    await execute({
      runId: "run-sandbox-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        instructionsFilePath: instructionsPath,
        filesystemScope: "workspace",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      { localProcessSandbox?: { managedPaths?: { path: string; access: string }[] } | null },
    ];
    const managedPaths = call[3].localProcessSandbox?.managedPaths ?? [];
    // Identity files must be reachable, and read-only: agents must not edit them.
    expect(managedPaths).toContainEqual({ path: instructionsDir, access: "ro" });
  });
});
