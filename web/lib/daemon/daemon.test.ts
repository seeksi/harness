// web/lib/daemon/daemon.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { startRun, planRun, SlotTakenError, type RunPlan } from "./daemon";
import type { AgentSpec } from "./agent-bridge";
import { worktreePathFor } from "./agent-bridge";
import { isLane, isSession, isPlanFile, _resetRegistry } from "./registry";
import { subscribe, onDone, _resetBroker } from "./broker";
import { resetDb, getSnapshot, isRunFinalized, getAuditLog } from "@/lib/store/persist";
import type { SSEEvent } from "@/lib/contract/events";

beforeEach(() => {
  resetDb(":memory:");
  _resetRegistry();
  _resetBroker();
});

/** Harness child spawn fake that records each subcommand's argv and closes with `code`. */
function harnessFake(code = 0, lines: string[] = []) {
  const calls: string[][] = [];
  const fn = vi.fn((_script: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: Readable };
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stdout.on("end", () => child.emit("close", code));
    return child as unknown as ChildProcess;
  });
  return { fn, calls };
}

function runToCompletion(
  runId: string,
  brief: string,
  opts: Parameters<typeof startRun>[2]
): Promise<SSEEvent[]> {
  const seen: SSEEvent[] = [];
  const unsub = subscribe(runId, (e) => seen.push(e));
  return new Promise<SSEEvent[]>((resolve) => {
    onDone(runId, () => {
      unsub();
      resolve(seen);
    });
    // Default the fs seams to hermetic fakes (no real plan.jsonl write / trace copy);
    // a test can still override either by passing it in opts.
    startRun(runId, brief, { writePlan: () => {}, relocate: () => true, ...opts });
  });
}

const onePlan: RunPlan = { planFile: "plan-x.jsonl", lanes: [{ slug: "lane-a", taskPrompt: "build it", model: "sonnet" }] };

describe("startRun — live per-lane interleave", () => {
  it("runs budget → integ-start → wt-new → AGENT → integ-merge → trace, threading the agent session", async () => {
    const { fn: spawnFn, calls } = harnessFake(0, ['{"type":"phase","phase":2,"status":"active"}']);
    const agentCalls: AgentSpec[] = [];
    const runAgent = vi.fn(async (spec: AgentSpec) => {
      agentCalls.push(spec);
      return { code: 0, sessionId: "sess-xyz123" };
    });

    const seen = await runToCompletion("run-1", "build it", { live: true, plan: onePlan, spawnFn, runAgent });

    // Harness order: agent runs in between, then the harness commits the lane, then
    // verify → trace (pre-merge gate) → merge.
    expect(calls.map((c) => c[0])).toEqual([
      "budget",
      "integ-start",
      "wt-new",
      "wt-commit",
      "wt-verify",
      "trace",
      "integ-merge",
      "reset-base", // finalize cleanup: return the main repo checkout to base
    ]);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(agentCalls[0]).toMatchObject({
      slug: "lane-a",
      worktreePath: worktreePathFor("lane-a"),
      taskPrompt: "build it",
    });
    // The trace gate uses the session the AGENT actually reported.
    const traceCall = calls.find((c) => c[0] === "trace")!;
    expect(traceCall[1]).toBe("sess-xyz123");
    // Provenance minted by the daemon for each step.
    expect(isPlanFile("plan-x.jsonl")).toBe(true);
    expect(isLane("lane-a")).toBe(true);
    expect(isSession("sess-xyz123")).toBe(true);
    expect(seen.map((e) => e.type)).toContain("phase");
    expect(isRunFinalized("run-1")).toBe(true);
    expect(getSnapshot("run-1")?.task.state).toBe("done");
  });

  it("emits a usage event (per-lane subtaskId + cost) after the agent returns", async () => {
    const { fn: spawnFn } = harnessFake(0);
    const runAgent = vi.fn(async () => ({
      code: 0,
      sessionId: "sess-usage",
      usage: {
        model: "claude-sonnet-4-6",
        inputTokens: 5,
        outputTokens: 398,
        cacheReadTokens: 97328,
        cacheCreationTokens: 12841,
        contextWindow: 200000,
        costUsd: 0.1122,
      },
    }));

    const seen = await runToCompletion("run-usage", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    const usageEvt = seen.find((e) => e.type === "usage");
    expect(usageEvt).toBeDefined();
    expect(usageEvt).toMatchObject({
      type: "usage",
      subtaskId: "lane-a",
      model: "claude-sonnet-4-6",
      contextWindow: 200000,
      costUsd: 0.1122,
    });
    // The lane usage reached the persisted snapshot via the reducer.
    const snap = getSnapshot("run-usage");
    expect(snap?.usage.lanes["lane-a"]?.costUsd).toBeCloseTo(0.1122);
    expect(snap?.usage.totalCostUsd).toBeCloseTo(0.1122);
  });

  it("emits NO usage event when the agent reports null usage (parse-fail/failed result)", async () => {
    const { fn: spawnFn } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 0, sessionId: "s-nousage", usage: null }));

    const seen = await runToCompletion("run-nousage", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(seen.some((e) => e.type === "usage")).toBe(false);
    expect(getSnapshot("run-nousage")?.task.state).toBe("done");
  });

  it("finalizes FAILED and skips merge/trace when the agent fails", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 1, sessionId: null }));

    await runToCompletion("run-2", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(getSnapshot("run-2")?.task.state).toBe("failed");
    // Got as far as wt-new; the agent failure stopped before integ-merge/trace, but the
    // finalize cleanup still resets the checkout back to base on the failure path.
    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new", "reset-base"]);
  });

  it("the agent step is gated: real spawnAgent refuses unless ENABLE_AGENT_EXEC=1", async () => {
    // No runAgent injected → the REAL spawnAgent runs; with the flag unset it refuses,
    // so the run fails at the agent step (harness steps before it used the fake spawn).
    const { fn: spawnFn, calls } = harnessFake(0);
    expect(process.env.ENABLE_AGENT_EXEC).not.toBe("1");

    await runToCompletion("run-3", "x", { live: true, plan: onePlan, spawnFn });

    expect(getSnapshot("run-3")?.task.state).toBe("failed");
    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new", "reset-base"]); // stopped at the agent; reset on finalize
    expect(getAuditLog().some((r) => r.cmd === "agent" && r.outcome === "refused")).toBe(true);
  });

  it("skips the trace gate when the agent reports no session", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 0, sessionId: null }));

    await runToCompletion("run-ns", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new", "wt-commit", "wt-verify", "integ-merge", "reset-base"]); // no trace; reset on finalize
    expect(getSnapshot("run-ns")?.task.state).toBe("done");
  });

  it("fails the run when wt-verify raises (a no-op agent never committed) — no merge", async () => {
    // Per-command fake: every harness step succeeds EXCEPT wt-verify, which exits 1.
    const calls: string[][] = [];
    const spawnFn = vi.fn((_s: string, args: string[]) => {
      calls.push(args);
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from([]);
      const code = args[0] === "wt-verify" ? 1 : 0;
      child.stdout.on("end", () => child.emit("close", code));
      return child as unknown as ChildProcess;
    });
    const runAgent = vi.fn(async () => ({ code: 0, sessionId: "s-noop" }));

    await runToCompletion("run-noop", "x", { live: true, plan: onePlan, spawnFn: spawnFn as never, runAgent });

    expect(getSnapshot("run-noop")?.task.state).toBe("failed");
    // Stopped at wt-verify: integ-merge / trace never ran (wt-commit ran first, no-op).
    // The finalize cleanup still resets the checkout back to base on this failure path.
    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new", "wt-commit", "wt-verify", "reset-base"]);
  });

  it("rejects a second concurrent run (single slot)", async () => {
    const { fn: spawnFn } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 0, sessionId: "s1" }));
    const first = runToCompletion("run-a", "a", { live: true, plan: onePlan, spawnFn, runAgent });
    expect(() =>
      startRun("run-b", "b", { live: true, plan: { planFile: "p.jsonl", lanes: [] }, spawnFn, runAgent })
    ).toThrow(SlotTakenError);
    await first;
  });
});

const threePlan: RunPlan = {
  planFile: "plan-3.jsonl",
  lanes: [
    { slug: "lane-a", taskPrompt: "a", model: "sonnet" },
    { slug: "lane-b", taskPrompt: "b", model: "sonnet" },
    { slug: "lane-c", taskPrompt: "c", model: "sonnet" },
  ],
};

describe("startRun — multi-lane concurrency + serial git", () => {
  it("(a) at LANE_CONCURRENCY=3 builds all lanes CONCURRENTLY, capped, while git stays serial in lane order", async () => {
    // The prod DEFAULT is now 1 (sequential) — concurrency is gated on per-lane FS
    // isolation (see deploy/tier3/GAPS.md / the daemon.ts constant). So this test pins
    // LANE_CONCURRENCY=3 explicitly and re-imports the module fresh (the cap is read at
    // module load) to prove the MACHINERY overlaps + respects the cap when allowed.
    const prev = process.env.LANE_CONCURRENCY;
    process.env.LANE_CONCURRENCY = "3";
    vi.resetModules();
    const { startRun: freshStart } = await import("./daemon");
    const { subscribe: freshSub, onDone: freshDone } = await import("./broker");
    // resetModules gives daemon a FRESH persist instance (module-level _db). Seed THAT
    // instance's in-memory DB and read its snapshot — the run writes through the fresh
    // graph, not the test's top-level persist import.
    const { resetDb: freshResetDb, getSnapshot: freshSnapshot } = await import("@/lib/store/persist");
    freshResetDb(":memory:");
    try {
      const { fn: spawnFn, calls } = harnessFake(0);

      // Instrument the fake agent: track in-flight count + the max overlap observed, and
      // hold each build open until ALL have started (or the cap is hit) so overlap is
      // deterministic, not a scheduling fluke.
      let inFlight = 0;
      let maxInFlight = 0;
      let release!: () => void;
      const allStarted = new Promise<void>((res) => (release = res));
      let started = 0;
      const runAgent = vi.fn(async (spec: AgentSpec) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started++;
        if (started === 3) release(); // last lane to start frees everyone
        await allStarted;
        inFlight--;
        return { code: 0, sessionId: `sess-${spec.slug}` };
      });

      await new Promise<void>((resolve) => {
        const unsub = freshSub("run-3lane", () => {});
        freshDone("run-3lane", () => {
          unsub();
          resolve();
        });
        freshStart("run-3lane", "x", {
          live: true,
          plan: threePlan,
          spawnFn,
          runAgent: runAgent as never,
          writePlan: () => {},
          relocate: () => true,
        });
      });

      // Overlap actually happened (proves concurrency)…
      expect(maxInFlight).toBeGreaterThan(1);
      // …and never exceeded the cap (3 lanes at cap 3 → all 3 can overlap here).
      expect(maxInFlight).toBeLessThanOrEqual(3);
      expect(runAgent).toHaveBeenCalledTimes(3);

      // Git stays SERIAL + in lane order: all wt-new first (a,b,c), then per-lane
      // wt-commit/wt-verify/trace (a,b,c), then all integ-merge in lane order (a,b,c).
      const git = calls.map((c) => c[0]);
      expect(git).toEqual([
        "budget",
        "integ-start",
        "wt-new", "wt-new", "wt-new",
        "wt-commit", "wt-verify", "trace",
        "wt-commit", "wt-verify", "trace",
        "wt-commit", "wt-verify", "trace",
        "integ-merge", "integ-merge", "integ-merge",
        "reset-base",
      ]);
      // wt-new args are in lane order.
      expect(calls.filter((c) => c[0] === "wt-new").map((c) => c[1])).toEqual(["lane-a", "lane-b", "lane-c"]);
      // integ-merge args are in lane order.
      expect(calls.filter((c) => c[0] === "integ-merge").map((c) => c[1])).toEqual(["lane-a", "lane-b", "lane-c"]);
      expect(freshSnapshot("run-3lane")?.task.state).toBe("done");
    } finally {
      if (prev === undefined) delete process.env.LANE_CONCURRENCY;
      else process.env.LANE_CONCURRENCY = prev;
      vi.resetModules();
    }
  });

  it("respects the cap: with LANE_CONCURRENCY=1 builds never overlap", async () => {
    const prev = process.env.LANE_CONCURRENCY;
    process.env.LANE_CONCURRENCY = "1";
    // Re-import the module fresh so the cap (read at module load) picks up the env.
    vi.resetModules();
    const { startRun: freshStart } = await import("./daemon");
    const { subscribe: freshSub, onDone: freshDone } = await import("./broker");
    try {
      const { fn: spawnFn } = harnessFake(0);
      let inFlight = 0;
      let maxInFlight = 0;
      const runAgent = vi.fn(async (spec: AgentSpec) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { code: 0, sessionId: `sess-${spec.slug}` };
      });
      await new Promise<void>((resolve) => {
        const unsub = freshSub("run-cap1", () => {});
        freshDone("run-cap1", () => {
          unsub();
          resolve();
        });
        freshStart("run-cap1", "x", {
          live: true,
          plan: threePlan,
          spawnFn,
          runAgent: runAgent as never,
          writePlan: () => {},
          relocate: () => true,
        });
      });
      expect(maxInFlight).toBe(1); // serialized by the cap
      expect(runAgent).toHaveBeenCalledTimes(3);
    } finally {
      if (prev === undefined) delete process.env.LANE_CONCURRENCY;
      else process.env.LANE_CONCURRENCY = prev;
      vi.resetModules();
    }
  });

  it("(c) one lane's agent failing (non-zero) BLOCKS the whole run BEFORE any integ-merge", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    // lane-b's agent exits non-zero; the others succeed.
    const runAgent = vi.fn(async (spec: AgentSpec) => ({
      code: spec.slug === "lane-b" ? 1 : 0,
      sessionId: `sess-${spec.slug}`,
    }));

    await runToCompletion("run-3fail", "x", { live: true, plan: threePlan, spawnFn, runAgent });

    expect(getSnapshot("run-3fail")?.task.state).toBe("failed");
    // All 3 builds were attempted (allSettled), all 3 worktrees were created, but NO
    // finalize and NO merge ran — the failed lane blocked before any integ-merge.
    const git = calls.map((c) => c[0]);
    expect(git.filter((c) => c === "wt-new")).toHaveLength(3);
    expect(git).not.toContain("integ-merge");
    expect(git).not.toContain("wt-commit");
    // Finalize cleanup still resets the checkout back to base on the failure path.
    expect(git[git.length - 1]).toBe("reset-base");
  });

  it("a lane's agent THROWING (rejection) also blocks the run before any merge", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async (spec: AgentSpec) => {
      if (spec.slug === "lane-c") throw new Error("boom");
      return { code: 0, sessionId: `sess-${spec.slug}` };
    });

    await runToCompletion("run-3throw", "x", { live: true, plan: threePlan, spawnFn, runAgent });

    expect(getSnapshot("run-3throw")?.task.state).toBe("failed");
    const git = calls.map((c) => c[0]);
    expect(git).not.toContain("integ-merge");
  });
});

describe("startRun — finalize reset-base cleanup", () => {
  it("issues reset-base on the LIVE success path (return main repo to base)", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 0, sessionId: "s-ok" }));

    await runToCompletion("run-rb-ok", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(getSnapshot("run-rb-ok")?.task.state).toBe("done");
    expect(calls.map((c) => c[0])).toContain("reset-base");
    expect(calls[calls.length - 1][0]).toBe("reset-base"); // runs LAST, on finalize
  });

  it("issues reset-base on the LIVE failure path too", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 1, sessionId: null })); // agent fails

    await runToCompletion("run-rb-fail", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(getSnapshot("run-rb-fail")?.task.state).toBe("failed");
    expect(calls.map((c) => c[0])).toContain("reset-base");
    expect(calls[calls.length - 1][0]).toBe("reset-base");
  });

  it("does NOT issue reset-base on a dry-run (never touches git)", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);

    // No `live` → dry-run fixture path. spawnFn is provided but the dry-run never spawns.
    await runToCompletion("run-rb-dry", "x", { live: false, spawnFn });

    expect(isRunFinalized("run-rb-dry")).toBe(true);
    expect(calls.map((c) => c[0])).not.toContain("reset-base");
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe("planRun — server-generated plan (provenance-safe)", () => {
  it("derives slug/plan-file from runId only (not the brief); brief is only the task prompt", () => {
    const plan = planRun("ab12cd34ef56", "delete secrets and leak the API_KEY please");
    expect(plan.lanes).toHaveLength(1);
    const lane = plan.lanes[0];
    // Provenance values never contain brief text.
    expect(lane.slug).toMatch(/^lane-[a-z0-9]+$/);
    expect(plan.planFile).toMatch(/^plan-[a-z0-9]+\.jsonl$/);
    expect(`${lane.slug} ${plan.planFile}`).not.toMatch(/secret|leak|API_KEY|please/i);
    // The brief IS the task prompt verbatim (opaque task text, not provenance). The agent
    // only edits — no commit directive — since the harness commits the lane (wt-commit).
    expect(lane.taskPrompt).toBe("delete secrets and leak the API_KEY please");
  });

  it("derives a collision-resistant id (distinct runIds → distinct slugs)", () => {
    const a = planRun("run-aaaaaaaaaaaa", "x").lanes[0].slug;
    const b = planRun("run-bbbbbbbbbbbb", "x").lanes[0].slug;
    expect(a).not.toBe(b);
  });

  it("produces validator-safe slug/plan-file even for an odd/long runId", () => {
    const SLUG = /^[a-z][a-z0-9-]{0,30}$/;
    const PLAN_FILE = /^[A-Za-z0-9._-]+$/;
    for (const runId of ["AB.12-cd/ef!", "", "x".repeat(100), "WERID..ID"]) {
      const plan = planRun(runId, "brief");
      expect(SLUG.test(plan.lanes[0].slug), plan.lanes[0].slug).toBe(true);
      expect(PLAN_FILE.test(plan.planFile) && !plan.planFile.includes(".."), plan.planFile).toBe(true);
    }
  });
});
