// web/app/page.tsx — Lane C sole writer.
// The two-state screen: idle submit ⇄ running pipeline.
// This increment: mounts the DOM mirror + live regions for the running state,
// using a test-double store driven by the fixture dry run (until Lane A's SSE
// stream arrives and the real store merges from Lane B).
//
// The 3D <Canvas> is Lane B's; referenced here only as a ponytail placeholder.
// Do NOT import scene/** — lint boundary (.eslintrc.json zones) forbids it.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HudShell } from "@/hud/HudShell";
import { dryRun } from "@/lib/contract/fixture";
import { initialRunState } from "@/lib/contract/types";
import type { RunStore } from "@/lib/contract/store";
import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";

// ── Local minimal store (dry-run demo, no Lane B dependency) ──────────────────
// Implements the RunStore interface using a simple in-memory approach.
// The reducer is stubbed locally: hello replaces, other events merge minimally.
// Replace with the real store import after Lane B merges.
function makeDemoStore(initial: RunState): RunStore {
  let state = initial;
  const listeners = new Set<() => void>();
  let pending: RunState | null = null;

  function applyEvent(ev: SSEEvent): RunState {
    if (ev.type === "hello") return ev.run;

    const s = { ...state };
    if (ev.type === "phase") {
      s.phases = s.phases.map((p) =>
        p.id === ev.phase ? { ...p, status: ev.status } : p
      );
    } else if (ev.type === "subtask") {
      const exists = s.subtasks.find((t) => t.id === ev.id);
      if (exists) {
        s.subtasks = s.subtasks.map((t) =>
          t.id === ev.id
            ? { ...t, status: ev.status, ...(ev.phase && { phase: ev.phase }), ...(ev.model && { model: ev.model }) }
            : t
        );
      } else {
        s.subtasks = [
          ...s.subtasks,
          { id: ev.id, title: ev.id, status: ev.status, phase: ev.phase ?? 1, ownerFiles: [], ...(ev.model && { model: ev.model }) },
        ];
      }
    } else if (ev.type === "gate") {
      const exists = s.gates.find((g) => g.id === ev.id);
      if (exists) {
        s.gates = s.gates.map((g) =>
          g.id === ev.id
            ? { ...g, status: ev.status, severity: ev.severity, summary: ev.summary, ...(ev.subtaskId && { subtaskId: ev.subtaskId }), ...(ev.counts && { counts: ev.counts }), ...(ev.traceReady !== undefined && { traceReady: ev.traceReady }) }
            : g
        );
      } else {
        s.gates = [
          ...s.gates,
          { id: ev.id, status: ev.status, severity: ev.severity, summary: ev.summary, ...(ev.subtaskId && { subtaskId: ev.subtaskId }), ...(ev.counts && { counts: ev.counts }), ...(ev.traceReady !== undefined && { traceReady: ev.traceReady }) },
        ];
      }
    } else if (ev.type === "budget") {
      s.budget = { ceilingUsd: ev.ceilingUsd, estimatedUsd: ev.estimatedUsd, ...(ev.spentUsd !== undefined && { spentUsd: ev.spentUsd }), ...(ev.overBy !== undefined && { overBy: ev.overBy }) };
    }
    // trace, agentFire, approval, unknown → ignored for demo store
    return s;
  }

  return {
    getSnapshot(): RunState { return state; },
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    apply(ev: SSEEvent) {
      pending = applyEvent(ev);
    },
    flush() {
      if (pending !== null) {
        state = pending;
        pending = null;
        listeners.forEach((cb) => cb());
      }
    },
  };
}

// ── Page component ────────────────────────────────────────────────────────────

export default function Page() {
  const store = useMemo(() => makeDemoStore(initialRunState), []);
  const [started, setStarted] = useState(false);
  const rafRef = useRef<number | null>(null);

  // Simulate rAF flush loop (Lane B's raf-flush.ts provides this in production).
  useEffect(() => {
    if (!started) return;
    let running = true;
    function loop() {
      if (!running) return;
      store.flush();
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [store, started]);

  // Play the dry-run fixture when "Start" is clicked.
  function startDryRun() {
    setStarted(true);
    let i = 0;
    function step() {
      if (i >= dryRun.length) return;
      store.apply(dryRun[i]);
      i += 1;
      setTimeout(step, 120);
    }
    step();
  }

  if (!started) {
    return (
      <main>
        <h1>Umbrella — idle</h1>
        <p>Harness four-phase agent build pipeline.</p>
        <button onClick={startDryRun} type="button">
          Start dry run
        </button>
        {/*
          ponytail: idle submit form (task brief textarea + POST /runs) — add when
          Lane A's control-plane API merges.
        */}
      </main>
    );
  }

  return (
    <main>
      {/*
        ponytail: <Canvas> 3D holographic scene — Lane B's scene/Canvas.tsx mounts
        here via dynamic import after B merges to integration. Do NOT import
        scene/** directly (lint boundary enforced). Example:
          const SceneCanvas = dynamic(() => import("@/scene/Canvas"), { ssr: false });
        ponytail: glass HUD overlays (InboxRail, ⌘K, ApprovalStep, toast) — later increment.
      */}
      <HudShell store={store} />
    </main>
  );
}
