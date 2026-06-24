// web/lib/contract/store.ts
// FROZEN — ADR 0001 §2.4 + NOTES §"Ownership-conflict resolution". The store
// INTERFACE only (type-only). Implementation is Lane B (lib/store/{store,raf-flush}.ts);
// the React binding is Lane C (lib/store/useRunState.ts). No file is co-written.
//
// The rAF-aligned batch/flush window is the named contract member: apply() buffers
// deltas WITHOUT notifying React; flush() commits the buffer + notifies subscribers,
// called exactly once per requestAnimationFrame. The flush is the single clock both
// projections share.

import type { RunState } from "./types";
import type { SSEEvent } from "./events";

export interface RunStore {
  getSnapshot(): RunState;
  subscribe(listener: () => void): () => void;
  apply(event: SSEEvent): void; // buffers; does NOT notify (no per-event React notify)
  flush(): void; // commits buffer + notifies subscribers; called once per rAF
}

export type CreateStore = (initial: RunState) => RunStore;
