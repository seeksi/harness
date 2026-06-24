// web/lib/store/raf-flush.ts
// Lane B — the one-flush-per-frame loop. This is the ONLY caller of store.flush()
// in production: it schedules exactly one flush() per requestAnimationFrame, which
// makes the flush the single shared clock both projections read off. apply() may
// be called any number of times between frames; the buffered batch collapses into
// one commit/notify when this loop ticks.
//
// rAF is injected (defaults to the global) so tests can drive a fake clock and the
// loop stays usable in non-DOM environments. start() is idempotent; stop() cancels.

import type { RunStore } from "@/lib/contract/store";

export interface RafFlusher {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

type RafFns = {
  requestAnimationFrame: (cb: FrameRequestCallback) => number;
  cancelAnimationFrame: (handle: number) => void;
};

const defaultRaf = (): RafFns => ({
  requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
  cancelAnimationFrame: (h) => globalThis.cancelAnimationFrame(h),
});

export function createRafFlusher(store: RunStore, raf: RafFns = defaultRaf()): RafFlusher {
  let handle: number | null = null;

  const tick: FrameRequestCallback = () => {
    store.flush();
    // reschedule while running so each frame flushes once
    if (handle !== null) handle = raf.requestAnimationFrame(tick);
  };

  return {
    start() {
      if (handle !== null) return; // idempotent
      handle = raf.requestAnimationFrame(tick);
    },
    stop() {
      if (handle === null) return;
      raf.cancelAnimationFrame(handle);
      handle = null;
    },
    get running() {
      return handle !== null;
    },
  };
}
