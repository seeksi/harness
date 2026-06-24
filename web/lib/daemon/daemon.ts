// web/lib/daemon/daemon.ts
// Single-slot run orchestrator and the SINGLE event producer. startRun acquires
// the slot, seeds the snapshot, and kicks off a background driver that — for each
// event — reduces state, persists it, and publishes to the broker. Persistence
// and SSE clients both consume from the broker; nothing replays the fixture
// independently.
//
// This increment drives a DRY RUN by replaying the dryRun fixture. The real
// harness-bridge spawn replaces the loop body (see harness-bridge.ts).

import { reducer } from "@/lib/contract/events";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";
import { dryRun } from "@/lib/contract/fixture";
import {
  acquireSlot,
  releaseSlot,
  appendEvent,
  upsertSnapshot,
  finalizeRun,
} from "@/lib/store/persist";
import { publish, complete } from "./broker";

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

/**
 * Start a new dry-run. Acquires the single slot (throws SlotTakenError if taken),
 * seeds the persisted snapshot with the real run identity, and launches the
 * background producer. Returns immediately; progress is observed via the broker
 * (SSE stream) and persistence (GET /api/runs).
 */
export function startRun(runId: string, brief: string): void {
  if (!acquireSlot(runId)) {
    throw new SlotTakenError("slot already occupied");
  }

  let state: RunState = {
    ...initialRunState,
    task: { ...initialRunState.task, id: runId, brief, state: "running" },
  };
  upsertSnapshot(runId, state);

  void (async () => {
    try {
      for (const event of dryRun) {
        // Skip the fixture's `hello` — it carries the fixture's run identity and
        // would clobber the real seeded runId/brief. Deltas are self-sufficient.
        // ponytail: replace dryRun iteration with the harness-bridge spawn when real.
        // When wiring live, mint each lane slug / trace session (registry.mintLane /
        // mintSession) at planning time — buildArgs rejects any unminted value (T1).
        if (event.type === "hello") continue;
        state = reducer(state, event);
        appendEvent(runId, event);
        upsertSnapshot(runId, state);
        publish(runId, event);
        await delay(DRY_RUN_DELAY_MS);
      }
      finalizeRun(runId, "done");
    } catch {
      // Producer failed mid-run: persist a terminal failed outcome so clients
      // don't see a forever-"running" snapshot.
      state = { ...state, task: { ...state.task, state: "failed" } };
      upsertSnapshot(runId, state);
      finalizeRun(runId, "failed");
    } finally {
      releaseSlot(runId);
      complete(runId);
    }
  })();
}

// ponytail: multi-run history / cancellation; add when runs become long-lived or
// the operator needs to abort a run mid-flight (wire an AbortController into the loop).
