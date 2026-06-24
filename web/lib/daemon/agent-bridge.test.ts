// web/lib/daemon/agent-bridge.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import path from "path";
import {
  buildAgentArgs,
  spawnAgent,
  containedWorktree,
  relocateTrace,
  AgentExecError,
  type AgentSpec,
} from "./agent-bridge";
import { HarnessTimeoutError } from "./errors";
import { mintLane, mintSession, _resetRegistry } from "./registry";
import { resetDb, getAuditLog } from "@/lib/store/persist";

// Worktrees allow-dir, derived the same way agent-bridge does (cwd unchanged in tests).
const WT_BASE = path.resolve(process.cwd(), "..", `${path.basename(process.cwd())}.worktrees`);
const wt = (slug: string) => path.join(WT_BASE, slug);

beforeEach(() => {
  resetDb(":memory:");
  _resetRegistry();
  vi.unstubAllEnvs();
});

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { slug: "lane-x", worktreePath: wt("lane-x"), taskPrompt: "build the thing", ...over };
}

describe("buildAgentArgs / containedWorktree", () => {
  it("builds claude headless argv for a minted lane in its worktree", () => {
    mintLane("lane-x");
    expect(buildAgentArgs(spec({ model: "opus" }))).toEqual([
      "-p",
      "build the thing",
      "--output-format",
      "json",
      "--model",
      "opus",
      "--allowedTools",
      "Read,Edit,Write,Grep,Glob",
    ]);
  });

  it("rejects an unminted lane (provenance)", () => {
    expect(() => buildAgentArgs(spec())).toThrow(AgentExecError); // lane-x not minted
  });

  it("rejects a worktree path that escapes the allow-dir (containment)", () => {
    mintLane("lane-x");
    expect(() => containedWorktree("lane-x", "/etc/passwd")).toThrow(AgentExecError);
    expect(() => containedWorktree("lane-x", wt("lane-x") + "/../../etc")).toThrow(AgentExecError);
    expect(() => buildAgentArgs(spec({ worktreePath: "/tmp/evil" }))).toThrow(AgentExecError);
  });

  it("rejects a bad model or any tool outside the exact allowlist (no Bash/predicates)", () => {
    mintLane("lane-x");
    expect(() => buildAgentArgs(spec({ model: "gpt" as never }))).toThrow(AgentExecError);
    for (const bad of ["Edit; rm -rf /", "Bash(rm -rf /)", "Bash", "Edit,Write", "Read "]) {
      expect(() => buildAgentArgs(spec({ allowedTools: [bad] })), bad).toThrow(AgentExecError);
    }
  });
});

describe("relocateTrace", () => {
  it("rejects an unminted lane (provenance) before touching the filesystem", () => {
    mintSession("sess-abc123");
    expect(() => relocateTrace("lane-x", "sess-abc123")).toThrow(AgentExecError); // lane not minted
  });

  it("rejects an unminted / path-shaped session id (provenance + path-safety)", () => {
    mintLane("lane-x");
    for (const bad of ["sess-not-minted", "../../etc/passwd", "a/b", "a.b", "", "x".repeat(65)]) {
      expect(() => relocateTrace("lane-x", bad), bad).toThrow(AgentExecError);
    }
  });

  it("returns false when the agent produced no trace (nothing to relocate)", () => {
    mintLane("lane-x");
    mintSession("sess-none123");
    // No worktree/trace exists for this lane → existsSync is false → no copy, no throw.
    expect(relocateTrace("lane-x", "sess-none123")).toBe(false);
  });
});

describe("buildInvocation — privilege drop (AGENT_USER)", () => {
  // AGENT_USER is read at module load (a fixed boundary), so re-import with env set.
  afterEach(() => vi.resetModules());

  it("runs claude directly as the daemon user when AGENT_USER is unset (default)", async () => {
    vi.resetModules();
    const mod = await import("./agent-bridge");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x"]);
    expect(inv.cmd).toBe("/abs/claude");
    expect(inv.argv).toEqual(["-p", "x"]);
    expect(inv.spawnEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("wraps in `sudo -n -H -u <user> -- <abs-claude> …` when AGENT_USER is set (claude is argv0)", async () => {
    vi.stubEnv("AGENT_USER", "agent");
    vi.stubEnv("AGENT_SUDO_PATH", "/usr/bin/sudo");
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.resetModules();
    const mod = await import("./agent-bridge");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x", "--model", "sonnet"]);
    expect(inv.cmd).toBe("/usr/bin/sudo");
    // argv0 after `--` is the claude binary itself → sudoers can scope to exactly it.
    expect(inv.argv).toEqual(["-n", "-H", "-u", "agent", "--", "/abs/claude", "-p", "x", "--model", "sonnet"]);
    // sudo only needs PATH; no daemon env (and thus no secret) rides through spawnEnv.
    expect(Object.keys(inv.spawnEnv)).toEqual(["PATH"]);
    expect(inv.spawnEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("rejects a non-username AGENT_USER (argv-injection guard)", async () => {
    vi.stubEnv("AGENT_USER", "agent; rm -rf /");
    vi.resetModules();
    const mod = await import("./agent-bridge");
    expect(() => mod.buildInvocation("/abs/claude", ["-p", "x"])).toThrow(mod.AgentExecError);
  });

  it("rejects root, the daemon's own user, and a relative cli (no real privilege drop / PATH hijack)", async () => {
    const me = (await import("os")).userInfo().username;
    for (const [user, cli] of [["root", "/abs/claude"], [me, "/abs/claude"], ["agent", "claude"]] as const) {
      vi.stubEnv("AGENT_USER", user);
      vi.resetModules();
      const mod = await import("./agent-bridge");
      expect(() => mod.buildInvocation(cli, ["-p", "x"]), `${user} ${cli}`).toThrow(mod.AgentExecError);
    }
  });
});

/** Fake claude child emitting `lines` on stdout then closing with `code`. */
function fakeSpawn(lines: string[], code = 0) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable };
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stdout.on("end", () => child.emit("close", code));
    return child as unknown as ChildProcess;
  });
}

describe("spawnAgent", () => {
  it("REFUSES to spawn unless ENABLE_AGENT_EXEC=1 (default-off gate)", async () => {
    mintLane("lane-x");
    const spawnFn = vi.fn();
    await expect(spawnAgent(spec(), { spawnFn: spawnFn as never })).rejects.toBeInstanceOf(AgentExecError);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(getAuditLog().map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("runs the agent with a minimal env (no secrets), captures the session id, audits without the prompt", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-should-not-propagate");
    mintLane("lane-x");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedShell: boolean | undefined;
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv; shell?: boolean }) => {
        capturedEnv = options.env;
        capturedShell = options.shell;
        const child = new EventEmitter() as EventEmitter & { stdout: Readable };
        child.stdout = Readable.from([
          '{"type":"result","subtype":"success","session_id":"sess-abc123","result":"ok"}\n',
        ]);
        child.stdout.on("end", () => child.emit("close", 0));
        return child as unknown as ChildProcess;
      }
    );

    const res = await spawnAgent(spec({ taskPrompt: "do TOPSECRET work" }), { spawnFn: spawnFn as never });
    expect(res).toEqual({ code: 0, sessionId: "sess-abc123" });

    // Minimal env allowlist — no secret propagates, full server env not forwarded.
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(capturedEnv!.PATH).toBeTruthy();
    expect(capturedShell).toBe(false);

    const log = getAuditLog();
    expect(log[0].argv).toEqual(["lane:lane-x", "model:sonnet", "session:sess-abc123"]);
    expect(JSON.stringify(log[0])).not.toContain("TOPSECRET"); // prompt never audited
  });

  it("rejects a child-controlled / malformed session id (no audit forgery)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = fakeSpawn(['{"session_id":"evil id with spaces & \\n newline"}']);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBeNull(); // didn't match the strict session shape
    expect(getAuditLog()[0].argv).toContain("session:?");
  });

  it("kills a hung agent and rejects HarnessTimeoutError", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    let child: (EventEmitter & { stdout: Readable; kill: ReturnType<typeof vi.fn> }) | undefined;
    const kill = vi.fn((sig: string) => {
      if (sig === "SIGKILL") setImmediate(() => child!.emit("close", null));
    });
    const spawnFn = vi.fn(() => {
      child = new EventEmitter() as EventEmitter & { stdout: Readable; kill: typeof kill };
      child.stdout = new Readable({ read() {} }); // never ends
      child.kill = kill;
      return child as unknown as ChildProcess;
    });

    await expect(
      spawnAgent(spec(), { spawnFn: spawnFn as never, timeoutMs: 20, killGraceMs: 5 })
    ).rejects.toBeInstanceOf(HarnessTimeoutError);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(getAuditLog().map((r) => r.outcome)).toEqual(["timeout"]);
  });
});
