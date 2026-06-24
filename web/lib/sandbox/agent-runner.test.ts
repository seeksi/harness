// web/lib/sandbox/agent-runner.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import path from "path";
import {
  buildAgentArgs,
  buildInvocation,
  spawnAgent,
  runAgentInSandbox,
  containedWorktree,
  relocateTrace,
  parseAgentUsage,
  validateLimits,
  DEFAULT_TOOLS,
  AgentExecError,
  type AgentSpec,
} from "./agent-runner";
import { HarnessTimeoutError } from "@/lib/daemon/errors";
import { mintLane, mintSession, _resetRegistry } from "@/lib/daemon/registry";
import { resetDb, getAuditLog } from "@/lib/store/persist";

// Worktrees allow-dir, derived the same way the sandbox does (cwd unchanged in tests).
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
      "--strict-mcp-config",
    ]);
  });

  it("passes --strict-mcp-config to isolate the agent from inherited MCP servers", () => {
    mintLane("lane-x");
    // No --mcp-config is ever passed, so --strict-mcp-config => zero MCP servers loaded.
    const args = buildAgentArgs(spec());
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
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

describe("laneUser — per-lane OS user resolution (single source of truth)", () => {
  // laneUser reads BASE_AGENT_USER at module load, so re-import with env set.
  afterEach(() => vi.resetModules());

  it("returns undefined when AGENT_USER is unset (dev/test direct mode)", async () => {
    vi.resetModules();
    const mod = await import("./agent-runner");
    expect(mod.laneUser(0)).toBeUndefined();
    expect(mod.laneUser(3)).toBeUndefined();
  });

  it("maps index 0 → the base user (agent) and i>0 → base-i (agent-1, agent-2…)", async () => {
    vi.stubEnv("AGENT_USER", "agent");
    vi.resetModules();
    const mod = await import("./agent-runner");
    expect(mod.laneUser(0)).toBe("agent"); // index 0 is byte-identical to single-lane today
    expect(mod.laneUser(1)).toBe("agent-1");
    expect(mod.laneUser(2)).toBe("agent-2");
  });

  it("re-validates the resolved name (not root, not the daemon user, username shape)", async () => {
    const me = (await import("os")).userInfo().username;
    // base = root → index 0 is root → rejected.
    vi.stubEnv("AGENT_USER", "root");
    vi.resetModules();
    let mod = await import("./agent-runner");
    expect(() => mod.laneUser(0)).toThrow(mod.AgentExecError);
    // base = the daemon's own user → no privilege drop → rejected.
    vi.stubEnv("AGENT_USER", me);
    vi.resetModules();
    mod = await import("./agent-runner");
    expect(() => mod.laneUser(0)).toThrow(mod.AgentExecError);
  });

  it("rejects a non-integer / negative lane index (fail closed)", async () => {
    vi.stubEnv("AGENT_USER", "agent");
    vi.resetModules();
    const mod = await import("./agent-runner");
    expect(() => mod.laneUser(-1)).toThrow(mod.AgentExecError);
    expect(() => mod.laneUser(1.5)).toThrow(mod.AgentExecError);
  });
});

describe("buildInvocation — privilege drop (AGENT_USER)", () => {
  // AGENT_USER is read at module load (a fixed boundary), so re-import with env set.
  afterEach(() => vi.resetModules());

  it("runs claude directly as the daemon user when AGENT_USER is unset (default)", async () => {
    vi.resetModules();
    const mod = await import("./agent-runner");
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
    const mod = await import("./agent-runner");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x", "--model", "sonnet"]);
    expect(inv.cmd).toBe("/usr/bin/sudo");
    // argv0 after `--` is the claude binary itself → sudoers can scope to exactly it.
    expect(inv.argv).toEqual(["-n", "-H", "-u", "agent", "--", "/abs/claude", "-p", "x", "--model", "sonnet"]);
    // sudo only needs PATH; no daemon env (and thus no secret) rides through spawnEnv.
    expect(Object.keys(inv.spawnEnv)).toEqual(["PATH"]);
    expect(inv.spawnEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("uses the explicit per-lane `user` param over AGENT_USER for the sudo -u drop", async () => {
    vi.stubEnv("AGENT_USER", "agent"); // base / index-0 user
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.resetModules();
    const mod = await import("./agent-runner");
    // A lane-1 invocation drops to agent-1, not the base agent.
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x"], undefined, "agent-1");
    expect(inv.argv).toEqual(["-n", "-H", "-u", "agent-1", "--", "/abs/claude", "-p", "x"]);
    // Omitting the param falls back to AGENT_USER (single-lane byte-identical).
    const inv0 = mod.buildInvocation("/abs/claude", ["-p", "x"]);
    expect(inv0.argv).toEqual(["-n", "-H", "-u", "agent", "--", "/abs/claude", "-p", "x"]);
  });

  it("rejects a non-username AGENT_USER (argv-injection guard)", async () => {
    vi.stubEnv("AGENT_USER", "agent; rm -rf /");
    vi.resetModules();
    const mod = await import("./agent-runner");
    expect(() => mod.buildInvocation("/abs/claude", ["-p", "x"])).toThrow(mod.AgentExecError);
  });

  it("rejects root, the daemon's own user, and a relative cli (no real privilege drop / PATH hijack)", async () => {
    const me = (await import("os")).userInfo().username;
    for (const [user, cli] of [["root", "/abs/claude"], [me, "/abs/claude"], ["agent", "claude"]] as const) {
      vi.stubEnv("AGENT_USER", user);
      vi.resetModules();
      const mod = await import("./agent-runner");
      expect(() => mod.buildInvocation(cli, ["-p", "x"]), `${user} ${cli}`).toThrow(mod.AgentExecError);
    }
  });
});

describe("buildInvocation — resourceLimits plumbing (SANDBOX_* env)", () => {
  afterEach(() => vi.resetModules());

  it("emits only the set SANDBOX_* vars in direct mode and leaves argv unchanged", () => {
    const inv = buildInvocation("/abs/claude", ["-p", "x"], { memoryMax: "2G", tasksMax: 64, cpuQuota: "200%", cpuSeconds: 600 });
    expect(inv.argv).toEqual(["-p", "x"]); // resource limits never touch the claude argv
    expect(inv.spawnEnv.SANDBOX_MEM_MAX).toBe("2G");
    expect(inv.spawnEnv.SANDBOX_TASKS_MAX).toBe("64");
    expect(inv.spawnEnv.SANDBOX_CPU_QUOTA).toBe("200%");
    expect(inv.spawnEnv.SANDBOX_CPU_SECONDS).toBe("600");
  });

  it("forwards SANDBOX_* through sudo via --preserve-env in drop mode", async () => {
    vi.stubEnv("AGENT_USER", "agent");
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.resetModules();
    const mod = await import("./agent-runner");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x"], { memoryMax: "2G" });
    expect(inv.argv).toEqual(["-n", "-H", "--preserve-env=SANDBOX_MEM_MAX", "-u", "agent", "--", "/abs/claude", "-p", "x"]);
    expect(inv.spawnEnv.SANDBOX_MEM_MAX).toBe("2G");
  });

  it("does not alter argv or env when no resourceLimits are passed (no behavior change)", () => {
    const inv = buildInvocation("/abs/claude", ["-p", "x"]);
    expect(inv.argv).toEqual(["-p", "x"]);
    expect(inv.spawnEnv).not.toHaveProperty("SANDBOX_MEM_MAX");
  });

  it("forwards a FULL valid limit set (all four SANDBOX_* keys) via --preserve-env in drop mode", async () => {
    vi.stubEnv("AGENT_USER", "agent");
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.resetModules();
    const mod = await import("./agent-runner");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x"], {
      memoryMax: "2G", tasksMax: 64, cpuQuota: "200%", cpuSeconds: 600,
    });
    expect(inv.argv).toEqual([
      "-n", "-H", "--preserve-env=SANDBOX_MEM_MAX,SANDBOX_TASKS_MAX,SANDBOX_CPU_QUOTA,SANDBOX_CPU_SECONDS",
      "-u", "agent", "--", "/abs/claude", "-p", "x",
    ]);
    expect(inv.spawnEnv).toMatchObject({
      SANDBOX_MEM_MAX: "2G", SANDBOX_TASKS_MAX: "64", SANDBOX_CPU_QUOTA: "200%", SANDBOX_CPU_SECONDS: "600",
    });
  });
});

describe("validateLimits — fail-closed against injection / out-of-bounds", () => {
  it("accepts a valid, canonicalized set", () => {
    expect(validateLimits({ memoryMax: "1500M", tasksMax: 64, cpuQuota: "200%", cpuSeconds: 600, wallMs: 60000 })).toEqual({
      memoryMax: "1500M", tasksMax: 64, cpuQuota: "200%", cpuSeconds: 600, wallMs: 60000,
    });
    expect(validateLimits({ memoryMax: "50%" })).toEqual({ memoryMax: "50%" }); // percentage form
  });

  it("REJECTS a shell-injection attempt in memoryMax/cpuQuota (never passed onward)", () => {
    for (const bad of ["1500M; rm -rf /", "$(reboot)", "`id`", "2G && curl evil", "1500 M", "2GB", ""]) {
      expect(() => validateLimits({ memoryMax: bad }), bad).toThrow(AgentExecError);
    }
    for (const bad of ["200%; rm -rf /", "200", "$(x)%", "-50%"]) {
      expect(() => validateLimits({ cpuQuota: bad }), bad).toThrow(AgentExecError);
    }
  });

  it("REJECTS out-of-bounds / non-integer numeric limits (fail closed)", () => {
    expect(() => validateLimits({ tasksMax: 99999 })).toThrow(AgentExecError); // > MAX_TASKS
    expect(() => validateLimits({ cpuSeconds: 99999 })).toThrow(AgentExecError); // > 1h
    expect(() => validateLimits({ wallMs: 999_999_999 })).toThrow(AgentExecError); // > 1h
    expect(() => validateLimits({ tasksMax: 0 })).toThrow(AgentExecError);
    expect(() => validateLimits({ tasksMax: -5 })).toThrow(AgentExecError);
    expect(() => validateLimits({ cpuSeconds: 1.5 as number })).toThrow(AgentExecError);
    expect(() => validateLimits({ tasksMax: "64" as never })).toThrow(AgentExecError); // string, not int
  });

  it("an injected memoryMax never reaches the spawn env (buildInvocation throws before env is built)", () => {
    expect(() => buildInvocation("/abs/claude", ["-p", "x"], { memoryMax: "2G; rm -rf /" })).toThrow(AgentExecError);
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
    // No usage/modelUsage in this result → usage is null (no event will be emitted).
    expect(res).toEqual({ code: 0, sessionId: "sess-abc123", usage: null });

    // Minimal env allowlist — no secret propagates, full server env not forwarded.
    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(capturedEnv!.PATH).toBeTruthy();
    expect(capturedShell).toBe(false);

    const log = getAuditLog();
    expect(log[0].argv).toEqual(["lane:lane-x", "model:sonnet", "session:sess-abc123"]);
    expect(JSON.stringify(log[0])).not.toContain("TOPSECRET"); // prompt never audited
  });

  it("extracts usage/cost/context from the result JSON it already reads", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = fakeSpawn([
      JSON.stringify({
        type: "result",
        subtype: "success",
        total_cost_usd: 0.1129,
        usage: { input_tokens: 5, output_tokens: 398, cache_read_input_tokens: 97328, cache_creation_input_tokens: 12841 },
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 5, outputTokens: 398, cacheReadInputTokens: 97328,
            cacheCreationInputTokens: 12841, contextWindow: 200000, costUSD: 0.1122,
          },
        },
        session_id: "sess-abc123",
      }),
    ]);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBe("sess-abc123");
    expect(res.usage).toMatchObject({ model: "claude-sonnet-4-6", contextWindow: 200000, costUsd: 0.1122 });
  });

  it("rejects a child-controlled / malformed session id (no audit forgery)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = fakeSpawn(['{"session_id":"evil id with spaces & \\n newline"}']);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBeNull(); // didn't match the strict session shape
    expect(getAuditLog()[0].argv).toContain("session:?");
  });

  it("threads spec.user to the sudo -u privilege drop (per-lane uid)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    vi.stubEnv("AGENT_USER", "agent");
    vi.stubEnv("AGENT_CLI_PATH", "/abs/claude"); // absolute cli required in drop mode
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.resetModules();
    const mod = await import("./agent-runner");
    (await import("@/lib/daemon/registry")).mintLane("lane-x");
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"session_id":"sess-lane001"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await mod.spawnAgent(
      { slug: "lane-x", worktreePath: wt("lane-x"), taskPrompt: "x", user: "agent-1" },
      { spawnFn: spawnFn as never }
    );
    expect(capturedCmd).toBe("/usr/bin/sudo");
    expect(capturedArgs!.slice(0, 4)).toEqual(["-n", "-H", "-u", "agent-1"]); // lane-1's uid
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

describe("runAgentInSandbox — public entrypoint", () => {
  it("REFUSES (gate) and never spawns when ENABLE_AGENT_EXEC is unset", async () => {
    mintLane("lane-x");
    const spawnFn = vi.fn();
    await expect(
      runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", spawnFn: spawnFn as never })
    ).rejects.toBeInstanceOf(AgentExecError);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(getAuditLog().map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("runs, returns {exitCode, sessionId, usage, audit}, and the audit carries no prompt", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = fakeSpawn(['{"type":"result","subtype":"success","session_id":"sess-pub123","result":"ok"}']);
    const res = await runAgentInSandbox({
      prompt: "do TOPSECRET work",
      cwd: wt("lane-x"),
      sessionId: "lane-x",
      model: "opus",
      spawnFn: spawnFn as never,
    });
    expect(res.exitCode).toBe(0);
    expect(res.sessionId).toBe("sess-pub123");
    expect(res.usage).toBeNull();
    expect(res.audit.argv).toEqual(["lane:lane-x", "model:opus", "session:sess-pub123"]);
    expect(JSON.stringify(res.audit)).not.toContain("TOPSECRET");
  });

  it("defaults allowedTools to DEFAULT_TOOLS and keeps Bash unreachable", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"session_id":"sess-tools01"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", spawnFn: spawnFn as never });
    const i = capturedArgs!.indexOf("--allowedTools");
    expect(capturedArgs![i + 1]).toBe("Read,Edit,Write,Grep,Glob");
    expect(capturedArgs![i + 1]).not.toContain("Bash");
    // A Bash tool request is rejected before any spawn.
    await expect(
      runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", allowedTools: ["Bash"], spawnFn: spawnFn as never })
    ).rejects.toBeInstanceOf(AgentExecError);
  });

  it("threads resourceLimits all the way to the spawned child env (SANDBOX_* set)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnFn = vi.fn((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"session_id":"sess-lim001"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await runAgentInSandbox({
      prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x",
      resourceLimits: { memoryMax: "2G", tasksMax: 64, cpuQuota: "200%", cpuSeconds: 600 },
      spawnFn: spawnFn as never,
    });
    expect(capturedEnv).toMatchObject({
      SANDBOX_MEM_MAX: "2G", SANDBOX_TASKS_MAX: "64", SANDBOX_CPU_QUOTA: "200%", SANDBOX_CPU_SECONDS: "600",
    });
  });

  it("rejects an injected resourceLimit (fail closed) before spawning", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = vi.fn();
    await expect(
      runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", resourceLimits: { memoryMax: "2G; rm -rf /" }, spawnFn: spawnFn as never })
    ).rejects.toBeInstanceOf(AgentExecError);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("parseAgentUsage", () => {
  // The real --output-format json result shape from a live run.
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.1129,
    usage: { input_tokens: 5, output_tokens: 398, cache_read_input_tokens: 97328, cache_creation_input_tokens: 12841 },
    modelUsage: {
      "claude-sonnet-4-6": {
        inputTokens: 5, outputTokens: 398, cacheReadInputTokens: 97328,
        cacheCreationInputTokens: 12841, contextWindow: 200000, maxOutputTokens: 32000, costUSD: 0.1122,
      },
    },
    session_id: "abc",
    num_turns: 4,
  });

  it("prefers modelUsage (model + contextWindow + per-model costUSD)", () => {
    expect(parseAgentUsage(result)).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 5,
      outputTokens: 398,
      cacheReadTokens: 97328,
      cacheCreationTokens: 12841,
      contextWindow: 200000,
      costUsd: 0.1122,
    });
  });

  it("falls back to top-level usage + total_cost_usd when modelUsage is absent", () => {
    const noModel = JSON.stringify({
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
      total_cost_usd: 0.5,
    });
    expect(parseAgentUsage(noModel)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 1,
      cacheCreationTokens: 2,
      contextWindow: 0,
      costUsd: 0.5,
    });
  });

  it("returns null on parse failure / no usage shape (failed agent) — never throws", () => {
    expect(parseAgentUsage("not json {")).toBeNull();
    expect(parseAgentUsage("")).toBeNull();
    expect(parseAgentUsage(JSON.stringify({ type: "result", subtype: "error" }))).toBeNull();
  });
});

describe("capability constants (capabilities route source of truth)", () => {
  it("DEFAULT_TOOLS is the exported allowlist (no Bash)", () => {
    expect(DEFAULT_TOOLS).toEqual(["Read", "Edit", "Write", "Grep", "Glob"]);
    expect(DEFAULT_TOOLS).not.toContain("Bash");
  });
});
