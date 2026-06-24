// web/lib/daemon/daemon.ts
// Single-slot run orchestrator and the SINGLE event producer. startRun acquires
// the slot, seeds the snapshot, and kicks off a background driver that — for each
// event — reduces state, persists it, and publishes to the broker. Persistence
// and SSE clients both consume from the broker; nothing replays the fixture
// independently.
//
// Two producers share ONE ingest pipeline (reduce → append → upsert → publish):
//   - dry-run (default): replays the dryRun fixture, paced to look live.
//   - live (HARNESS_LIVE=1 or opts.live): runs real harness.sh subcommands via
//     spawnHarness, whose structured stdout events flow through the same pipeline.
// Live stays OFF by default until the threat-model gate owner enables it (it also
// needs Max-plan auth on the host); promote remains gated inside spawnHarness.

import { createHash } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { reducer } from "@/lib/contract/events";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";
import { dryRun } from "@/lib/contract/fixture";
import {
  acquireSlot,
  releaseSlot,
  appendEvent,
  upsertSnapshot,
  finalizeRun,
} from "@/lib/store/persist";
import { publish, complete } from "./broker";
import { spawnHarness, containedPlanFile, type HarnessSubcommand, type SpawnHarnessOptions } from "./harness-bridge";
import { runAgentInSandbox, worktreePathFor, relocateTrace, type AgentSpec, type AgentUsage } from "@/lib/sandbox";
import { mintLane, mintSession, mintPlanFile } from "./registry";

/** One lane to build: a worktree + the agent task that fills it. */
export interface LaneStep {
  slug: string; // server-generated (planRun); minted before use
  taskPrompt: string; // the task for the agent (may be the brief — opaque to provenance)
  model?: "haiku" | "sonnet" | "opus";
}

/** A server-built live run: the budget plan file + the lanes to build sequentially. */
export interface RunPlan {
  planFile: string; // for Gate A (budget)
  lanes: LaneStep[];
}

/** route-cost tier per model tier (budget.py prices by tier; see route-cost/models.json). */
const MODEL_TIER: Record<NonNullable<LaneStep["model"]>, "cheap" | "default" | "top"> = {
  haiku: "cheap",
  sonnet: "default",
  opus: "top",
};
// Conservative per-lane token estimate (thousands of tokens), well under the $5 ceiling.
// ponytail: a fixed estimate; replace with real per-task actuals (Claude Code /cost or
// the captured session usage) once the route step learns them.
const LANE_TOKEN_EST = { in_ktok: 40, out_ktok: 8, cached_ktok: 30 };

/**
 * Materialize the route-cost plan.jsonl that Gate A (`harness.sh budget`) prices, into
 * the SAME contained allow-dir path the bridge will pass to budget.py (one JSONL line
 * per lane: tier + estimated tokens). Without this the budget gate has nothing to read.
 */
function writePlanFile(plan: RunPlan): void {
  const abs = containedPlanFile(plan.planFile); // absolute path inside the plan allow-dir
  mkdirSync(dirname(abs), { recursive: true });
  const lines = plan.lanes.map((lane) =>
    JSON.stringify({ task: lane.slug, tier: MODEL_TIER[lane.model ?? "sonnet"], ...LANE_TOKEN_EST })
  );
  writeFileSync(abs, lines.join("\n") + "\n");
}

/** Agent runner signature (so tests can inject a fake without spawning claude). */
type RunAgentFn = (
  spec: AgentSpec,
  opts?: { spawnFn?: SpawnHarnessOptions["spawnFn"] }
) => Promise<{ code: number | null; sessionId: string | null; usage?: AgentUsage | null }>;

/**
 * Default agent runner: the safe sandbox entrypoint, adapted to the daemon's lane spec.
 * Maps lane slug → sessionId, the lane worktree → cwd, the routed model, and the agent's
 * tool allowlist, and folds the sandbox result back into the daemon's {code, sessionId,
 * usage} shape. Same gate, same audit, same flow as the previous direct spawnAgent call.
 */
const defaultRunAgent: RunAgentFn = async (spec, runOpts) => {
  const { exitCode, sessionId, usage } = await runAgentInSandbox({
    prompt: spec.taskPrompt,
    allowedTools: spec.allowedTools,
    model: spec.model,
    cwd: spec.worktreePath,
    sessionId: spec.slug,
    spawnFn: runOpts?.spawnFn as never,
  });
  return { code: exitCode, sessionId, usage };
};

/**
 * How many lane AGENT BUILDS run at once. Only the build step is concurrent — every
 * git op stays serial. The multi-lane MACHINERY is correct for any N, but DEFAULT IS 1
 * (fully sequential — identical to the pre-#16 behavior) because real N-lane concurrency
 * is NOT YET SAFE on the current host: all lane agents share one `agent` uid + one
 * $HOME/~/.claude (racy OAuth/session/cache — corruption), the same uid can read/write
 * SIBLING worktrees (cwd is not a jail), and N × the per-scope MemoryMax can exceed host
 * RAM. Raising LANE_CONCURRENCY > 1 REQUIRES the per-lane isolation chunk first: per-lane
 * OS user + HOME (or a userns/landlock jail) + a parent `umbrella-agent.slice` aggregate
 * cgroup cap. Clamped to 1..5. (Cross-review BLOCK 2026-06-24 — see harness-roadmap #16b.)
 */
const LANE_CONCURRENCY = (() => {
  const raw = Number(process.env.LANE_CONCURRENCY);
  const n = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1; // SAFE default: sequential
  return Math.min(5, Math.max(1, n));
})();

/**
 * Run `worker` over `items` with at most `cap` in flight at once, preserving each
 * item's index in the result. Settles like Promise.allSettled: one worker rejecting
 * never leaves another's rejection unhandled, and the pool always drains. No new
 * dependency — a tiny index-cursor pool shared by `cap` runners.
 * ponytail: in-process only (no backpressure across processes); fine for one daemon slot.
 */
async function asyncPool<T, R>(
  cap: number,
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await worker(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  const lanes = Math.min(Math.max(1, cap), items.length);
  await Promise.all(Array.from({ length: lanes }, runner));
  return results;
}

/** Milliseconds between dry-run event yields (simulates a live stream). */
const DRY_RUN_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export class SlotTakenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SlotTakenError";
  }
}

/** A harness subcommand exited non-zero (e.g. a raised gate / merge conflict). */
export class HarnessExitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HarnessExitError";
  }
}

export interface StartRunOptions {
  /** Force live harness execution. Defaults to HARNESS_LIVE === "1" (else dry-run). */
  live?: boolean;
  /**
   * TEST-ONLY seam: a pre-built run plan. IGNORED unless NODE_ENV==="test". In
   * production the plan comes ONLY from planRun (server) so caller/brief input can
   * never become provenance — threat model T1.
   */
  plan?: RunPlan;
  /** TEST-ONLY seam: injectable harness child spawn. IGNORED unless NODE_ENV==="test". */
  spawnFn?: SpawnHarnessOptions["spawnFn"];
  /** TEST-ONLY seam: injectable agent runner. IGNORED unless NODE_ENV==="test". */
  runAgent?: RunAgentFn;
  /** TEST-ONLY seam: injectable plan-file writer (avoid real fs). IGNORED unless test. */
  writePlan?: (plan: RunPlan) => void;
  /** TEST-ONLY seam: injectable trace relocation. IGNORED unless test. */
  relocate?: (slug: string, session: string) => boolean;
}

/**
 * The single ingest pipeline both producers feed: reduce the event into state,
 * append it to the log, upsert the snapshot, and publish to the broker. `hello` is
 * never produced (the stream route owns resync) — drop it defensively.
 */
function makeIngest(runId: string, seed: RunState) {
  let state = seed;
  upsertSnapshot(runId, state);
  return {
    ingest(event: SSEEvent): void {
      if (event.type === "hello") return;
      state = reducer(state, event);
      appendEvent(runId, event);
      upsertSnapshot(runId, state);
      publish(runId, event);
    },
    markFailed(): void {
      state = { ...state, task: { ...state.task, state: "failed" } };
      upsertSnapshot(runId, state);
    },
    markDone(): void {
      state = { ...state, task: { ...state.task, state: "done" } };
      upsertSnapshot(runId, state);
    },
  };
}

/**
 * Run one harness.sh subcommand through the pipeline; throw on a non-zero exit
 * (raised gate / conflict / anomaly — the gate event has already streamed).
 */
async function runSub(
  sub: HarnessSubcommand,
  onEvent: (event: SSEEvent) => void,
  spawnFn?: SpawnHarnessOptions["spawnFn"]
): Promise<void> {
  const { code } = await spawnHarness(sub, onEvent, { spawnFn });
  if (code !== 0) {
    throw new HarnessExitError(`harness '${sub.cmd}' exited with code ${code}`);
  }
}

/**
 * Execute a server-built live run as four phases over `plan.lanes`. Lane order (the
 * plan order) is the canonical order for every git op; only the agent BUILD is unordered.
 *   Gate A (budget) → ONE integ-start, then:
 *   1. wt-new   — SERIAL, lane order (git worktree add races the shared index/refs).
 *   2. build    — CONCURRENT, capped at LANE_CONCURRENCY. Each agent only EDITS files in
 *      its own isolated worktree (no git, no shared state) — the safe parallelism + the
 *      win. allSettled drains; if ANY lane rejected OR exited non-zero we throw BEFORE
 *      any merge (a run with a failed lane must not merge).
 *   3. finalize — SERIAL, lane order: wt-commit → wt-verify (Gate B) → (if sessionId:
 *      mintSession + relocate + trace Gate D). All git/serial; a raised gate throws.
 *   4. merge    — SERIAL, lane order: integ-merge (Gate C). The FIRST conflicting merge
 *      makes harness.sh exit non-zero → runSub throws → the run blocks with that lane's
 *      Gate C raised. Conflicts are surfaced as normal git conflicts, never auto-resolved.
 * Provenance is minted from server-built values before any side effect.
 *
 * The agent step is gated inside spawnAgent (ENABLE_AGENT_EXEC); promote is never auto-
 * run. The session for the trace gate is the one each agent actually reported.
 *
 * ponytail (remaining runtime gate-checklist items, validated on the VPS):
 *   - on failure, the worktree + feat/integration branches are left dangling; cleanup is
 *     `harness.sh clean` (destructive — intentionally manual, not auto-run here).
 *   - VPS hardening (dedicated agent user, egress firewall, resource limits) + Max-plan
 *     auth + flipping ENABLE_AGENT_EXEC are operational, not code (§6 gate checklist).
 */
async function runLive(
  plan: RunPlan,
  onEvent: (event: SSEEvent) => void,
  opts: {
    spawnFn?: SpawnHarnessOptions["spawnFn"];
    runAgent?: RunAgentFn;
    writePlan?: (plan: RunPlan) => void;
    relocate?: (slug: string, session: string) => boolean;
  }
): Promise<void> {
  const runAgent = opts.runAgent ?? defaultRunAgent;
  const writePlan = opts.writePlan ?? writePlanFile;
  const relocate = opts.relocate ?? relocateTrace;

  // Pre-mint ALL provenance up front, so a malformed plan fails BEFORE any harness
  // side effect (no half-created worktrees from a bad later lane).
  mintPlanFile(plan.planFile);
  for (const lane of plan.lanes) mintLane(lane.slug);

  writePlan(plan); // materialize the plan.jsonl Gate A prices (before budget reads it)

  await runSub({ cmd: "budget", planFile: plan.planFile }, onEvent, opts.spawnFn); // Gate A
  await runSub({ cmd: "integ-start" }, onEvent, opts.spawnFn);

  // Phase 1 — CREATE WORKTREES: SERIAL, lane order. `git worktree add` mutates the
  // shared index + refs/admin of the single repo, so these can NEVER run concurrently.
  for (const lane of plan.lanes) {
    await runSub({ cmd: "wt-new", slug: lane.slug }, onEvent, opts.spawnFn);
  }

  // Phase 2 — BUILD AGENTS: CONCURRENT, capped at LANE_CONCURRENCY. Each agent only
  // EDITS files in its own isolated worktree (no git, no Bash, no shared state) — the
  // actual win. runAgent gets NO harness spawn (a distinct seam: real spawnAgent in
  // prod, an injected fake in tests). allSettled (NOT all) so one rejection never leaves
  // another's unhandled and the pool always drains before we inspect outcomes.
  type LaneBuild = Awaited<ReturnType<RunAgentFn>>;
  const builds = await asyncPool<LaneStep, LaneBuild>(LANE_CONCURRENCY, plan.lanes, (lane) =>
    runAgent({
      slug: lane.slug,
      worktreePath: worktreePathFor(lane.slug),
      taskPrompt: lane.taskPrompt,
      model: lane.model,
    })
  );

  // Block the WHOLE run BEFORE any merge if any lane rejected OR exited non-zero — a run
  // with a failed lane must not merge. (We still emit usage for the lanes that produced
  // it, below, for the lanes that did succeed.)
  const failed = builds.findIndex(
    (b) => b.status === "rejected" || (b.status === "fulfilled" && b.value.code !== 0)
  );
  if (failed !== -1) {
    const lane = plan.lanes[failed];
    const b = builds[failed];
    const why =
      b.status === "rejected"
        ? `threw (${b.reason instanceof Error ? b.reason.message : String(b.reason)})`
        : `exited with code ${(b as PromiseFulfilledResult<LaneBuild>).value.code}`;
    throw new HarnessExitError(`agent for lane '${lane.slug}' ${why}`);
  }

  // All builds succeeded — fold to the per-lane results in lane order.
  const results = builds.map((b) => (b as PromiseFulfilledResult<LaneBuild>).value);

  // Surface ACTUAL usage/cost/context per lane (HUD token + context gauges), in lane
  // order. Best-effort: a failed-parse / no-result agent reports null → no event.
  plan.lanes.forEach((lane, i) => {
    const { usage } = results[i];
    if (usage) onEvent({ type: "usage", subtaskId: lane.slug, ...usage });
  });

  // Phase 3 — FINALIZE EACH LANE: SERIAL, lane order. All git/serial.
  for (let i = 0; i < plan.lanes.length; i++) {
    const lane = plan.lanes[i];
    const { sessionId } = results[i];

    // Commit the agent's edits (the agent has no Bash). Stages+commits only if the
    // worktree is dirty — a genuine no-op lane stays uncommitted so Gate B below still
    // RAISES on a do-nothing agent. Git stays inside harness.sh/spawnHarness (shell:false).
    await runSub({ cmd: "wt-commit", slug: lane.slug }, onEvent, opts.spawnFn);

    // Gate B: the lane must be COMMITTED + clean, else integ-merge of an empty branch is
    // a silent no-op and a do-nothing agent passes unnoticed.
    await runSub({ cmd: "wt-verify", slug: lane.slug }, onEvent, opts.spawnFn);

    // Gate D BEFORE the merge: a looping/thrashing agent's lane must not reach
    // integration. The trace was written inside the worktree; relocate it to the repo
    // root so `harness.sh trace` can read it. Skip only when there's no session or no
    // trace was produced (trajectory can't be assessed — proceed to the merge).
    if (sessionId) {
      mintSession(sessionId);
      if (relocate(lane.slug, sessionId)) {
        await runSub({ cmd: "trace", session: sessionId }, onEvent, opts.spawnFn);
      }
    }
  }

  // Phase 4 — MERGE: SERIAL, lane order. The first conflicting integ-merge makes
  // harness.sh exit non-zero → runSub throws → the run blocks with that lane's Gate C
  // raised. No catch-and-continue: conflicts are surfaced as normal git conflicts.
  for (const lane of plan.lanes) {
    await runSub({ cmd: "integ-merge", slug: lane.slug }, onEvent, opts.spawnFn); // Gate C
  }
}

/**
 * Build the live RunPlan from a brief. Provenance-bearing values (lane slug, plan
 * file) are derived from the SERVER-minted runId — never the brief — so minting them
 * is trustworthy (T1). The taskPrompt is the brief (opaque task text; not provenance).
 * `promote` is never planned (separate human-gated action).
 *
 * ponytail: single generic lane (cap: one lane). runLive already runs plan.lanes of
 * length 1..N identically — the only missing piece is real brief → N file-DISJOINT-lane
 * decomposition (the decompose agent), which is the NEXT chunk; add when wiring it.
 */
export function planRun(runId: string, brief: string): RunPlan {
  // Hash the FULL runId → a fixed-length, collision-resistant, validator-safe id, so
  // distinct runs can never collide on a lane slug / worktree branch (no lossy
  // truncation of an odd runId).
  const id = createHash("sha1").update(runId).digest("hex").slice(0, 16);
  const slug = `lane-${id}`; // 21 chars ≤ SLUG cap; starts with a letter
  const planFile = `plan-${id}.jsonl`; // PLAN_FILE: bare filename
  // The agent only edits files; the harness commits the lane afterwards (wt-commit in
  // runLive) since the agent has no Bash. So the brief stands alone — no commit step.
  const taskPrompt = brief;
  return {
    planFile,
    lanes: [{ slug, taskPrompt, model: "sonnet" }],
  };
}

/**
 * Start a new run. Acquires the single slot (throws SlotTakenError if taken),
 * seeds the persisted snapshot with the real run identity, and launches the
 * background producer (dry-run by default; live when enabled). Returns immediately;
 * progress is observed via the broker (SSE stream) and persistence (GET /api/runs).
 */
export function startRun(runId: string, brief: string, opts: StartRunOptions = {}): void {
  if (!acquireSlot(runId)) {
    throw new SlotTakenError("slot already occupied");
  }

  // Synchronous setup runs AFTER acquireSlot — release the slot if it throws so a
  // failed seed/snapshot can't leak the single slot forever.
  let pipe: ReturnType<typeof makeIngest>;
  try {
    const seed: RunState = {
      ...initialRunState,
      task: { ...initialRunState.task, id: runId, brief, state: "running" },
    };
    pipe = makeIngest(runId, seed);
  } catch (e) {
    releaseSlot(runId);
    throw e;
  }

  const live = opts.live ?? process.env.HARNESS_LIVE === "1";
  // Plan/spawn injection is a TEST seam only; production derives the plan from the
  // server planner so caller input never becomes provenance (T1).
  const testSeam = process.env.NODE_ENV === "test";

  void (async () => {
    try {
      if (live) {
        const plan = (testSeam && opts.plan) || planRun(runId, brief);
        await runLive(plan, pipe.ingest, {
          spawnFn: testSeam ? opts.spawnFn : undefined,
          runAgent: testSeam ? opts.runAgent : undefined,
          writePlan: testSeam ? opts.writePlan : undefined,
          relocate: testSeam ? opts.relocate : undefined,
        });
        pipe.markDone(); // live pipeline ran to completion → snapshot reflects done
      } else {
        for (const event of dryRun) {
          if (event.type === "hello") continue; // would clobber the seeded run identity
          pipe.ingest(event);
          await delay(DRY_RUN_DELAY_MS);
        }
      }
      finalizeRun(runId, "done");
    } catch (err) {
      // Producer failed mid-run: log the reason (server-side, no secrets) and persist
      // a terminal failed outcome so clients don't see a forever-"running" snapshot.
      console.error(`[daemon] run ${runId} failed:`, err instanceof Error ? err.message : String(err));
      pipe.markFailed();
      finalizeRun(runId, "failed");
    } finally {
      // Return the main repo checkout to BASE on EVERY live finalize (success-without-
      // promote OR failure) so it's never left stranded on `integration` — that breaks
      // the next `git pull origin main`. Best-effort: reset-base exits 0 even on a dirty
      // tree, and we swallow anything else here so a reset failure can NEVER skip the
      // slot release / completion below. Skip on dry-run (it never touches git). Runs via
      // the same spawn seam so tests can record/inject it.
      if (live) {
        try {
          await runSub({ cmd: "reset-base" }, pipe.ingest, testSeam ? opts.spawnFn : undefined);
        } catch (e) {
          console.error(`[daemon] run ${runId} reset-base failed:`, e instanceof Error ? e.message : String(e));
        }
      }
      // Release and completion are independent — a release error must not skip
      // notifying waiting SSE clients (or vice versa).
      try {
        releaseSlot(runId);
      } finally {
        complete(runId);
      }
    }
  })();
}

// ponytail: multi-run history / cancellation; add when runs become long-lived or
// the operator needs to abort a run mid-flight (wire an AbortController into runLive).
