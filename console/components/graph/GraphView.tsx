// console/components/graph/GraphView.tsx
// The graph route's client shell: owns the fleet store + SSE (same pattern as
// FleetHome), scopes it down to one project's runs, folds their trace into the
// activity-driven progressive-disclosure graph (model.ts), and renders the canvas
// + showpiece toggle + node inspector. `nowSec` for activity classification is the
// project's own latest event time (matching health.ts's convention — the fixture is
// frozen in the past, so "now" tracks the data, not the wall clock, until the live
// bridge lands).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FleetState } from "@/lib/contract/types";
import { createFleetStore, type FleetStore } from "@/lib/store/fleetStore";
import { createSseClient, type ConnectionStatus } from "@/lib/sse/client";
import { fmtClock } from "@/lib/format";
import { buildGraph, computeLayout, summarizeActivity, type RosterAgent } from "./model";
import { GraphCanvas } from "./GraphCanvas";
import { Inspector } from "./Inspector";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface GraphViewProps {
  initial: FleetState;
  projectId: string;
  projectName: string;
  rosterAgents: RosterAgent[];
}

export function GraphView({ initial, projectId, projectName, rosterAgents }: GraphViewProps) {
  const storeRef = useRef<FleetStore | null>(null);
  if (!storeRef.current) storeRef.current = createFleetStore(initial);
  const store = storeRef.current;

  const getServer = useCallback(() => initial, [initial]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, getServer);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEventMs, setLastEventMs] = useState<number>(Date.now());
  const [showpiece, setShowpiece] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      store.flush();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  useEffect(() => {
    const client = createSseClient({ url: "/api/fleet/stream", store, onStatusChange: setStatus, onEventTime: setLastEventMs });
    return () => client.destroy();
  }, [store]);

  const reducedMotion = usePrefersReducedMotion();

  // This project's runs, its merged trace stream, and its "now" reference.
  const projectRuns = useMemo(() => Object.values(state.runs).filter((r) => r.projectId === projectId), [state, projectId]);
  const traces = useMemo(() => projectRuns.flatMap((r) => r.trace), [projectRuns]);
  const nowSec = useMemo(
    () => (projectRuns.length ? Math.max(...projectRuns.map((r) => r.lastEventTs)) : Math.floor(Date.now() / 1000)),
    [projectRuns]
  );

  const activity = useMemo(() => summarizeActivity(traces), [traces]);
  const graph = useMemo(
    () => buildGraph({ rosterAgents, activity, traces, nowSec, showpiece }),
    [rosterAgents, activity, traces, nowSec, showpiece]
  );

  // Layout world-size tracks the actual rendered area so the ring fits the visible
  // viewport by default (pan/zoom still works — this just sets the un-panned frame).
  const graphAreaRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 1200, h: 700 });
  useEffect(() => {
    const el = graphAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) setCanvasSize({ w: box.width, h: box.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => computeLayout(graph.nodes, canvasSize.w, canvasSize.h), [graph.nodes, canvasSize]);

  // Phase-transition punctuation: bump a counter whenever the count of DONE phases
  // across this project's runs increases. Rare event — a re-render here is cheap
  // and it's the only thing that needs to reach the canvas as a "fire once" prop.
  const doneCount = useMemo(() => projectRuns.reduce((sum, r) => sum + r.phases.filter((p) => p.status === "done").length, 0), [projectRuns]);
  const prevDoneRef = useRef(doneCount);
  const [punctuationSeq, setPunctuationSeq] = useState(0);
  useEffect(() => {
    if (doneCount > prevDoneRef.current) setPunctuationSeq((s) => s + 1);
    prevDoneRef.current = doneCount;
  }, [doneCount]);

  const selectedNode = graph.nodes.find((n) => n.id === selectedId) ?? null;
  const selectedActivity = selectedId ? activity.get(selectedId) : undefined;

  const feedStale = status === "reconnecting";

  return (
    <main className="console-shell">
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <span className="display" style={{ fontSize: 24, fontWeight: 700, color: "var(--amber)", letterSpacing: "0.04em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {projectName}
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>workflow graph</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <ConnectionPill status={status} lastEventMs={lastEventMs} />
          <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} edge{graph.edges.length === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={() => setShowpiece((v) => !v)}
            aria-pressed={showpiece}
            className="mono"
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              color: showpiece ? "var(--bg)" : "var(--amber)",
              background: showpiece ? "var(--amber)" : "transparent",
              border: "1px solid var(--amber)",
            }}
          >
            {showpiece ? "Showpiece · full swarm" : "Show full swarm"}
          </button>
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, alignItems: "start" }}>
        <div ref={graphAreaRef} style={{ height: "70vh", minHeight: 420 }}>
          <GraphCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            layout={layout}
            reducedMotion={reducedMotion}
            selectedId={selectedId}
            onSelect={setSelectedId}
            punctuationSeq={punctuationSeq}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Legend />
          <Inspector node={selectedNode} activity={selectedActivity} feedStale={feedStale} onClose={() => setSelectedId(null)} />
        </div>
      </div>

      {graph.nodes.length === 0 && (
        <div style={{ marginTop: 14, padding: 16, borderRadius: 8, border: "1px dashed var(--border-bright)", color: "var(--text-faint)", fontSize: 12 }}>
          No agent roster or activity observed yet for this project — the graph fills in as runs report agentEvents.
        </div>
      )}
    </main>
  );
}

function Legend() {
  const row = (color: string, label: string, cls?: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className={cls} style={{ width: 10, height: 10, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: "var(--radius)", background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.08em" }}>Legend</div>
      {row("var(--amber)", "active — working now", "pulse")}
      {row("var(--amber-rest)", "recent — active in the last 90s")}
      {row("var(--surface-1)", "idle — collapsed into its niche group")}
      {row("var(--live)", "phase-complete punctuation")}
    </div>
  );
}

function ConnectionPill({ status, lastEventMs }: { status: ConnectionStatus; lastEventMs: number }) {
  if (status === "open" || status === "connecting") {
    return <span className="mono breathe" style={{ fontSize: 11, color: "var(--live)" }}>● {status === "open" ? "live" : "connecting"}</span>;
  }
  if (status === "reconnecting") {
    return <span className="mono pulse" style={{ fontSize: 11, color: "var(--amber)" }}>◐ reconnecting · data as of {fmtClock(lastEventMs)}</span>;
  }
  return <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>○ closed · data as of {fmtClock(lastEventMs)}</span>;
}
