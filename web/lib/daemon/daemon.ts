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
import { mintLane, mintSession, mintPlanFile } from "./registry";

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
   * TEST-ONLY seam: a pre-built subcommand sequence. IGNORED unless NODE_ENV==="test".
   * In production the plan comes ONLY from planRun (server) so caller/brief input can
   * never become provenance — see mintProvenance / threat model T1.
   */
  plan?: HarnessSubcommand[];
  /** TEST-ONLY seam: injectable spawn. IGNORED unless NODE_ENV==="test". */
  spawnFn?: SpawnHarnessOptions["spawnFn"];
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

/** Mint provenance for a subcommand's slug/session/plan-file before buildArgs (T1). */
function mintProvenance(sub: HarnessSubcommand): void {
  switch (sub.cmd) {
    case "budget":
      mintPlanFile(sub.planFile);
      break;
    case "wt-new":
    case "integ-merge":
      mintLane(sub.slug);
      break;
    case "trace":
      mintSession(sub.session);
      break;
    // integ-start / promote take no provenance-bearing arg.
  }
}

/**
 * Run a server-built plan live: execute each harness.sh subcommand in order via
 * spawnHarness, piping its structured events into the shared pipeline. A non-zero
 * exit (raised gate, merge conflict, trace anomaly) stops the run — the gate event
 * has already streamed; the run finalizes failed.
 */
async function runLive(
  plan: HarnessSubcommand[],
  onEvent: (event: SSEEvent) => void,
  opts: { spawnFn?: SpawnHarnessOptions["spawnFn"] }
): Promise<void> {
  for (const sub of plan) {
    mintProvenance(sub); // values are server-built (planRun), never raw client input
    const { code } = await spawnHarness(sub, onEvent, { spawnFn: opts.spawnFn });
    if (code !== 0) {
      throw new HarnessExitError(`harness '${sub.cmd}' exited with code ${code}`);
    }
  }
}

/**
 * Decompose a brief into the harness subcommand sequence for a live run.
 * ponytail: not implemented — the brief→lanes→plan decomposition (and the plan
 * file the budget step prices) is the next increment. Until then, a live run with
 * no explicit opts.plan fails loudly rather than silently doing nothing. Slugs/
 * sessions it eventually produces MUST be server-generated, never echoed client text.
 */
function planRun(_brief: string): HarnessSubcommand[] {
  throw new Error("live run planning not implemented (brief→plan decomposition pending)");
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
        const plan = (testSeam && opts.plan) || planRun(brief);
        await runLive(plan, pipe.ingest, { spawnFn: testSeam ? opts.spawnFn : undefined });
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
