// web/runtime/useRunSession.ts — composition root.
// Lives OUTSIDE the lint import-boundary zones (scene/hud/app/lib/* are barred
// from importing the store implementation; runtime/ is the one place allowed to
// wire the concrete pieces together). This is where the single store, the single
// rAF flush loop, and the single SSE client are instantiated and connected:
//
//   SSE frame → createSseClient → store.apply() [buffers]
//   rAF tick  → createRafFlusher → store.flush() [commits + notifies once/frame]
//   React     → useRunState(store) (in hud) / getSnapshot() in useFrame (in scene)
//
// Both projections (scene Canvas + hud HudShell) receive the SAME RunStore
// instance, so they stay pure projections of one source of truth.
"use client";

import { useEffect, useMemo } from "react";
import { createStore } from "@/lib/store/store";
import { createRafFlusher } from "@/lib/store/raf-flush";
import { createSseClient } from "@/lib/sse/client";
import { initialRunState } from "@/lib/contract/types";
import type { RunStore } from "@/lib/contract/store";

/**
 * Create the run store and, once a runId exists, drive it from the live SSE
 * stream through the one-flush-per-frame loop. Returns the store so both the
 * scene and the HUD project off it. Passing `null` yields an idle store with no
 * loop/connection (used before a run is started).
 */
export function useRunSession(runId: string | null): RunStore {
  const store = useMemo(() => createStore(initialRunState), []);

  useEffect(() => {
    if (!runId) return;
    const flusher = createRafFlusher(store);
    flusher.start();
    const sse = createSseClient({ runId, store });
    return () => {
      sse.destroy();
      flusher.stop();
    };
  }, [runId, store]);

  return store;
}
