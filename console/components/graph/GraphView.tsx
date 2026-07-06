// console/components/graph/GraphView.tsx
// The graph route's client shell: owns the fleet store + SSE (same pattern as
// FleetHome), scopes it down to one project's runs, folds their trace into the
// activity-driven progressive-disclosure graph (model.ts), and renders the canvas
// + showpiece toggle + node inspector. `nowSec` for activity classification tracks
// the greater of (a) the project's own latest event time (matching health.ts's
// convention) and (b) a client-only 1s-tick clock seeded from that same data — so a
// frozen fixture still classifies correctly, but activity also decays in real time
// once no new events arrive, instead of staying pinned to the last event forever.
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FleetState } from "@/lib/contract/types";
import { createFleetStore, type FleetStore } from "@/lib/store/fleetStore";
import { createSseClient, type ConnectionStatus } from "@/lib/sse/client";
import { fmtClock } from "@/lib/format";
import { buildGraph, computeLayout, summarizeActivity, type RosterAgent } from "./model";
import { GraphCanvas } from "./GraphCanvas";
import { Inspector } from "./Inspector";

// Last path segment, without pulling in the "path" module (this file is client-only
// and browser bundles don't get node's fs/path polyfills for free). Discovery ids
// are opaque slash-free slugs now (discovery.ts's slugFor), so this is a no-op for
// them; it stays as a defensive fallback for any pre-migration/legacy projectId
// that was stamped from an absolute path before that change.
function basename(id: string): string {
  const i = Math.max(id.lastIndexOf("/"), id.lastIndexOf("\\"));
  return i === -1 ? id : id.slice(i + 1);
}

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
  // The resolved project's canonical (discovery) id, when it differs from the route
  // slug — see [projectId]/page.tsx. Runs are matched against either.
  canonicalProjectId?: string;
  projectName: string;
  rosterAgents: RosterAgent[];
}

export function GraphView({ initial, projectId, canonicalProjectId, projectName, rosterAgents }: GraphViewProps) {
  const storeRef = useRef<FleetStore | null>(null);
  if (!storeRef.current) storeRef.current = createFleetStore(initial);
  const store = storeRef.current;

  const getServer = useCallback(() => initial, [initial]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, getServer);

  // The route slug (basename) and the run's own projectId (often the canonical
  // absolute discovery id) can legitimately differ — see [projectId]/page.tsx.
  // Match on either, plus a basename fallback, so live runs for a project whose
  // id isn't the slug still show up instead of silently vanishing.
  const matchesProject = useCallback(
    (pid: string) => pid === projectId || pid === canonicalProjectId || basename(pid) === projectId,
    [projectId, canonicalProjectId]
  );

  // Deterministic seed for both the "now" clock and the connection pill's
  // lastEventMs — derived from the server-rendered `initial` data's own event
  // times (never Date.now() at render — that's a hydration/determinism hazard).
  const seedNowSec = useMemo(() => {
    const seedRuns = Object.values(initial.runs).filter((r) => matchesProject(r.projectId));
    return seedRuns.length ? Math.max(...seedRuns.map((r) => r.lastEventTs)) : 0;
  }, [initial, matchesProject]);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEventMs, setLastEventMs] = useState<number>(() => seedNowSec * 1000);
  const [showpiece, setShowpiece] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reducedMotion = usePrefersReducedMotion();
  // The rAF loop is a continuous per-frame wakeup even under prefers-reduced-motion
  // (only the canvas's own loop stops for that) — read via ref inside the SSE
  // handler below so a runtime media-query flip doesn't need to re-open the stream.
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    if (reducedMotion) return; // flushed on SSE arrival instead — see below.
    let raf = 0;
    const loop = () => {
      store.flush();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store, reducedMotion]);

  useEffect(() => {
    const client = createSseClient({
      url: "/api/fleet/stream",
      store,
      onStatusChange: setStatus,
      onEventTime: (ms) => {
        setLastEventMs(ms);
        // No rAF loop running under reduced motion — flush right on arrival instead
        // of polling, so buffered envelopes never sit unflushed indefinitely.
        if (reducedMotionRef.current) store.flush();
      },
    });
    return () => client.destroy();
  }, [store]);

  // This project's runs, its merged trace stream, and its "now" reference.
  const projectRuns = useMemo(() => Object.values(state.runs).filter((r) => matchesProject(r.projectId)), [state, matchesProject]);
  const traces = useMemo(() => projectRuns.flatMap((r) => r.trace), [projectRuns]);

  // Wall-clock reference for activity classification: seeded once (above) from
  // `initial`, then ticks forward one second at a time via a client-only interval
  // (same owns-its-loop-in-an-effect shape as the rAF flush loop above) so
  // active/recent/idle decay in real time even when no new events arrive.
  const [clockSec, setClockSec] = useState(seedNowSec);
  useEffect(() => {
    const id = setInterval(() => setClockSec((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const latestProjectEventTs = useMemo(
    () => (projectRuns.length ? Math.max(...projectRuns.map((r) => r.lastEventTs)) : 0),
    [projectRuns]
  );
  // Live events can carry wall-clock timestamps far ahead of the seeded clockSec
  // (e.g. a frozen fixture seed vs. a real SSE stream's real-time epoch). Without
  // this, nowSec below pins at the last event ts forever — clockSec's 1s ticks can
  // never catch up — so activity never decays. Re-seed clockSec whenever an
  // observed event ts exceeds it, so the interval keeps ticking forward from live
  // time instead of stale seed time.
  useEffect(() => {
    setClockSec((s) => (latestProjectEventTs > s ? latestProjectEventTs : s));
  }, [latestProjectEventTs]);
  const nowSec = useMemo(() => Math.max(clockSec, latestProjectEventTs), [clockSec, latestProjectEventTs]);

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

      <div className="graph-grid" style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 14, alignItems: "start" }}>
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

      {/* Phone restack (§5): single-column below 1024px, canvas first (same hierarchy
          order as desktop — spectacle first), legend/inspector stacked below it. The
          canvas itself is touch-driven already (GraphCanvas's Pointer Events unify
          mouse + touch pan/zoom/pinch/tap). */}
      <style>{`
        @media (max-width: 1024px) {
          .graph-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
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
  // §3 token rule: green (var(--live)) is reserved for actually open/live — never
  // for "connecting", which hasn't reached live yet. Amber/dim instead.
  if (status === "open") {
    return <span className="mono breathe" style={{ fontSize: 11, color: "var(--live)" }}>● live</span>;
  }
  if (status === "connecting") {
    return <span className="mono pulse" style={{ fontSize: 11, color: "var(--amber-rest)" }}>◐ connecting</span>;
  }
  if (status === "reconnecting") {
    return <span className="mono pulse" style={{ fontSize: 11, color: "var(--amber)" }}>◐ reconnecting · data as of {fmtClock(lastEventMs)}</span>;
  }
  return <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>○ closed · data as of {fmtClock(lastEventMs)}</span>;
}
