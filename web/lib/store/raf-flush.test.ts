// web/lib/store/raf-flush.test.ts
// Lane B — the rAF loop calls flush() exactly once per frame, start() is
// idempotent, and stop() halts further flushes. Uses a fake rAF clock and a
// stub store (flush mechanics are tested in store.test.ts).

import { describe, it, expect, vi } from "vitest";
import { createRafFlusher } from "./raf-flush";
import type { RunStore } from "@/lib/contract/store";

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
    tick(time = 0) {
      const cbs = [...queue.entries()];
      queue.clear();
      for (const [, cb] of cbs) cb(time);
    },
    pending: () => queue.size,
  };
}

function stubStore(flush: () => void): RunStore {
  return {
    getSnapshot: () => ({}) as never,
    subscribe: () => () => {},
    apply: () => {},
    flush,
  };
}

describe("createRafFlusher", () => {
  it("calls flush() exactly once per frame", () => {
    const flush = vi.fn();
    const raf = makeFakeRaf();
    const f = createRafFlusher(stubStore(flush), raf);
    f.start();
    expect(flush).toHaveBeenCalledTimes(0); // nothing until a frame
    raf.tick();
    expect(flush).toHaveBeenCalledTimes(1);
    raf.tick();
    expect(flush).toHaveBeenCalledTimes(2);
    raf.tick();
    expect(flush).toHaveBeenCalledTimes(3);
    f.stop();
  });

  it("start() is idempotent — no double scheduling", () => {
    const flush = vi.fn();
    const raf = makeFakeRaf();
    const f = createRafFlusher(stubStore(flush), raf);
    f.start();
    f.start();
    f.start();
    expect(raf.pending()).toBe(1); // only one frame queued
    raf.tick();
    expect(flush).toHaveBeenCalledTimes(1);
    f.stop();
  });

  it("stop() halts further flushes", () => {
    const flush = vi.fn();
    const raf = makeFakeRaf();
    const f = createRafFlusher(stubStore(flush), raf);
    f.start();
    raf.tick();
    expect(flush).toHaveBeenCalledTimes(1);
    f.stop();
    expect(f.running).toBe(false);
    raf.tick(); // nothing queued
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
