// Test-double store conforming to RunStore interface.
// Used in SSE client and DOM mirror tests. Does NOT use Lane B's implementation.
import type { RunStore } from "@/lib/contract/store";
import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";
import { initialRunState } from "@/lib/contract/types";

export function makeTestStore(initial: RunState = initialRunState): RunStore & {
  _applied: SSEEvent[];
  _flushCount: number;
  _notifyCount: number;
  _state: RunState;
} {
  let state = initial;
  let pending: SSEEvent[] = [];
  const applied: SSEEvent[] = [];
  const listeners = new Set<() => void>();
  let flushCount = 0;
  let notifyCount = 0;

  return {
    get _applied() { return applied; },
    get _flushCount() { return flushCount; },
    get _notifyCount() { return notifyCount; },
    get _state() { return state; },

    getSnapshot(): RunState { return state; },

    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    apply(ev: SSEEvent) {
      applied.push(ev);
      pending.push(ev);
      // apply() must NOT notify subscribers — that is flush()'s job.
    },

    flush() {
      flushCount++;
      if (pending.length === 0) return;
      // Minimal reducer: hello replaces, others are no-ops (tests drive state via setState).
      for (const ev of pending) {
        if (ev.type === "hello") state = ev.run;
      }
      pending = [];
      notifyCount++;
      listeners.forEach((cb) => cb());
    },
  };
}
