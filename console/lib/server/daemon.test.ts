import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { startRun, planRun, currentSlot, _resetSlot, SlotTakenError, type RunAgentFn, type DecomposeFn, type RunPlan } from "./daemon";
import { resetDb, eventsSince, listAudit, getSnapshot } from "./persist";
import { subscribe, _resetBroker } from "./broker";
import { _resetRegistry } from "@/lib/bridge/registry";
import type { Envelope } from "@/lib/contract/events";
import type { HandoffFs } from "@/lib/sandbox";

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
  delete process.env.CONTEXT_MAX_HANDOFFS;
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

describe("startRun — handoff-respawn loop (context-guard)", () => {
  // A recording harness child (order-tagged) + a wt-verify that clears Gate B so the
  // success flow reaches merge. Mirrors the agent-exec describe's recordingSpawn.
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
  const clearVerify = { "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })] };

  // Programmable handoff-fs seam: `read` supplies the (per-attempt) handoff detection; archive
  // + sweep just record the attempt index they were called with, so the loop's control flow
  // (respawn / archive-out / post-loop sweep) is fully assertable without a real worktree.
  function makeHandoffFs(read: HandoffFs["read"]) {
    const archived: number[] = [];
    const swept: number[] = [];
    const fs: HandoffFs = {
      read,
      archive: (_slug, attempt) => {
        archived.push(attempt);
      },
      sweep: (_slug, attempt) => {
        swept.push(attempt);
      },
    };
    return { fs, archived, swept };
  }
  const usageOf = (costUsd: number) => ({ model: "sonnet", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, contextWindow: 200_000, costUsd });

  it("respawn trigger fires: exit-0 + agent-written handoff ⇒ 2nd attempt reruns with the handoff inlined", async () => {
    process.env.ENABLE_AGENT_EXEC = "1"; // default CONTEXT_MAX_HANDOFFS (2)
    const prompts: string[] = [];
    const runAgent: RunAgentFn = async (o) => {
      prompts.push(o.prompt);
      return { exitCode: 0, sessionId: "sess-agent01", usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };
    // Attempt 0 wrote a handoff; attempt 1 did not.
    const seq = ["HANDOFF-ALPHA", null];
    let i = 0;
    const h = makeHandoffFs(() => (i < seq.length ? seq[i++] : null));

    startRun(
      { runId: "run-hf1", projectId: "proj", projectName: "v", brief: "keep going" },
      { live: true, spawnFn: recordingSpawn([], clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    expect(prompts).toHaveLength(2); // one respawn
    expect(prompts[0]).not.toContain("Handoff from the previous agent");
    expect(prompts[1]).toContain("Handoff from the previous agent (continue from here)");
    expect(prompts[1]).toContain("HANDOFF-ALPHA");
    expect(h.archived).toEqual([0]); // attempt 0's handoff archived out before respawn
    expect(h.swept).toEqual([1]); // post-loop sweep at the final attempt
    expect(getSnapshot("run-hf1")?.status).toBe("done");
  });

  it("cap honored: CONTEXT_MAX_HANDOFFS respawns then the LAST result stands (no infinite loop)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    process.env.CONTEXT_MAX_HANDOFFS = "1"; // exactly one respawn allowed
    let calls = 0;
    const runAgent: RunAgentFn = async () => {
      calls++;
      return { exitCode: 0, sessionId: "sess-agent01", usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };
    // read ALWAYS reports a handoff — only the cap can stop the loop.
    const h = makeHandoffFs(() => "STILL-MORE");

    startRun(
      { runId: "run-hfcap", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn([], clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    expect(calls).toBe(2); // initial + 1 respawn, then cap stops it
    expect(h.archived).toEqual([0]); // only the pre-respawn archive
    expect(h.swept).toEqual([1]); // the cap attempt's handoff is swept out post-loop
    expect(getSnapshot("run-hfcap")?.status).toBe("done");
  });

  it("stale archive: once a handoff is archived out, the next read returns null ⇒ no re-trigger", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    process.env.CONTEXT_MAX_HANDOFFS = "5"; // generous cap — the archive, not the cap, must stop it
    let calls = 0;
    const runAgent: RunAgentFn = async () => {
      calls++;
      return { exitCode: 0, sessionId: "sess-agent01", usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };
    // Real-fs contract: read reports the handoff until archive() moves it out.
    let present = true;
    const archived: number[] = [];
    const swept: number[] = [];
    const fs: HandoffFs = {
      read: () => (present ? "H" : null),
      archive: (_s, a) => {
        present = false;
        archived.push(a);
      },
      sweep: (_s, a) => {
        swept.push(a);
      },
    };

    startRun(
      { runId: "run-hfstale", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn([], clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: fs }
    );
    await waitForSlotFree();

    expect(calls).toBe(2); // one respawn, then the archived handoff no longer retriggers
    expect(archived).toEqual([0]);
    expect(getSnapshot("run-hfstale")?.status).toBe("done");
  });

  it("tracked-unchanged: read()===null (no agent handoff) ⇒ NO respawn, single attempt", async () => {
    process.env.ENABLE_AGENT_EXEC = "1"; // default cap 2
    let calls = 0;
    const runAgent: RunAgentFn = async () => {
      calls++;
      return { exitCode: 0, sessionId: "sess-agent01", usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };
    // The tracked-and-unchanged HANDOFF.md case: the seam reports no agent handoff.
    const h = makeHandoffFs(() => null);

    startRun(
      { runId: "run-hftrack", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn([], clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    expect(calls).toBe(1); // no respawn
    expect(h.archived).toEqual([]); // nothing archived in-loop
    expect(h.swept).toEqual([0]); // post-loop sweep still runs (a no-op for the real fs)
    expect(getSnapshot("run-hftrack")?.status).toBe("done");
  });

  it("nonzero exit ⇒ NO respawn, run fails before wt-commit, sweep still runs (finally)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const order: string[] = [];
    let calls = 0;
    let readCalls = 0;
    const runAgent: RunAgentFn = async () => {
      calls++;
      return { exitCode: 1, sessionId: "sess-agent01", usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 1 } };
    };
    // read would report a handoff — but a nonzero exit must throw BEFORE read is consulted.
    const h = makeHandoffFs(() => {
      readCalls++;
      return "H";
    });

    startRun(
      { runId: "run-hfexit", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn(order, clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    expect(calls).toBe(1); // no respawn on nonzero
    expect(readCalls).toBe(0); // trigger never evaluated on the failure path
    expect(h.swept).toEqual([0]); // finally-sweep runs even on the throw path
    expect(order).not.toContain("wt-commit");
    expect(order).not.toContain("integ-merge");
    expect(getSnapshot("run-hfexit")?.status).toBe("failed");
    expect(currentSlot()).toBeNull();
  });

  it("sweep at cap=0 (respawn disabled): a written handoff is NOT respawned but IS swept out", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    process.env.CONTEXT_MAX_HANDOFFS = "0"; // disables respawn entirely
    let calls = 0;
    const runAgent: RunAgentFn = async () => {
      calls++;
      return { exitCode: 0, sessionId: "sess-agent01", usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };
    const h = makeHandoffFs(() => "H"); // agent wrote a handoff, but cap 0 forbids respawn

    startRun(
      { runId: "run-hfcap0", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn([], clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    expect(calls).toBe(1); // no respawn (cap 0)
    expect(h.archived).toEqual([]); // never archived in-loop
    expect(h.swept).toEqual([0]); // but the leftover handoff is swept out before wt-commit
    expect(getSnapshot("run-hfcap0")?.status).toBe("done");
  });

  it("per-attempt usage envelopes: BOTH attempts emit a usage event tagged with the lane", async () => {
    process.env.ENABLE_AGENT_EXEC = "1"; // default cap 2 → one respawn (2 attempts)
    const broadcast: Envelope[] = [];
    subscribe((item) => broadcast.push(item.env));
    let calls = 0;
    const runAgent: RunAgentFn = async () => {
      const costUsd = calls === 0 ? 0.11 : 0.22;
      calls++;
      return { exitCode: 0, sessionId: "sess-agent01", usage: usageOf(costUsd), audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };
    const seq = ["H", null];
    let i = 0;
    const h = makeHandoffFs(() => (i < seq.length ? seq[i++] : null));

    startRun(
      { runId: "run-hfusage", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn([], clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    const usageEvents = broadcast.filter((e) => e.type === "usage") as Extract<Envelope, { type: "usage" }>[];
    expect(usageEvents).toHaveLength(2); // one envelope PER attempt
    expect(usageEvents.every((e) => /^lane-[0-9a-f]{16}-0$/.test(e.payload.laneId ?? ""))).toBe(true); // tagged with the lane
    expect(usageEvents.map((e) => e.payload.costUsd).sort()).toEqual([0.11, 0.22]);
    expect(getSnapshot("run-hfusage")?.status).toBe("done");
  });

  it("runAgent REJECTION (timeout/gate refusal): read never consulted, sweep still runs, ORIGINAL reason recorded", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    let readCalls = 0;
    // runAgentInSandbox REJECTS on timeout/gate refusal (vs a clean nonzero exit, which resolves).
    const runAgent: RunAgentFn = async () => {
      throw new Error("sandbox gate refused: agent timed out (SIGKILL)");
    };
    const h = makeHandoffFs(() => {
      readCalls++;
      return "H";
    });

    startRun(
      { runId: "run-hfreject", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn(order, clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: h.fs }
    );
    await waitForSlotFree();

    expect(readCalls).toBe(0); // rejection propagates before the respawn trigger is evaluated
    expect(h.swept).toEqual([0]); // finally-sweep STILL ran on the rejection path
    expect(order).not.toContain("wt-commit");
    expect(order).not.toContain("integ-merge");
    expect(getSnapshot("run-hfreject")?.status).toBe("failed");
    // The pool recorded the ORIGINAL rejection reason — not a sweep/masking artifact.
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("sandbox gate refused: agent timed out (SIGKILL)");
    expect(currentSlot()).toBeNull();
  });

  it("sweep failure with NO primary error ⇒ fail closed: the sweep error fails the lane", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    const runAgent: RunAgentFn = async () => ({
      exitCode: 0,
      sessionId: "sess-agent01",
      usage: null,
      audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 },
    });
    // Clean finish (read ⇒ null), but the mandatory finally-sweep explodes: a possibly-
    // polluted worktree must NOT proceed to wt-commit — the sweep error fails the lane.
    const fsSeam: HandoffFs = {
      read: () => null,
      archive: () => {},
      sweep: () => {
        throw new Error("sweep exploded (git restore failed)");
      },
    };

    startRun(
      { runId: "run-hfsweepfail", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn(order, clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: fsSeam }
    );
    await waitForSlotFree();

    expect(order).not.toContain("wt-commit");
    expect(getSnapshot("run-hfsweepfail")?.status).toBe("failed");
    const failLine = errSpy.mock.calls.find((c) => String(c[0]).includes("run run-hfsweepfail failed"));
    expect(failLine?.join(" ")).toContain("sweep exploded"); // the sweep error IS the failure
  });

  it("sweep failure WITH a primary error in flight: original reason propagates, sweep failure only logged", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];
    // Primary failure: clean nonzero exit ⇒ the loop throws its own error first.
    const runAgent: RunAgentFn = async () => ({
      exitCode: 1,
      sessionId: "sess-agent01",
      usage: null,
      audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 1 },
    });
    const fsSeam: HandoffFs = {
      read: () => null,
      archive: () => {},
      sweep: () => {
        throw new Error("sweep exploded (git restore failed)");
      },
    };

    startRun(
      { runId: "run-hfsweepmask", projectId: "proj", projectName: "v", brief: "b" },
      { live: true, spawnFn: recordingSpawn(order, clearVerify) as never, writePlan: () => {}, runAgent, relocate: () => true, handoffFs: fsSeam }
    );
    await waitForSlotFree();

    expect(getSnapshot("run-hfsweepmask")?.status).toBe("failed");
    const logged = errSpy.mock.calls.map((c) => c.join(" "));
    // The run's recorded failure is the ORIGINAL nonzero-exit reason — never masked...
    const failLine = logged.find((l) => l.includes("run run-hfsweepmask failed"));
    expect(failLine).toContain("agent exited nonzero (code 1)");
    expect(failLine).not.toContain("sweep exploded");
    // ...while the sweep failure is still surfaced separately (lane slug, no content).
    expect(logged.some((l) => l.includes("handoff sweep failed for lane") && l.includes("sweep exploded"))).toBe(true);
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

  describe("startRun — decompose step", () => {
    it("happy path: decompose runs BEFORE any worktree, splits into per-lane briefs, emits phase 1 active→done", async () => {
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
      let decompArg: { brief: string; slug: string; model: string } | undefined;
      const decomposeFn: DecomposeFn = async (o) => {
        decompArg = o;
        order.push("decompose");
        return { laneBriefs: ["SPLIT ALPHA task", "SPLIT BRAVO task"] };
      };

      startRun(
        { runId: "run-dc1", projectId: "proj", projectName: "v", brief: "one big brief", routing: "sonnet", decompose: true },
        { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent, relocate: () => true, decomposeFn }
      );
      await waitForSlotFree();

      // The decompose seam got the run brief, a server-derived decomp slug, and the routed model.
      expect(decompArg).toBeDefined();
      expect(decompArg!.brief).toBe("one big brief");
      expect(decompArg!.slug).toMatch(/^decomp-[0-9a-f]{16}$/);
      expect(decompArg!.model).toBe("sonnet");

      // Ordering: decompose happens BEFORE any worktree is created.
      expect(order.indexOf("decompose")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("decompose")).toBeLessThan(order.findIndex((k) => k.startsWith("wt-new:")));

      // Each lane's agent got ITS split brief (not the run summary, not the sibling's).
      const slugs = Object.keys(prompts).sort();
      expect(slugs).toHaveLength(2);
      expect(prompts[slugs[0]]).toContain("SPLIT ALPHA task");
      expect(prompts[slugs[0]]).not.toContain("SPLIT BRAVO task");
      expect(prompts[slugs[1]]).toContain("SPLIT BRAVO task");

      // Phase 1 active + done envelopes were broadcast.
      const phaseStatuses = broadcast
        .filter((e) => e.type === "phase")
        .map((e) => (e as Extract<Envelope, { type: "phase" }>).payload.status);
      expect(phaseStatuses).toContain("active");
      expect(phaseStatuses).toContain("done");
      expect(getSnapshot("run-dc1")?.status).toBe("done");
    });

    it("mutual exclusion: decompose:true + explicit laneBriefs ⇒ fail closed, seam never called", async () => {
      process.env.ENABLE_AGENT_EXEC = "1";
      const order: string[] = [];
      const decomposeFn = vi.fn();

      startRun(
        { runId: "run-dcx", projectId: "proj", projectName: "v", brief: "s", laneBriefs: ["x"], decompose: true },
        { live: true, spawnFn: laneRecordingSpawn(order) as never, writePlan: () => {}, runAgent: okAgent(), relocate: () => true, decomposeFn: decomposeFn as never }
      );
      await waitForSlotFree();

      expect(decomposeFn).not.toHaveBeenCalled();
      expect(order).toEqual(["reset-base"]); // threw before any mint/plan/worktree side effect
      expect(getSnapshot("run-dcx")?.status).toBe("failed");
      expect(currentSlot()).toBeNull();
    });

    it("gate: decompose:true with ENABLE_AGENT_EXEC unset ⇒ fail closed, seam never called", async () => {
      // ENABLE_AGENT_EXEC intentionally not set.
      const order: string[] = [];
      const decomposeFn = vi.fn();

      startRun(
        { runId: "run-dcgate", projectId: "proj", projectName: "v", brief: "s", decompose: true },
        { live: true, spawnFn: laneRecordingSpawn(order) as never, writePlan: () => {}, runAgent: okAgent(), relocate: () => true, decomposeFn: decomposeFn as never }
      );
      await waitForSlotFree();

      expect(decomposeFn).not.toHaveBeenCalled();
      expect(order).toEqual(["reset-base"]);
      expect(getSnapshot("run-dcgate")?.status).toBe("failed");
      expect(currentSlot()).toBeNull();
    });

    it("decompose failure ⇒ run fails BEFORE any worktree; the decomp agent-home is still reclaimed", async () => {
      process.env.ENABLE_AGENT_EXEC = "1";
      const order: string[] = [];
      const cleaned: string[] = [];
      const decomposeFn: DecomposeFn = async () => {
        throw new Error("decompose blew up");
      };

      startRun(
        { runId: "run-dcfail", projectId: "proj", projectName: "v", brief: "s", decompose: true },
        { live: true, spawnFn: laneRecordingSpawn(order) as never, writePlan: () => {}, runAgent: okAgent(), relocate: () => true, decomposeFn, cleanupHome: (s) => cleaned.push(s) }
      );
      await waitForSlotFree();

      expect(order.some((k) => k.startsWith("wt-new:"))).toBe(false);
      expect(order).toEqual(["reset-base"]);
      expect(cleaned.some((s) => /^decomp-[0-9a-f]{16}$/.test(s))).toBe(true);
      expect(getSnapshot("run-dcfail")?.status).toBe("failed");
      expect(currentSlot()).toBeNull();
    });

    it("decompose failure emits a TERMINAL phase-1 envelope (active→blocked, never left active/done)", async () => {
      process.env.ENABLE_AGENT_EXEC = "1";
      const broadcast: Envelope[] = [];
      subscribe((item) => broadcast.push(item.env));
      const decomposeFn: DecomposeFn = async () => {
        throw new Error("decompose blew up");
      };

      startRun(
        { runId: "run-dcphase", projectId: "proj", projectName: "v", brief: "s", decompose: true },
        { live: true, spawnFn: laneRecordingSpawn([]) as never, writePlan: () => {}, runAgent: okAgent(), relocate: () => true, decomposeFn, cleanupHome: () => {} }
      );
      await waitForSlotFree();

      const phase1 = broadcast
        .filter((e) => e.type === "phase" && (e as Extract<Envelope, { type: "phase" }>).payload.phase === 1)
        .map((e) => (e as Extract<Envelope, { type: "phase" }>).payload.status);
      expect(phase1).toEqual(["active", "blocked"]); // active raised, then terminated — never orphaned, never "done"
      expect(getSnapshot("run-dcphase")?.status).toBe("failed");
    });

    it("home cleanup: a happy decompose run reclaims BOTH the decomp home and every lane home", async () => {
      process.env.ENABLE_AGENT_EXEC = "1";
      const cleaned: string[] = [];
      const decomposeFn: DecomposeFn = async () => ({ laneBriefs: ["lane a", "lane b"] });
      const spawnFn = laneRecordingSpawn([], {
        "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })],
      });

      startRun(
        { runId: "run-dcclean", projectId: "proj", projectName: "v", brief: "s", decompose: true },
        { live: true, spawnFn: spawnFn as never, writePlan: () => {}, runAgent: okAgent(), relocate: () => true, decomposeFn, cleanupHome: (s) => cleaned.push(s) }
      );
      await waitForSlotFree();

      expect(cleaned.filter((s) => /^decomp-[0-9a-f]{16}$/.test(s))).toHaveLength(1);
      expect(cleaned.filter((s) => /^lane-[0-9a-f]{16}-\d$/.test(s))).toHaveLength(2);
      expect(getSnapshot("run-dcclean")?.status).toBe("done");
    });
  });
});

describe("startRun — per-lane model routing (Phase 4)", () => {
  const clearVerify = { "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "clear", severity: "info", summary: "ok" })] };
  const okAgentModel =
    (sink: Record<string, string>): RunAgentFn =>
    async (o) => {
      sink[o.sessionId!] = o.model!; // record the model this lane's agent was handed
      return { exitCode: 0, sessionId: `sess-${o.sessionId}`, usage: null, audit: { ts: 1, cmd: "agent", argv: ["lane:x"], outcome: "exit", code: 0 } };
    };

  it("planRun auto: mixed briefs ⇒ per-lane models; run-global model stays sonnet", () => {
    const plan = planRun("run-rt-auto", "auto", [
      "review the security threat model", // TOP → opus
      "write docs for the README", //         CHEAP → haiku
      "implement the fetch wrapper", //       default → sonnet
    ]);
    expect(plan.lanes.map((l) => l.model)).toEqual(["opus", "haiku", "sonnet"]);
    expect(plan.model).toBe("sonnet"); // run-global (decompose/override source) unchanged
  });

  it("planRun explicit tier: every lane forced to it, brief keywords ignored", () => {
    const forced = planRun("run-rt-opus", "opus", [
      "write docs for the README", //   would route haiku under auto
      "implement the fetch wrapper", //  would route sonnet under auto
    ]);
    expect(forced.lanes.map((l) => l.model)).toEqual(["opus", "opus"]);
    expect(forced.model).toBe("opus");
    // haiku forces the low tier even onto a TOP-keyword brief.
    const h = planRun("run-rt-h", "haiku", ["review the security threat model"]);
    expect(h.lanes[0].model).toBe("haiku");
  });

  it("build worker: each lane's agent receives ITS OWN routed model (auto, multi-lane)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const models: Record<string, string> = {};
    startRun(
      {
        runId: "run-rt-worker",
        projectId: "proj",
        projectName: "v",
        brief: "s",
        routing: "auto",
        laneBriefs: ["review the security threat model", "write docs for the README", "implement the fetch wrapper"],
      },
      { live: true, spawnFn: fakeSpawn(clearVerify) as never, writePlan: () => {}, runAgent: okAgentModel(models), relocate: () => true }
    );
    await waitForSlotFree();

    const slugs = Object.keys(models).sort(); // -0, -1, -2 in slug order
    expect(slugs).toHaveLength(3);
    expect(models[slugs[0]]).toBe("opus"); //  lane 0: security/threat/review
    expect(models[slugs[1]]).toBe("haiku"); // lane 1: docs
    expect(models[slugs[2]]).toBe("sonnet"); // lane 2: ordinary impl
    expect(getSnapshot("run-rt-worker")?.status).toBe("done");
  });

  it("build worker: explicit routing forces the SAME model on every lane", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    const models: Record<string, string> = {};
    startRun(
      {
        runId: "run-rt-forced",
        projectId: "proj",
        projectName: "v",
        brief: "s",
        routing: "haiku",
        laneBriefs: ["review the security threat model", "write docs for the README"],
      },
      { live: true, spawnFn: fakeSpawn(clearVerify) as never, writePlan: () => {}, runAgent: okAgentModel(models), relocate: () => true }
    );
    await waitForSlotFree();

    expect(Object.values(models).sort()).toEqual(["haiku", "haiku"]); // both forced despite opus/haiku keywords
    expect(getSnapshot("run-rt-forced")?.status).toBe("done");
  });

  it("writePlan seam: the plan handed to the writer carries per-lane models (⇒ per-lane tier+rate lines)", async () => {
    process.env.ENABLE_AGENT_EXEC = "1";
    let captured: RunPlan | undefined;
    const models: Record<string, string> = {};
    startRun(
      {
        runId: "run-rt-wp",
        projectId: "proj",
        projectName: "v",
        brief: "s",
        routing: "auto",
        laneBriefs: ["review the security threat model", "write docs for the README"],
      },
      {
        live: true,
        spawnFn: fakeSpawn(clearVerify) as never,
        writePlan: (p) => {
          captured = p;
        },
        runAgent: okAgentModel(models),
        relocate: () => true,
      }
    );
    await waitForSlotFree();

    // writePlanFile prices each line from lane.model (tier = MODEL_TIER[lane.model],
    // rate = TIER_RATE_USD_PER_MTOK[lane.model]); asserting the per-lane models on the plan
    // it receives is the seam-level proof that sibling lanes get distinct tier+rate rows.
    expect(captured).toBeDefined();
    expect(captured!.lanes.map((l) => l.model)).toEqual(["opus", "haiku"]);
    expect(getSnapshot("run-rt-wp")?.status).toBe("done");
  });
});
