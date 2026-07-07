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
  delete process.env.LANE_CONCURRENCY;
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

describe("planRun — provenance derived from the server runId, never the briefs", () => {
  it("derives shape-valid lane slugs + plan file deterministically from runId", () => {
    const a = planRun("run-aaaa", "auto", ["one"]);
    const b = planRun("run-aaaa", "opus", ["one"]);
    expect(a.lanes).toHaveLength(1);
    expect(a.lanes[0].slug).toMatch(/^lane-[0-9a-f]{16}-0$/);
    expect(a.planFile).toMatch(/^plan-[0-9a-f]{16}\.jsonl$/);
    expect(a.lanes[0].slug).toBe(b.lanes[0].slug); // same runId → same provenance
    expect(a.model).toBe("sonnet");
    expect(b.model).toBe("opus");
  });

  it("multi-lane: one indexed slug per brief, all off the runId hash — never the brief text", () => {
    const plan = planRun("run-bbbb", "auto", ["../../etc/passwd; rm -rf", "lane two"]);
    expect(plan.lanes.map((l) => l.slug)).toEqual([
      expect.stringMatching(/^lane-[0-9a-f]{16}-0$/),
      expect.stringMatching(/^lane-[0-9a-f]{16}-1$/),
    ]);
    expect(plan.lanes[0].slug.slice(0, 21)).toBe(plan.lanes[1].slug.slice(0, 21)); // shared hash
    expect(plan.lanes[0].brief).toBe("../../etc/passwd; rm -rf"); // brief rides along opaque
    for (const lane of plan.lanes) expect(lane.slug).not.toContain("passwd");
  });

  it("re-asserts lane invariants (choke point): throws on [], >4 briefs, and non-string/blank entries", () => {
    expect(() => planRun("run-cccc", "auto", [])).toThrow(/1\.\.4/);
    expect(() => planRun("run-cccc", "auto", ["a", "b", "c", "d", "e"])).toThrow(/1\.\.4/);
    expect(() => planRun("run-cccc", "auto", ["ok", "   "])).toThrow(/non-empty/);
    expect(() => planRun("run-cccc", "auto", ["ok", 5 as never])).toThrow(/non-empty/);
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
    expect(agentOpts!.sessionId).toMatch(/^lane-[0-9a-f]{16}-0$/);
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

describe("startRun — multi-lane (laneBriefs)", () => {
  // Recorder keyed `cmd:slug` (argv[1] is the lane slug for wt-*/integ-merge, the
  // session for trace) so per-lane ordering is assertable.
  function laneRecordingSpawn(order: string[], byCmd: Record<string, string[]> = {}) {
    return vi.fn((_script: string, args: string[], opts: Record<string, unknown>) => {
      expect(opts.shell).toBe(false);
      order.push(args[1] ? `${args[0]}:${args[1]}` : args[0]);
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
  const okAgent =
    (order?: string[]): RunAgentFn =>
    async (o) => {
      order?.push(`agent:${o.sessionId}`);
      return {
        exitCode: 0,
        sessionId: `sess-${o.sessionId}`,
        usage: { model: "sonnet", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, contextWindow: 200000, costUsd: 0.01 },
        audit: { ts: 1, cmd: "agent", argv: [`lane:${o.sessionId}`], outcome: "exit", code: 0 },
      };
    };

  it("happy path: worktrees serial-first, per-lane prompts, ALL lanes finalized before ANY merge, lane order throughout", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const broadcast: Envelope[] = [];
    subscribe((item) => broadcast.push(item.env));

    const order: string[] = [];
    const spawnFn = laneRecordingSpawn(order, {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });
    const prompts: Record<string, string> = {};
    const runAgent: RunAgentFn = async (o) => {
      prompts[o.sessionId!] = o.prompt;
      return okAgent(order)(o);
    };

    startRun(
      { runId: "run-ml1", projectId: "proj", projectName: "v", brief: "summary", laneBriefs: ["lane one task", "lane two task"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    const slugs = Object.keys(prompts).sort();
    expect(slugs).toHaveLength(2);
    const [s0, s1] = slugs;
    expect(s0).toMatch(/^lane-[0-9a-f]{16}-0$/);
    expect(s1).toMatch(/^lane-[0-9a-f]{16}-1$/);
    // Each lane's agent got ITS brief (not the display summary, not the sibling's).
    expect(prompts[s0]).toContain("lane one task");
    expect(prompts[s0]).not.toContain("lane two task");
    expect(prompts[s1]).toContain("lane two task");

    const at = (key: string) => {
      const i = order.indexOf(key);
      expect(i, key).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Phase 1: BOTH worktrees exist before ANY agent runs.
    expect(at(`wt-new:${s1}`)).toBeLessThan(Math.min(at(`agent:${s0}`), at(`agent:${s1}`)));
    // Phases 3+4: EVERY lane finalized (commit → verify → trace, lane order) BEFORE ANY
    // merge; merges then run in lane order. A later lane failing its gates must never
    // find an earlier lane already merged.
    const fin0 = [`wt-commit:${s0}`, `wt-verify:${s0}`, `trace:sess-${s0}`].map(at);
    const fin1 = [`wt-commit:${s1}`, `wt-verify:${s1}`, `trace:sess-${s1}`].map(at);
    const merges = [`integ-merge:${s0}`, `integ-merge:${s1}`].map(at);
    const seq = [...fin0, ...fin1, ...merges];
    expect(seq).toEqual(seq.slice().sort((a, b) => a - b));
    // No commit before all builds finished.
    expect(Math.max(at(`agent:${s0}`), at(`agent:${s1}`))).toBeLessThan(fin0[0]);

    // One usage envelope per lane, tagged with ITS slug.
    const usageLanes = broadcast
      .filter((e) => e.type === "usage")
      .map((e) => (e as Extract<Envelope, { type: "usage" }>).payload.laneId);
    expect(usageLanes.sort()).toEqual([s0, s1]);
    expect(getSnapshot("run-ml1")?.status).toBe("done");
  });

  it("one lane failing blocks ALL merges (no lane is committed or merged)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = laneRecordingSpawn(order);
    const runAgent: RunAgentFn = async (o) => {
      if (o.sessionId!.endsWith("-1")) throw new Error("lane two agent blew up");
      return okAgent()(o);
    };

    startRun(
      { runId: "run-mlfail", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["ok lane", "doomed lane"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    // Both worktrees were created, but NOTHING was committed/verified/merged — the
    // healthy lane 0 must not reach integration when its sibling failed.
    expect(order.filter((k) => k.startsWith("wt-new:"))).toHaveLength(2);
    expect(order.some((k) => k.startsWith("wt-commit:"))).toBe(false);
    expect(order.some((k) => k.startsWith("wt-verify:"))).toBe(false);
    expect(order.some((k) => k.startsWith("integ-merge:"))).toBe(false);
    expect(getSnapshot("run-mlfail")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("LANE_CONCURRENCY default (1): builds run strictly sequentially in lane order", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const events: string[] = [];
    const runAgent: RunAgentFn = async (o) => {
      const lane = o.sessionId!.slice(-1);
      events.push(`start:${lane}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${lane}`);
      return okAgent()(o);
    };
    const spawnFn = laneRecordingSpawn([], {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });

    startRun(
      { runId: "run-mlseq", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["a", "b"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    expect(events).toEqual(["start:0", "end:0", "start:1", "end:1"]);
  });

  it("LANE_CONCURRENCY=2: builds overlap (lane 1 starts while lane 0 is still running)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    process.env.LANE_CONCURRENCY = "2";
    const events: string[] = [];
    let releaseLane0!: () => void;
    const lane1Started = new Promise<void>((r) => (releaseLane0 = r));
    const runAgent: RunAgentFn = async (o) => {
      const lane = o.sessionId!.slice(-1);
      events.push(`start:${lane}`);
      if (lane === "1") releaseLane0();
      // Lane 0 finishes only AFTER lane 1 has started — deadlocks (and times out the
      // test) if the pool were sequential, proving genuine overlap when it passes.
      if (lane === "0") await lane1Started;
      events.push(`end:${lane}`);
      return okAgent()(o);
    };
    const spawnFn = laneRecordingSpawn([], {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });

    startRun(
      { runId: "run-mlpar", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["a", "b"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    expect(events.indexOf("start:1")).toBeLessThan(events.indexOf("end:0"));
    expect(getSnapshot("run-mlpar")?.status).toBe("done");
  });

  it("explicit laneBriefs: [] fails LOUDLY (undefined-only fallback) — planRun throws before any side effect", async () => {
    const order: string[] = [];
    const spawnFn = laneRecordingSpawn(order);

    startRun(
      { runId: "run-mlempty", projectId: "proj", projectName: "v", brief: "s", laneBriefs: [] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent: okAgent(), relocate: () => true }
    );
    await waitForSlotFree();

    // [] must NOT be papered over into a single lane from `brief`: planRun throws before
    // any mint/plan-write/subcommand — only the finalizer's reset-base ever spawned.
    expect(order).toEqual(["reset-base"]);
    expect(getSnapshot("run-mlempty")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("phase split: a LATER lane failing finalize (lane-1 relocate=false) ⇒ ZERO merges (no partial integration)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = laneRecordingSpawn(order, {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });
    // Lane 0 passes every gate; lane 1's trace cannot be relocated (Gate D fail-closed).
    const relocate = (slug: string) => !slug.endsWith("-1");

    startRun(
      { runId: "run-mlsplit", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["ok lane", "doomed lane"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent: okAgent(), relocate }
    );
    await waitForSlotFree();

    // Both lanes were committed+verified in the finalize phase, but lane 1's Gate D
    // failure fires BEFORE the merge phase — so NOTHING merged (the old interleaved
    // loop would have already merged lane 0 into integration).
    expect(order.filter((k) => k.startsWith("wt-commit:"))).toHaveLength(2);
    expect(order.some((k) => k.startsWith("integ-merge:"))).toBe(false);
    expect(getSnapshot("run-mlsplit")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("duplicate agent session ids across lanes ⇒ fail closed BEFORE any wt-commit", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    const spawnFn = laneRecordingSpawn(order);
    // Both lanes echo the SAME session id (one could clobber the sibling's relocated trace).
    const runAgent: RunAgentFn = async () => ({
      exitCode: 0,
      sessionId: "sess-shared",
      usage: null,
      audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 },
    });

    startRun(
      { runId: "run-mldupe", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["a", "b"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    expect(order.some((k) => k.startsWith("wt-commit:"))).toBe(false);
    expect(order.some((k) => k.startsWith("integ-merge:"))).toBe(false);
    expect(getSnapshot("run-mldupe")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("LANE_CONCURRENCY clamp low: a non-numeric value falls back to sequential builds", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    process.env.LANE_CONCURRENCY = "abc";
    const events: string[] = [];
    const runAgent: RunAgentFn = async (o) => {
      const lane = o.sessionId!.slice(-1);
      events.push(`start:${lane}`);
      await new Promise((r) => setTimeout(r, 10));
      events.push(`end:${lane}`);
      return okAgent()(o);
    };
    const spawnFn = laneRecordingSpawn([], {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });

    startRun(
      { runId: "run-mlnan", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["a", "b"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    expect(events).toEqual(["start:0", "end:0", "start:1", "end:1"]);
  });

  it("LANE_CONCURRENCY clamp high (99): still concurrent — lanes overlap like =2", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    process.env.LANE_CONCURRENCY = "99"; // clamps to 4 — with 2 lanes both run at once
    const events: string[] = [];
    let releaseLane0!: () => void;
    const lane1Started = new Promise<void>((r) => (releaseLane0 = r));
    const runAgent: RunAgentFn = async (o) => {
      const lane = o.sessionId!.slice(-1);
      events.push(`start:${lane}`);
      if (lane === "1") releaseLane0();
      // Deadlocks (test timeout) if the clamp collapsed to sequential.
      if (lane === "0") await lane1Started;
      events.push(`end:${lane}`);
      return okAgent()(o);
    };
    const spawnFn = laneRecordingSpawn([], {
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
    });

    startRun(
      { runId: "run-mlhigh", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["a", "b"] },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true }
    );
    await waitForSlotFree();

    expect(events.indexOf("start:1")).toBeLessThan(events.indexOf("end:0"));
    expect(getSnapshot("run-mlhigh")?.status).toBe("done");
  });

  it("cleanupHome runs once per planned lane in finally — even on failure, even when a cleanup throws", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const cleaned: string[] = [];
    // Lane 1's agent fails the run; lane 0's cleanup itself throws — neither may skip
    // the remaining lanes' cleanup or the slot release.
    const runAgent: RunAgentFn = async (o) => {
      if (o.sessionId!.endsWith("-1")) throw new Error("lane two agent blew up");
      return okAgent()(o);
    };
    const cleanupHome = (slug: string) => {
      cleaned.push(slug);
      if (slug.endsWith("-0")) throw new Error("cleanup boom");
    };

    startRun(
      { runId: "run-mlclean", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["a", "b"] },
      { live: true, spawnFn: laneRecordingSpawn([]) as never, writePlan: () => {}, runAgent, relocate: () => true, cleanupHome }
    );
    await waitForSlotFree(); // slot released despite the failed run + throwing cleanup

    expect(cleaned).toHaveLength(2);
    expect(cleaned[0]).toMatch(/^lane-[0-9a-f]{16}-0$/);
    expect(cleaned[1]).toMatch(/^lane-[0-9a-f]{16}-1$/);
    expect(getSnapshot("run-mlclean")?.status).toBe("failed");
  });
});
