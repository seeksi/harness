// web/lib/store/store.test.ts
// Lane B — tests the FLUSH/NOTIFY MECHANICS of the rAF state spine independently
// of Lane A. The contract reducer is still a throwing stub at this increment, so
// we vi.mock('@/lib/contract/events') and inject a trivial counting reducer. This
// isolates the buffer→fold→notify-once behavior, which is what Lane B owns.

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as contractEvents from "@/lib/contract/events";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";

// Mockable reducer indirection: the store imports `reducer` from the contract
// module by name; here we replace it with a trivial one that bumps a counter on
// each event so we can prove all N events folded. Returns a NEW object so the
// store's "did state change?" guard sees a change.
let reducerCalls = 0;
vi.mock("@/lib/contract/events", () => ({
  reducer: (state: RunState, _event: SSEEvent): RunState => {
    reducerCalls++;
    return {
      ...state,
      task: { ...state.task, brief: String((Number(state.task.brief) || 0) + 1) },
    };
  },
}));

import { createStore, MAX_PENDING } from "./store";
import { createRafFlusher } from "./raf-flush";

// A fake, controlled rAF clock: callbacks queue and only run when we tick().
function makeFakeRaf() {
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  return {
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      const id = next++;
      queue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id: number) => {
      queue.delete(id);
    },
    /** run all currently-queued callbacks once (one frame). */
    tick(time = 0) {
      const cbs = [...queue.entries()];
      queue.clear();
      for (const [, cb] of cbs) cb(time);
    },
    pending: () => queue.size,
  };
}

const ev = (id: string): SSEEvent => ({ type: "subtask", id, status: "pending" });

beforeEach(() => {
  reducerCalls = 0;
});

describe("createStore — flush/notify mechanics", () => {
  it("THE fake-rAF burst: 100 apply() in one frame → exactly ONE notification, state folds all 100", () => {
    const store = createStore(initialRunState);
    const fakeRaf = makeFakeRaf();
    const flusher = createRafFlusher(store, fakeRaf);

    const listener = vi.fn();
    store.subscribe(listener);

    flusher.start();

    // Buffer 100 events WITHIN one frame (before any tick).
    for (let i = 0; i < 100; i++) store.apply(ev(`st-${i}`));

    // No notify should have happened from apply() alone.
    expect(listener).toHaveBeenCalledTimes(0);

    // One frame.
    fakeRaf.tick();

    // Exactly one subscriber notification for the whole batch.
    expect(listener).toHaveBeenCalledTimes(1);
    // The folded state reflects all 100 events (counting reducer ran 100x).
    expect(reducerCalls).toBe(100);
    expect(store.getSnapshot().task.brief).toBe("100");

    flusher.stop();
  });

  it("quiet frames: 0 events across 3 flushes → 0 notifications", () => {
    const store = createStore(initialRunState);
    const listener = vi.fn();
    store.subscribe(listener);

    store.flush();
    store.flush();
    store.flush();

    expect(listener).toHaveBeenCalledTimes(0);
    expect(reducerCalls).toBe(0);
  });

  it("getSnapshot() before any event → defined initial RunState", () => {
    const store = createStore(initialRunState);
    const snap = store.getSnapshot();
    expect(snap).toBeDefined();
    expect(snap).toBe(initialRunState);
    expect(snap.phases).toHaveLength(6);
    expect(snap.task.state).toBe("idle");
  });

  it("two frames each with events → exactly two notifications (one per frame)", () => {
    const store = createStore(initialRunState);
    const fakeRaf = makeFakeRaf();
    const flusher = createRafFlusher(store, fakeRaf);
    const listener = vi.fn();
    store.subscribe(listener);
    flusher.start();

    store.apply(ev("a"));
    store.apply(ev("b"));
    fakeRaf.tick();
    expect(listener).toHaveBeenCalledTimes(1);

    store.apply(ev("c"));
    fakeRaf.tick();
    expect(listener).toHaveBeenCalledTimes(2);

    // a frame with no events between does not notify
    fakeRaf.tick();
    expect(listener).toHaveBeenCalledTimes(2);

    flusher.stop();
  });

  it("flush with pending events but identity reducer (same reference) does NOT notify", () => {
    // Temporarily force the reducer to return the SAME state reference so we hit
    // the "next === committed" guard even though the buffer was non-empty.
    const spy = vi
      .spyOn(contractEvents, "reducer")
      .mockImplementation((state: RunState) => state);
    try {
      const store = createStore(initialRunState);
      const listener = vi.fn();
      store.subscribe(listener);
      store.apply(ev("a"));
      store.apply(ev("b"));
      store.flush();
      expect(listener).toHaveBeenCalledTimes(0);
      expect(store.getSnapshot()).toBe(initialRunState);
    } finally {
      spy.mockRestore();
    }
  });

  it("safety valve: buffering MAX_PENDING events without a flush bounds memory but does NOT notify; the next flush notifies once", () => {
    const store = createStore(initialRunState);
    const listener = vi.fn();
    store.subscribe(listener);

    // No rAF loop running — simulate a stalled flush while SSE keeps delivering.
    for (let i = 0; i < MAX_PENDING; i++) store.apply(ev(`st-${i}`));

    // apply() must never notify, even when the valve coalesces.
    expect(listener).toHaveBeenCalledTimes(0);
    // All events were folded (memory bounded), not dropped.
    expect(reducerCalls).toBe(MAX_PENDING);
    expect(store.getSnapshot().task.brief).toBe(String(MAX_PENDING));

    // The coalesced state is acknowledged by the next flush with exactly one notify.
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further notifications", () => {
    const store = createStore(initialRunState);
    const listener = vi.fn();
    const unsub = store.subscribe(listener);
    store.apply(ev("a"));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    store.apply(ev("b"));
    store.flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
