// console/lib/store/fleetStore.ts
// The rAF-batched fleet store. SSE handlers call apply() (buffer only, no notify);
// the rAF loop calls flush() once per frame, folding the buffer through the pure
// fleetReducer and notifying subscribers exactly once — quiet frames cost zero
// re-renders. Same discipline as the old single-run store, generalized to FleetState.

import type { FleetState } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";
import { fleetReducer } from "@/lib/contract/events";

const MAX_PENDING = 4096; // stalled-rAF safety valve

export interface FleetStore {
  getSnapshot(): FleetState;
  subscribe(listener: () => void): () => void;
  apply(env: Envelope): void; // buffers only
  flush(): void; // folds buffer + notifies once
}

export function createFleetStore(initial: FleetState): FleetStore {
  let committed = initial;
  const pending: Envelope[] = [];
  const listeners = new Set<() => void>();
  let coalescedDirty = false;

  const fold = (): FleetState => {
    let next = committed;
    for (const env of pending) next = fleetReducer(next, env);
    pending.length = 0;
    return next;
  };

  return {
    getSnapshot: () => committed,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    apply(env) {
      pending.push(env);
      if (pending.length >= MAX_PENDING) {
        const next = fold();
        if (next !== committed) {
          committed = next;
          coalescedDirty = true;
        }
      }
    },
    flush() {
      if (pending.length === 0) {
        if (coalescedDirty) {
          coalescedDirty = false;
          for (const l of listeners) l();
        }
        return;
      }
      const next = fold();
      const changed = next !== committed;
      committed = next;
      if (changed || coalescedDirty) {
        coalescedDirty = false;
        for (const l of listeners) l();
      }
    },
  };
}
