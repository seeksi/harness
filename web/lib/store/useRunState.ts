// web/lib/store/useRunState.ts — Lane C sole writer.
// Binds the contract RunStore interface to React via useSyncExternalStore.
// Imports the interface from lib/contract/store.ts only — never from Lane B's
// lib/store/store.ts or raf-flush.ts (those are B's internal implementation).
"use client";

import { useSyncExternalStore } from "react";
import type { RunStore } from "@/lib/contract/store";
import type { RunState } from "@/lib/contract/types";

/**
 * React binding for RunStore.
 * Returns the current RunState snapshot; re-renders only when flush() notifies.
 * The store's apply() accumulates deltas without notifying — the rAF flush
 * (Lane B's raf-flush.ts) calls flush() once per frame, which is the only
 * subscriber notification path. This hook is read-only: no setState, no dispatch.
 */
export function useRunState(store: RunStore): RunState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
