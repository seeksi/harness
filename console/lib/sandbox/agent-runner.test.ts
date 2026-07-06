import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
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
import { HarnessTimeoutError } from "@/lib/bridge/errors";
import { mintLane, mintSession, _resetRegistry } from "@/lib/bridge/registry";
import { resetDb, listAudit } from "@/lib/server/persist";
import * as persist from "@/lib/server/persist";

// Worktrees allow-dir, derived the same way the sandbox does (cwd unchanged in tests).
const WT_BASE = path.resolve(process.cwd(), "..", `${path.basename(process.cwd())}.worktrees`);
const wt = (slug: string) => path.join(WT_BASE, slug);

beforeEach(() => {
  resetDb(":memory:");
  _resetRegistry();
  vi.unstubAllEnvs();
  // Direct mode now ALWAYS requires this opt-out (any NODE_ENV); default it ON so the
  // spawn/invocation tests that exercise direct-local mode run. The direct-mode gate
  // block below overrides it per-case to prove the fail-closed refusal.
  vi.stubEnv("AGENT_ALLOW_DIRECT", "1");
});

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { slug: "lane-x", worktreePath: wt("lane-x"), taskPrompt: "build the thing", ...over };
}

describe("buildAgentArgs / containedWorktree", () => {
  it("builds claude headless argv for a minted lane in its worktree (Bash in the default set)", () => {
    mintLane("lane-x");
    expect(buildAgentArgs(spec({ model: "opus" }))).toEqual([
      "-p",
      "build the thing",
      "--output-format",
      "json",
      "--model",
      "opus",
      "--allowedTools",
      "Read,Edit,Write,Grep,Glob,Bash",
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

  it("accepts Bash but rejects a bad model or anything outside the exact allowlist (no predicates/junk)", () => {
    mintLane("lane-x");
    // Bash IS in the allowlist now (direct-local posture) — accepted as a bare tool name.
    expect(() => buildAgentArgs(spec({ allowedTools: ["Bash"] }))).not.toThrow();
    expect(() => buildAgentArgs(spec({ allowedTools: DEFAULT_TOOLS }))).not.toThrow();
    expect(() => buildAgentArgs(spec({ model: "gpt" as never }))).toThrow(AgentExecError);
    // A Bash *predicate*, a command-injection attempt, a comma-joined string, or trailing
    // whitespace are all OUTSIDE the exact set → rejected.
    for (const bad of ["Edit; rm -rf /", "Bash(rm -rf /)", "Edit,Write", "Read ", "mcp__x"]) {
      expect(() => buildAgentArgs(spec({ allowedTools: [bad] })), bad).toThrow(AgentExecError);
    }
  });
});

describe("MCP lockdown REGRESSION (memory boundary — any loosening must fail loudly)", () => {
  // Load-bearing invariant: build agents get ZERO MCP. --strict-mcp-config with NO
  // --mcp-config means the agent can never reach memory-os (or any connector) — all
  // memory traffic stays orchestrator/daemon-side. Adding --mcp-config in ANY form
  // (separate element or --mcp-config=path) is a security regression.
  const mcpConfigForms = (args: string[]) => args.filter((a) => /^--mcp-config(=|$)/.test(a));

  it("buildAgentArgs ALWAYS emits --strict-mcp-config and NEVER any --mcp-config form", () => {
    mintLane("lane-x");
    const args = buildAgentArgs(spec());
    expect(args).toContain("--strict-mcp-config");
    expect(mcpConfigForms(args)).toEqual([]);
  });

  it("the lockdown holds at the actual spawn boundary (runAgentInSandbox argv)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"type":"result","subtype":"success","session_id":"sess-mcp0001"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", spawnFn: spawnFn as never });
    expect(capturedArgs).toContain("--strict-mcp-config");
    expect(mcpConfigForms(capturedArgs!)).toEqual([]);
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

describe("relocateTrace — DESTINATION containment (direct-mode agent can plant symlinks)", () => {
  // REPO_ROOT / WORKTREES_DIR are module-load constants from HARNESS_REPO, so drive the
  // whole boundary off a throwaway temp repo and re-import the module against it.
  let tmp: string;
  afterEach(() => {
    vi.resetModules();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Build a temp repo + lane worktree with a real trace, return the re-imported relocate
  // and the resolved dest paths. The lane/session are minted on the re-imported registry.
  async function setup(session = "sess-dest01") {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reloc-"));
    const repoRoot = path.join(tmp, "repo");
    const wtBase = path.join(tmp, "repo.worktrees", "lane-x");
    fs.mkdirSync(path.join(wtBase, ".claude", "traces"), { recursive: true });
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(wtBase, ".claude", "traces", `${session}.jsonl`), "NEW-TRACE\n");
    vi.stubEnv("HARNESS_REPO", repoRoot);
    vi.resetModules();
    const mod = await import("./agent-runner");
    const reg = await import("@/lib/bridge/registry");
    reg.mintLane("lane-x");
    reg.mintSession(session);
    const destDir = path.join(repoRoot, ".claude", "traces");
    return { relocate: mod.relocateTrace, AgentExecError: mod.AgentExecError, repoRoot, destDir, session };
  }

  it("copies the trace into the repo in the normal case", async () => {
    const { relocate, destDir, session } = await setup();
    expect(relocate("lane-x", session)).toBe(true);
    expect(fs.readFileSync(path.join(destDir, `${session}.jsonl`), "utf8")).toBe("NEW-TRACE\n");
  });

  it("overwrites a pre-existing REGULAR dest file (retry case)", async () => {
    const { relocate, destDir, session } = await setup();
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, `${session}.jsonl`), "OLD-TRACE\n");
    expect(relocate("lane-x", session)).toBe(true);
    expect(fs.readFileSync(path.join(destDir, `${session}.jsonl`), "utf8")).toBe("NEW-TRACE\n");
  });

  it("rejects when .claude/traces is a symlink pointing OUTSIDE the repo (no arbitrary-write via dir)", async () => {
    const { relocate, AgentExecError: Err, repoRoot, session } = await setup();
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".claude"), { recursive: true });
    fs.symlinkSync(outside, path.join(repoRoot, ".claude", "traces"));
    expect(() => relocate("lane-x", session)).toThrow(Err);
    // Nothing was written into the symlink target.
    expect(fs.existsSync(path.join(outside, `${session}.jsonl`))).toBe(false);
  });

  it("never writes THROUGH a dest session-file symlink — replaces the link atomically", async () => {
    const { relocate, destDir, session } = await setup();
    fs.mkdirSync(destDir, { recursive: true });
    const evilTarget = path.join(tmp, "evil-target");
    const destFile = path.join(destDir, `${session}.jsonl`);
    fs.symlinkSync(evilTarget, destFile);
    // Atomic rename replaces the symlink itself rather than throwing OR writing through it.
    expect(relocate("lane-x", session)).toBe(true);
    // The evil target was NEVER created/written (no write-through), and the dest is now a
    // real regular file (the link was replaced), holding the lane's own trace content.
    expect(fs.existsSync(evilTarget)).toBe(false);
    expect(fs.lstatSync(destFile).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(destFile).isFile()).toBe(true);
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

  it("runs claude directly as the daemon user when AGENT_USER is unset (dev/test default)", async () => {
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

describe("buildInvocation — direct-mode gate (AGENT_ALLOW_DIRECT, ANY NODE_ENV)", () => {
  // AGENT_USER unset ⇒ direct mode. Direct mode must be refused UNLESS AGENT_ALLOW_DIRECT=1
  // is set, REGARDLESS of NODE_ENV (a daemon without NODE_ENV=production must not silently
  // run direct+Bash). Drop mode (AGENT_USER set) is unaffected.
  afterEach(() => vi.resetModules());

  it("REFUSES direct mode without AGENT_ALLOW_DIRECT in ANY NODE_ENV (fail closed)", async () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      vi.stubEnv("AGENT_ALLOW_DIRECT", ""); // explicitly NOT "1" (override beforeEach default)
      vi.resetModules();
      const mod = await import("./agent-runner");
      expect(() => mod.buildInvocation("/abs/claude", ["-p", "x"]), nodeEnv).toThrow(mod.AgentExecError);
    }
  });

  it("ALLOWS direct mode when AGENT_ALLOW_DIRECT=1 (explicit greppable opt-out)", async () => {
    vi.stubEnv("NODE_ENV", "development"); // not production — still gated on the flag
    vi.stubEnv("AGENT_ALLOW_DIRECT", "1");
    vi.resetModules();
    const mod = await import("./agent-runner");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x"]);
    expect(inv.cmd).toBe("/abs/claude"); // direct — no sudo wrapper
    expect(inv.argv).toEqual(["-p", "x"]);
    expect(inv.spawnEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("drop mode (AGENT_USER set) is unaffected by the direct-mode gate → sudo argv", async () => {
    vi.stubEnv("AGENT_USER", "agent");
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.stubEnv("AGENT_ALLOW_DIRECT", ""); // no direct opt-out — but drop mode never needs it
    vi.resetModules();
    const mod = await import("./agent-runner");
    const inv = mod.buildInvocation("/abs/claude", ["-p", "x"]);
    expect(inv.cmd).toBe("/usr/bin/sudo");
    expect(inv.argv).toEqual(["-n", "-H", "-u", "agent", "--", "/abs/claude", "-p", "x"]);
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
    expect(listAudit().map((r) => r.outcome)).toEqual(["refused"]);
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

    const log = listAudit();
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
    const spawnFn = fakeSpawn(['{"type":"result","session_id":"evil id with spaces & \\n newline"}']);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBeNull(); // in a real result envelope but fails the strict session shape
    expect(listAudit()[0].argv).toContain("session:?");
  });

  it("rejects a bare {session_id} object that is NOT claude's result envelope (type:result required)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    // Well-formed, strict-shape session id but NO type:"result" — a forged/non-envelope
    // stdout object must not have its session id trusted. Fail closed → null.
    const spawnFn = fakeSpawn([JSON.stringify({ session_id: "sess-bare01" })]);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBeNull();
    // A non-result envelope with a wrong type value is likewise rejected.
    const res2 = await spawnAgent(spec(), {
      spawnFn: fakeSpawn([JSON.stringify({ type: "assistant", session_id: "sess-bare02" })]) as never,
    });
    expect(res2.sessionId).toBeNull();
  });

  it("parses the session id from the top-level JSON result object (valid shape accepted)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = fakeSpawn([
      JSON.stringify({ type: "result", subtype: "success", session_id: "sess-real01", result: "ok" }),
    ]);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBe("sess-real01");
  });

  it("does NOT pick up a fake session_id embedded in surrounding non-result text (non-spoofable)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    // The whole stdout is NOT a single JSON result object — a legacy regex-over-all-stdout
    // would have grabbed the embedded "session_id":"sess-fake99". JSON.parse of the whole
    // blob fails → null (fails the run closed in the daemon when the agent ran).
    const spawnFn = fakeSpawn(['garbage {"session_id":"sess-fake99"} trailing tool output']);
    const res = await spawnAgent(spec(), { spawnFn: spawnFn as never });
    expect(res.sessionId).toBeNull();
  });

  it("returns a null session on oversized / bad-shape / wrong-type session_id (fail closed)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    // Oversized (> 64 chars) → shape mismatch → null (in a real result envelope).
    let res = await spawnAgent(spec(), {
      spawnFn: fakeSpawn([JSON.stringify({ type: "result", session_id: "x".repeat(65) })]) as never,
    });
    expect(res.sessionId).toBeNull();
    // Wrong type (number, not string) → null.
    res = await spawnAgent(spec(), { spawnFn: fakeSpawn([JSON.stringify({ type: "result", session_id: 12345 })]) as never });
    expect(res.sessionId).toBeNull();
    // Unparseable stdout → null.
    res = await spawnAgent(spec(), { spawnFn: fakeSpawn(["not json at all {"]) as never });
    expect(res.sessionId).toBeNull();
  });

  it("fails closed when the mandatory pre-spawn audit cannot be written (never spawns)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const spawnFn = vi.fn();
    const spy = vi.spyOn(persist, "appendAudit").mockImplementation(() => {
      throw new Error("audit sink down");
    });
    await expect(spawnAgent(spec(), { spawnFn: spawnFn as never })).rejects.toThrow("audit sink down");
    expect(spawnFn).not.toHaveBeenCalled(); // no unaudited agent run
    spy.mockRestore();
  });

  it("threads spec.user to the sudo -u privilege drop (per-lane uid)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    vi.stubEnv("AGENT_USER", "agent");
    vi.stubEnv("AGENT_CLI_PATH", "/abs/claude"); // absolute cli required in drop mode
    vi.stubEnv("AGENT_PATH", "/usr/bin:/bin");
    vi.resetModules();
    const mod = await import("./agent-runner");
    (await import("@/lib/bridge/registry")).mintLane("lane-x");
    let capturedCmd: string | undefined;
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((cmd: string, args: string[]) => {
      capturedCmd = cmd;
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"type":"result","subtype":"success","session_id":"sess-lane001"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await mod.spawnAgent(
      { slug: "lane-x", worktreePath: wt("lane-x"), taskPrompt: "x", user: "agent-1" },
      { spawnFn: spawnFn as never }
    );
    expect(capturedCmd).toBe("/usr/bin/sudo");
    expect(capturedArgs!.slice(0, 4)).toEqual(["-n", "-H", "-u", "agent-1"]); // lane-1's uid
    vi.resetModules();
  });

  it("kills a hung agent's PROCESS GROUP (SIGTERM→SIGKILL on -pid) and rejects HarnessTimeoutError", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    const PID = 4242;
    let child: (EventEmitter & { stdout: Readable; pid: number }) | undefined;
    // The child HAS a numeric pid → killTree must target the whole group via process.kill(-pid).
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string) => {
      if (sig === "SIGKILL") setImmediate(() => child!.emit("close", null));
      return true;
    }) as never);
    const spawnFn = vi.fn(() => {
      child = new EventEmitter() as EventEmitter & { stdout: Readable; pid: number };
      child.stdout = new Readable({ read() {} }); // never ends
      child.pid = PID;
      return child as unknown as ChildProcess;
    });

    await expect(
      spawnAgent(spec(), { spawnFn: spawnFn as never, timeoutMs: 20, killGraceMs: 5 })
    ).rejects.toBeInstanceOf(HarnessTimeoutError);
    // The negative pid (process GROUP), SIGTERM then SIGKILL — not the child.kill() fallback.
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGKILL");
    // Both the mandatory pre-spawn "spawn" row and the settle-time "timeout" row exist (DESC).
    expect(listAudit().map((r) => r.outcome)).toEqual(["timeout", "spawn"]);
    killSpy.mockRestore();
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
    expect(listAudit().map((r) => r.outcome)).toEqual(["refused"]);
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

  it("defaults allowedTools to DEFAULT_TOOLS (Bash INCLUDED) and rejects an unknown tool", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"type":"result","subtype":"success","session_id":"sess-tools01"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", spawnFn: spawnFn as never });
    const i = capturedArgs!.indexOf("--allowedTools");
    expect(capturedArgs![i + 1]).toBe("Read,Edit,Write,Grep,Glob,Bash");
    expect(capturedArgs![i + 1]).toContain("Bash"); // deliberately enabled for direct-local
    // A tool OUTSIDE the exact allowlist is rejected before any spawn.
    await expect(
      runAgentInSandbox({ prompt: "x", cwd: wt("lane-x"), sessionId: "lane-x", allowedTools: ["WebFetch"], spawnFn: spawnFn as never })
    ).rejects.toBeInstanceOf(AgentExecError);
  });

  it("threads resourceLimits all the way to the spawned child env (SANDBOX_* set)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    mintLane("lane-x");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnFn = vi.fn((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      capturedEnv = options.env;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"type":"result","subtype":"success","session_id":"sess-lim001"}\n']);
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
  it("DEFAULT_TOOLS is the exported allowlist and INCLUDES Bash (direct-local posture)", () => {
    expect(DEFAULT_TOOLS).toEqual(["Read", "Edit", "Write", "Grep", "Glob", "Bash"]);
    expect(DEFAULT_TOOLS).toContain("Bash");
  });
});
