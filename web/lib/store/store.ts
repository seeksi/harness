// web/lib/store/store.ts
// Lane B — the rAF state spine. Implements the frozen contract `RunStore`
// interface (lib/contract/store.ts). This is the SINGLE publication path: SSE
// handlers call apply() which only BUFFERS; the rAF loop (raf-flush.ts) calls
// flush() once per frame, which folds the buffer through the contract reducer and
// notifies subscribers EXACTLY ONCE — and only when there was real work (pending
// events AND a state change). A flush over an empty buffer, or one that produces
// an identical state reference, never notifies, so quiet frames cost zero React
// re-renders.
//
// Backpressure: if rAF stalls (e.g. a backgrounded tab) while SSE keeps
// delivering, the pending buffer would grow unbounded. MAX_PENDING is a safety
// valve — when the buffer hits it, the batch is folded into committed state
// WITHOUT notifying (no off-frame React work), bounding memory; the next flush()
// notifies once. apply() still never notifies subscribers (contract preserved).
//
// Reducer indirection: we import the reducer from the contract module by name so
// production uses Lane A's body, while unit tests can `vi.mock('@/lib/contract/events')`
// to inject a trivial reducer and test the flush/notify MECHANICS independently.

import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";
import { reducer } from "@/lib/contract/events";
import type { CreateStore, RunStore } from "@/lib/contract/store";

// Safety valve for a stalled rAF. Far above any normal one-frame burst, so it
// only ever triggers when the flush loop is not running.
export const MAX_PENDING = 4096;

export const createStore: CreateStore = (initial: RunState): RunStore => {
  let committed: RunState = initial;
  const pending: SSEEvent[] = [];
  // Set when the safety valve folded events into committed without notifying;
  // the next flush() then notifies once even if its own buffer was empty.
  let coalescedDirty = false;
  const listeners = new Set<() => void>();

  const getSnapshot = (): RunState => committed;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const notifyAll = (): void => {
    for (const listener of listeners) listener();
  };

  // Drain and fold the whole pending batch through the reducer in arrival order.
  const foldPending = (): RunState => {
    let next = committed;
    for (const event of pending) next = reducer(next, event);
    pending.length = 0;
    return next;
  };

  const apply = (event: SSEEvent): void => {
    // Buffer only. No reduce, no notify — per-event React notify is forbidden.
    pending.push(event);
    if (pending.length >= MAX_PENDING) {
      // rAF is stalled; fold to bound memory but do NOT notify (stays off-frame).
      const next = foldPending();
      if (next !== committed) {
        committed = next;
        coalescedDirty = true;
      }
    }
  };

  const flush = (): void => {
    if (pending.length === 0) {
      // Nothing buffered this frame, but if the valve coalesced during a stall,
      // emit the single notification now.
      if (coalescedDirty) {
        coalescedDirty = false;
        notifyAll();
      }
      return;
    }

    // N events collapse into one commit + one notify per frame.
    const next = foldPending();
    const changed = next !== committed;
    committed = next;

    // Notify if this fold changed state OR a prior stall-coalesce is still
    // pending acknowledgement. A reducer that returns the same reference (e.g.
    // all-unknown events it dropped) and no coalesce → no re-render.
    if (changed || coalescedDirty) {
      coalescedDirty = false;
      notifyAll();
    }
  };

  return { getSnapshot, subscribe, apply, flush };
};
