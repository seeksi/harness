// web/lib/store/store.ts
// Lane B — the rAF state spine. Implements the frozen contract `RunStore`
// interface (lib/contract/store.ts). This is the SINGLE publication path: SSE
// handlers call apply() which only BUFFERS; the rAF loop (raf-flush.ts) calls
// flush() once per frame, which folds the buffer through the contract reducer,
// bumps a version, and notifies subscribers EXACTLY ONCE — and only when there
// was real work (pending events AND a state change). A flush over an empty
// buffer, or one that produces an identical state reference, never notifies, so
// quiet frames cost zero React re-renders.
//
// Reducer indirection: we import the reducer from the contract module by name so
// production uses Lane A's body, while unit tests can `vi.mock('@/lib/contract/events')`
// to inject a trivial reducer and test the flush/notify MECHANICS independently
// of Lane A (whose reducer is still a throwing stub at this increment). The
// public CreateStore signature is unchanged.

import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";
import { reducer } from "@/lib/contract/events";
import type { CreateStore, RunStore } from "@/lib/contract/store";

export const createStore: CreateStore = (initial: RunState): RunStore => {
  let committed: RunState = initial;
  let version = 0; // bumped only on a notifying flush; lets useSyncExternalStore dedupe
  const pending: SSEEvent[] = [];
  const listeners = new Set<() => void>();

  const getSnapshot = (): RunState => committed;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const apply = (event: SSEEvent): void => {
    // Buffer only. No reduce, no notify — per-event React notify is forbidden.
    pending.push(event);
  };

  const flush = (): void => {
    // Empty buffer → no work → no notify (no spurious re-render on quiet frames).
    if (pending.length === 0) return;

    // Drain and fold the whole batch through the reducer in arrival order, so N
    // events collapse into one commit + one notify per frame.
    let next = committed;
    for (const event of pending) {
      next = reducer(next, event);
    }
    pending.length = 0;

    // Only notify if the fold actually produced a new state. A reducer that
    // returns the same reference (e.g. all-unknown events it dropped) must not
    // trigger a re-render.
    if (next === committed) return;

    committed = next;
    version++;
    for (const listener of listeners) listener();
  };

  // version is intentionally closed-over and exposed only via getSnapshot identity;
  // ponytail: no public getVersion(). add when useSyncExternalStore needs a cheap
  // server-snapshot integer or devtools wants a frame counter.
  void version;

  return { getSnapshot, subscribe, apply, flush };
};
