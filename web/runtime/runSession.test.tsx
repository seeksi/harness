// web/runtime/runSession.test.tsx
// Integration regression for the cross-review BLOCK (ADR-0001 single-source-of-truth):
// page.tsx previously hand-rolled a SECOND reducer ("makeDemoStore") that diverged
// from the frozen contract and silently dropped agentFire/trace/approval. This test
// pins the REAL pipeline: real createStore + real contract reducer + real rAF flush,
// driving the canonical fixture, projected through the real HudShell DOM mirror.
//
// It is deliberately store-level (not a full page render): page.tsx wires this exact
// store via useRunSession, and mounting the real store here proves the contract
// reducer is the one in play. If anyone reintroduces a demo reducer, the agentEvents
// / trace assertions below (which a phase/subtask/gate-only demo reducer fails) break.

import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { createStore } from "@/lib/store/store";
import { createRafFlusher } from "@/lib/store/raf-flush";
import { initialRunState } from "@/lib/contract/types";
import { dryRun } from "@/lib/contract/fixture";
import { HudShell } from "@/hud/HudShell";

// Deterministic frame pump: capture rAF callbacks and fire them on demand so a
// single "frame" runs exactly one flush (collapsing all buffered events).
function fakeRaf() {
  let queued: FrameRequestCallback[] = [];
  return {
    fns: {
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        queued.push(cb);
        return queued.length;
      },
      cancelAnimationFrame: () => {},
    },
    frame() {
      const due = queued;
      queued = [];
      for (const cb of due) cb(0);
    },
  };
}

describe("run session pipeline (real store × real reducer × real flush)", () => {
  it("projects the full dry run through the real contract reducer", () => {
    const store = createStore(initialRunState);
    const raf = fakeRaf();
    const flusher = createRafFlusher(store, raf.fns);

    render(<HudShell store={store} />);

    // Drive the whole canonical transcript, then flush once per frame.
    act(() => {
      flusher.start();
      for (const ev of dryRun) store.apply(ev);
      raf.frame(); // single flush drains the entire batch -> one commit
    });

    // DOM projection reflects the reducer-computed end state.
    expect(screen.getByTestId("mirror-task-id").textContent).toBe("run-fixture");
    expect(screen.getByTestId("mirror-phase-id").textContent).toBe("6"); // phase 6 active
    expect(screen.getByTestId("mirror-gate-count").textContent).toContain("CLEAR"); // both gates resolved
    expect(screen.getByTestId("mirror-subtask-st-a")).toBeInTheDocument();
    expect(screen.getByTestId("mirror-subtask-st-c")).toBeInTheDocument();

    // Store internals the OLD demo reducer dropped entirely — proves the real
    // contract reducer is wired: agentFire dedup/window (5 unique, none pruned)
    // and the trace ring buffer (5 ticks).
    const snap = store.getSnapshot();
    expect(snap.agentEvents).toHaveLength(5);
    expect(snap.trace).toHaveLength(5);

    flusher.stop();
  });

  it("notifies exactly once per flush, not once per applied event", () => {
    const store = createStore(initialRunState);
    const raf = fakeRaf();
    const flusher = createRafFlusher(store, raf.fns);

    let notifies = 0;
    store.subscribe(() => {
      notifies += 1;
    });

    flusher.start();
    for (const ev of dryRun) store.apply(ev); // buffer only — must not notify
    expect(notifies).toBe(0);

    raf.frame(); // one flush -> exactly one notify for the whole batch
    expect(notifies).toBe(1);

    flusher.stop();
  });
});
