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
import { spawnHarness, type HarnessSubcommand, type SpawnHarnessOptions } from "./harness-bridge";
import { spawnAgent, worktreePathFor, type AgentSpec } from "./agent-bridge";
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

/** Agent runner signature (so tests can inject a fake without spawning claude). */
type RunAgentFn = (
  spec: AgentSpec,
  opts?: { spawnFn?: SpawnHarnessOptions["spawnFn"] }
) => Promise<{ code: number | null; sessionId: string | null }>;

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
 * Execute a server-built live run: Gate A (budget) → open integration → for each lane
 * { wt-new → run the AGENT in the worktree → integ-merge (Gate C) → trace the agent's
 * session (Gate D) }. Provenance is minted from server-built values before each step.
 * A non-zero exit / agent failure stops the run (finalized failed by startRun's catch).
 *
 * The agent step is gated inside spawnAgent (ENABLE_AGENT_EXEC); promote is never auto-
 * run. The session for the trace gate is the one the agent actually reported.
 *
 * ponytail (runtime gate-checklist items, validated on the VPS against a real agent):
 *   - budget needs the route-cost plan.jsonl on disk; trace needs the agent's worktree
 *     trace relocated to the repo's .claude/traces.
 *   - integ-merge assumes the lane is COMMITTED: the agent is prompted to commit, but a
 *     post-agent clean-tree / lane-has-commits verification (harness `wt-verify`) should
 *     gate the merge.
 *   - on failure, the worktree + feat/integration branches are left dangling; cleanup is
 *     `harness.sh clean` (destructive — intentionally manual, not auto-run here).
 * Until these land a real live run fails at the first missing artifact (gated off).
 */
async function runLive(
  plan: RunPlan,
  onEvent: (event: SSEEvent) => void,
  opts: { spawnFn?: SpawnHarnessOptions["spawnFn"]; runAgent?: RunAgentFn }
): Promise<void> {
  const runAgent = opts.runAgent ?? spawnAgent;

  // Pre-mint ALL provenance up front, so a malformed plan fails BEFORE any harness
  // side effect (no half-created worktrees from a bad later lane).
  mintPlanFile(plan.planFile);
  for (const lane of plan.lanes) mintLane(lane.slug);

  await runSub({ cmd: "budget", planFile: plan.planFile }, onEvent, opts.spawnFn); // Gate A
  await runSub({ cmd: "integ-start" }, onEvent, opts.spawnFn);

  for (const lane of plan.lanes) {
    await runSub({ cmd: "wt-new", slug: lane.slug }, onEvent, opts.spawnFn);

    // Build: the agent writes (and is prompted to commit) its work in the lane
    // worktree (gated; refuses unless enabled). runAgent gets NO harness spawn — it's
    // a distinct seam (real spawnAgent in prod, an injected fake in tests).
    const { code, sessionId } = await runAgent({
      slug: lane.slug,
      worktreePath: worktreePathFor(lane.slug),
      taskPrompt: lane.taskPrompt,
      model: lane.model,
    });
    if (code !== 0) {
      throw new HarnessExitError(`agent for lane '${lane.slug}' exited with code ${code}`);
    }

    await runSub({ cmd: "integ-merge", slug: lane.slug }, onEvent, opts.spawnFn); // Gate C

    // Gate D: trajectory check on the agent's actual session (skip if it reported none).
    if (sessionId) {
      mintSession(sessionId);
      await runSub({ cmd: "trace", session: sessionId }, onEvent, opts.spawnFn);
    }
  }
}

/**
 * Build the live RunPlan from a brief. Provenance-bearing values (lane slug, plan
 * file) are derived from the SERVER-minted runId — never the brief — so minting them
 * is trustworthy (T1). The taskPrompt is the brief (opaque task text; not provenance).
 * `promote` is never planned (separate human-gated action).
 *
 * ponytail: single generic lane. Real multi-lane decomposition (brief → N lanes via
 * the decompose agent) is a later increment.
 */
export function planRun(runId: string, brief: string): RunPlan {
  // Hash the FULL runId → a fixed-length, collision-resistant, validator-safe id, so
  // distinct runs can never collide on a lane slug / worktree branch (no lossy
  // truncation of an odd runId).
  const id = createHash("sha1").update(runId).digest("hex").slice(0, 16);
  const slug = `lane-${id}`; // 21 chars ≤ SLUG cap; starts with a letter
  const planFile = `plan-${id}.jsonl`; // PLAN_FILE: bare filename
  // The agent must commit so integ-merge has something to merge (clean-tree verify is
  // a gate item — see runLive ponytail).
  const taskPrompt = `${brief}\n\nWhen your changes are complete, commit them to the current branch.`;
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
