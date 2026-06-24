// web/lib/daemon/daemon.ts
// Single-slot run orchestrator. In this increment, drives a DRY RUN by replaying
// the dryRun fixture from lib/contract/fixture.ts as the event source.
// Real harness.sh spawning is deferred — see harness-bridge.ts ponytail note.

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
} from "@/lib/store/persist";

export type RunHandle = {
  runId: string;
  /** Async generator — yields SSEEvents in order; caller must consume to drive the run. */
  events: AsyncGenerator<SSEEvent, void, unknown>;
};

/** Milliseconds between dry-run event yields (simulates a live stream). */
const DRY_RUN_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Start a new dry-run. Acquires the single slot or throws if taken.
 * Returns a RunHandle whose `events` generator must be iterated to drive the run.
 */
export async function startRun(runId: string, brief: string): Promise<RunHandle> {
  const acquired = acquireSlot(runId);
  if (!acquired) {
    throw new SlotTakenError("slot already occupied");
  }

  let state: RunState = initialRunState;

  async function* generate(): AsyncGenerator<SSEEvent, void, unknown> {
    try {
      for (const event of dryRun) {
        // Skip the fixture's `hello` — it carries the fixture's run identity
        // (`run-fixture`) and would replace our real server-generated runId/brief
        // wholesale. The seeded snapshot below is the real resync state; deltas
        // are self-sufficient (subtask events create-if-missing in the reducer).
        if (event.type === "hello") continue;
        // ponytail: replace dryRun iteration with harness-bridge spawn when real.
        state = reducer(state, event);
        appendEvent(runId, event);
        upsertSnapshot(runId, state);
        yield event;
        await delay(DRY_RUN_DELAY_MS);
      }
    } finally {
      releaseSlot(runId);
    }
  }

  // Seed the snapshot with the brief so GET /api/runs sees it immediately.
  state = { ...state, task: { ...state.task, id: runId, brief, state: "running" } };
  upsertSnapshot(runId, state);

  return { runId, events: generate() };
}

export class SlotTakenError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SlotTakenError";
  }
}

// ponytail: fan-out to multiple subscribers (multiple SSE clients for same run);
// add when multi-tab support is needed — upgrade path: replace the single generator
// with an EventEmitter that all SSE handlers subscribe to.
