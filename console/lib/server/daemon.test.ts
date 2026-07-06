import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { startRun, planRun, buildAgentPrompt, currentSlot, _resetSlot, SlotTakenError, type RunAgentFn } from "./daemon";
import { resetDb, eventsSince, listAudit, getSnapshot } from "./persist";
import { subscribe, _resetBroker } from "./broker";
import { _resetRegistry } from "@/lib/bridge/registry";
import type { Envelope } from "@/lib/contract/events";

const OLD_ENV = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = "test";
  resetDb(":memory:");
  _resetBroker();
  _resetRegistry();
  _resetSlot();
});
afterEach(() => {
  process.env.NODE_ENV = OLD_ENV;
  delete process.env.ENABLE_AGENT_EXEC;
  vi.restoreAllMocks();
});

// Fake harness child: emits JSON lines for `cmd`, then closes 0.
function fakeSpawn(byCmd: Record<string, string[]>) {
  return vi.fn((_script: string, args: string[], opts: Record<string, unknown>) => {
    expect(opts.shell).toBe(false);
    const lines = byCmd[args[0]] ?? [];
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean };
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stderr = Readable.from([]);
    child.pid = 999;
    child.kill = () => true;
    child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
    return child as never;
  });
}

// Wait until the async producer settles (slot released).
async function waitForSlotFree(timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (currentSlot() !== null) {
    if (Date.now() - t0 > timeoutMs) throw new Error("slot never released");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("planRun — provenance derived from the server runId, never the brief", () => {
  it("derives a shape-valid slug + plan file deterministically from runId", () => {
    const a = planRun("run-aaaa", "auto");
    const b = planRun("run-aaaa", "opus");
    expect(a.slug).toMatch(/^lane-[0-9a-f]{16}$/);
    expect(a.planFile).toMatch(/^plan-[0-9a-f]{16}\.jsonl$/);
    expect(a.slug).toBe(b.slug); // same runId → same provenance
    expect(a.model).toBe("sonnet");
    expect(b.model).toBe("opus");
  });
});

describe("startRun — live spawn pipeline: persist + broadcast + slot", () => {
  it("streams harness events through persist.appendEvent AND the broker, then releases the slot", async () => {
    const broadcast: Envelope[] = [];
    subscribe((item) => broadcast.push(item.env));

    const spawnFn = fakeSpawn({
      budget: [JSON.stringify({ type: "phase", phase: 1, status: "done" })],
      "integ-start": [],
      "wt-new": [JSON.stringify({ type: "subtask", id: "lane-x", status: "building", phase: 2 })],
      "wt-commit": [],
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "raised", severity: "high", summary: "empty lane" })],
      "integ-merge": [],
      "reset-base": [],
    });

    startRun(
      { runId: "run-live1", projectId: "proj", projectName: "vector", brief: "do the thing", routing: "sonnet" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {} }
    );
    await waitForSlotFree();

    // Persisted event log has the seed sync + the streamed deltas.
    const persisted = eventsSince("run-live1", 0).map((e) => e.env.type);
    expect(persisted[0]).toBe("sync");
    expect(persisted).toContain("phase");
    expect(persisted).toContain("gate");

    // Broadcast fan-out saw the same stream (SSE clients).
    expect(broadcast.some((e) => e.type === "sync")).toBe(true);
    expect(broadcast.some((e) => e.type === "gate")).toBe(true);

    // An audit row exists per spawned subcommand (budget/integ-start/wt-new/... + reset-base).
    const cmds = listAudit(50).map((a) => a.cmd);
    expect(cmds).toContain("budget");
    expect(cmds).toContain("wt-verify");
    expect(cmds).toContain("reset-base");

    // Snapshot persisted; slot free.
    expect(getSnapshot("run-live1")?.projectName).toBe("vector");
    expect(currentSlot()).toBeNull();
  });

  it("rejects a second concurrent run (single slot)", () => {
    // A spawn that never closes holds the slot for the assertion.
    const hang = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.pid = 1;
      child.kill = () => true;
      return child as never;
    });
    startRun(
      { runId: "run-a", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: hang as never, writePlan: () => {} }
    );
    expect(currentSlot()).toBe("run-a");
    expect(() =>
      startRun({ runId: "run-b", projectId: "proj", projectName: "v", brief: "y" }, { live: true, spawnFn: hang as never, writePlan: () => {} })
    ).toThrow(SlotTakenError);
    _resetSlot(); // release the hung run for teardown
  });

  it("non-live startRun only seeds (no harness spawn) — fixture path is untouched", async () => {
    const spawnFn = vi.fn();
    startRun({ runId: "run-fix", projectId: "proj", projectName: "v", brief: "x" }, { live: false, spawnFn: spawnFn as never });
    await waitForSlotFree();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(eventsSince("run-fix", 0).map((e) => e.env.type)).toEqual(["sync"]);
  });
});

describe("buildAgentPrompt", () => {
  it("embeds the brief, mandates the full toolset, and forbids git commit", () => {
    const p = buildAgentPrompt("add a /health route");
    expect(p).toContain("add a /health route");
    expect(p).toContain("FULL toolset");
    expect(p).toMatch(/DO NOT run `git commit`/);
  });

  it("length-caps an oversized brief (never exceeds agent-runner's MAX_PROMPT)", () => {
    const p = buildAgentPrompt("x".repeat(200_000));
    expect(p.length).toBeLessThan(100_000);
  });
});

describe("startRun — agent-exec build phase (ENABLE_AGENT_EXEC gate)", () => {
  // A fake harness child that also RECORDS the order of spawned subcommands, so we can
  // assert the agent build runs BETWEEN wt-new and wt-commit.
  function recordingSpawn(order: string[], byCmd: Record<string, string[]> = {}) {
    return vi.fn((_script: string, args: string[], opts: Record<string, unknown>) => {
      expect(opts.shell).toBe(false);
      order.push(args[0]);
      const lines = byCmd[args[0]] ?? [];
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean };
      child.stdout = Readable.from(lines.map((l) => l + "\n"));
      child.stderr = Readable.from([]);
      child.pid = 999;
      child.kill = () => true;
      child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
      return child as never;
    });
  }

  it("with ENABLE_AGENT_EXEC=1: runs the agent between wt-new and wt-commit, emits usage, and traces the minted session", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const broadcast: Envelope[] = [];
    subscribe((item) => broadcast.push(item.env));

    const order: string[] = [];
    const spawnFn = recordingSpawn(order, {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });

    let agentOpts: Parameters<RunAgentFn>[0] | undefined;
    const runAgent: RunAgentFn = async (o) => {
      agentOpts = o;
      order.push("agent"); // slot the agent into the recorded ordering
      return {
        exitCode: 0,
        sessionId: "sess-agent01",
        usage: { model: "sonnet", inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreationTokens: 8, contextWindow: 200000, costUsd: 0.01 },
        audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 },
      };
    };

    startRun(
      { runId: "run-agent1", projectId: "proj", projectName: "v", brief: "do the thing", routing: "sonnet" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    // The agent was called with the composed prompt, the lane cwd, the lane slug as
    // sessionId, and the full toolset (incl. Bash).
    expect(agentOpts).toBeDefined();
    expect(agentOpts!.prompt).toContain("do the thing");
    expect(agentOpts!.sessionId).toMatch(/^lane-[0-9a-f]{16}$/);
    expect(agentOpts!.allowedTools).toContain("Bash");

    // Ordering: wt-new → agent → wt-commit.
    const iNew = order.indexOf("wt-new");
    const iAgent = order.indexOf("agent");
    const iCommit = order.indexOf("wt-commit");
    expect(iNew).toBeGreaterThanOrEqual(0);
    expect(iAgent).toBeGreaterThan(iNew);
    expect(iCommit).toBeGreaterThan(iAgent);

    // A usage envelope was emitted from the agent's reported usage.
    const usage = broadcast.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    expect((usage as Extract<Envelope, { type: "usage" }>).payload.costUsd).toBe(0.01);

    // Gate D: the trace subcommand ran with the minted session (after wt-verify, before merge).
    expect(order).toContain("trace");
    expect(order.indexOf("trace")).toBeGreaterThan(order.indexOf("wt-verify"));
    expect(order.indexOf("trace")).toBeLessThan(order.indexOf("integ-merge"));
    expect(listAudit(50).map((a) => a.cmd)).toContain("trace");
  });

  it("with ENABLE_AGENT_EXEC unset: the agent is NEVER called and the flow is unchanged", async () => {
    // (ENABLE_AGENT_EXEC intentionally not set)
    const order: string[] = [];
    const spawnFn = recordingSpawn(order, {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "raised", severity: "high", summary: "empty lane" })],
    });
    const runAgent = vi.fn();

    startRun(
      { runId: "run-noexec", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent: runAgent as never, relocate: () => true }
    );
    await waitForSlotFree();

    expect(runAgent).not.toHaveBeenCalled();
    expect(order).not.toContain("agent");
    expect(order).not.toContain("trace"); // no session → no Gate D
    // Same subcommand set as before the wiring.
    expect(order).toEqual(expect.arrayContaining(["budget", "integ-start", "wt-new", "wt-commit", "wt-verify", "integ-merge", "reset-base"]));
  });

  it("fail-closed: an agent that rejects fails the run BEFORE commit/verify/merge", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = recordingSpawn(order);
    const runAgent: RunAgentFn = async () => {
      throw new Error("agent blew up");
    };

    startRun(
      { runId: "run-agentfail", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    // The build failed before any commit/verify/merge; only pre-agent steps + reset-base ran.
    expect(order).toContain("wt-new");
    expect(order).not.toContain("wt-commit");
    expect(order).not.toContain("integ-merge");
    expect(getSnapshot("run-agentfail")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("fail-closed: an agent that RESOLVES with a nonzero exit code fails BEFORE commit/verify/merge", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = recordingSpawn(order);
    // Resolves normally (no reject) but with exitCode !== 0 — must NOT flow into wt-commit.
    const runAgent: RunAgentFn = async () => ({
      exitCode: 1,
      sessionId: "sess-agent01",
      usage: null,
      audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 1 },
    });

    startRun(
      { runId: "run-agentexit", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    expect(order).toContain("wt-new");
    expect(order).not.toContain("wt-commit");
    expect(order).not.toContain("wt-verify");
    expect(order).not.toContain("trace");
    expect(order).not.toContain("integ-merge");
    expect(getSnapshot("run-agentexit")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("fail-closed (Gate D): agent ran + exited 0 but produced NO session → run fails before merge", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = recordingSpawn(order, {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });
    const runAgent: RunAgentFn = async () => ({
      exitCode: 0,
      sessionId: null, // suppressed/absent trace session — must not silently skip Gate D
      usage: null,
      audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 },
    });

    startRun(
      { runId: "run-nosess", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    // commit/verify still ran (agent exited 0), but Gate D could not run → fail closed, never merged.
    expect(order).toContain("wt-commit");
    expect(order).toContain("wt-verify");
    expect(order).not.toContain("trace");
    expect(order).not.toContain("integ-merge");
    expect(getSnapshot("run-nosess")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("fail-closed (Gate D): agent ran but relocate() returns false → run fails before merge (no trace-skip bypass)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = recordingSpawn(order, {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });
    const runAgent: RunAgentFn = async () => ({
      exitCode: 0,
      sessionId: "sess-agent01",
      usage: null,
      audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 },
    });

    startRun(
      { runId: "run-noreloc", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => false }
    );
    await waitForSlotFree();

    expect(order).not.toContain("trace"); // relocate=false ⇒ Gate D can't run
    expect(order).not.toContain("integ-merge"); // ⇒ never merged
    expect(getSnapshot("run-noreloc")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });
});
