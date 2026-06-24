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

  it("finalizes FAILED and skips merge/trace when the agent fails", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 1, sessionId: null }));

    await runToCompletion("run-2", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(getSnapshot("run-2")?.task.state).toBe("failed");
    // Got as far as wt-new; the agent failure stopped before integ-merge/trace.
    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new"]);
  });

  it("the agent step is gated: real spawnAgent refuses unless ENABLE_AGENT_EXEC=1", async () => {
    // No runAgent injected → the REAL spawnAgent runs; with the flag unset it refuses,
    // so the run fails at the agent step (harness steps before it used the fake spawn).
    const { fn: spawnFn, calls } = harnessFake(0);
    expect(process.env.ENABLE_AGENT_EXEC).not.toBe("1");

    await runToCompletion("run-3", "x", { live: true, plan: onePlan, spawnFn });

    expect(getSnapshot("run-3")?.task.state).toBe("failed");
    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new"]); // stopped at the agent
    expect(getAuditLog().some((r) => r.cmd === "agent" && r.outcome === "refused")).toBe(true);
  });

  it("skips the trace gate when the agent reports no session", async () => {
    const { fn: spawnFn, calls } = harnessFake(0);
    const runAgent = vi.fn(async () => ({ code: 0, sessionId: null }));

    await runToCompletion("run-ns", "x", { live: true, plan: onePlan, spawnFn, runAgent });

    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new", "wt-commit", "wt-verify", "integ-merge"]); // no trace
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
    expect(calls.map((c) => c[0])).toEqual(["budget", "integ-start", "wt-new", "wt-commit", "wt-verify"]);
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
