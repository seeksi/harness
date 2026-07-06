// console/components/FleetHome.tsx
// Fleet home (default route) — the operating seat. Owns the rAF-batched fleet store,
// the SSE connection, and the launch/palette/gate store actions. SSR renders the
// folded-fixture lanes (so `curl` sees them); on hydration the SSE stream drives the
// kinetic live updates. Full-parity single-column stack under 1024px (CSS).
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FleetState, GateId, RunState } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";
import { newRun } from "@/lib/contract/types";
import { activeLanes, laneOrder, totalTokens } from "@/lib/contract/selectors";
import { createFleetStore, type FleetStore } from "@/lib/store/fleetStore";
import { createSseClient, type ConnectionStatus } from "@/lib/sse/client";
import { fmtTokens, fmtClock } from "@/lib/format";
import { RunLane } from "./RunLane";
import { OpsBoard } from "./OpsBoard";
import { LaunchConsole, type LaunchPayload, type LaunchProject } from "./LaunchConsole";
import { CommandPalette } from "./CommandPalette";

const nowSec = () => Math.floor(Date.now() / 1000);

export function FleetHome({ initial, projects }: { initial: FleetState; projects: LaunchProject[] }) {
  const storeRef = useRef<FleetStore | null>(null);
  if (!storeRef.current) storeRef.current = createFleetStore(initial);
  const store = storeRef.current;

  const getServer = useCallback(() => initial, [initial]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, getServer);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [lastEventMs, setLastEventMs] = useState<number>(Date.now());
  const [launchOpen, setLaunchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // rAF flush loop — the single notification path (one commit + one notify / frame).
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      store.flush();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  // SSE — kinetic live stream (reconnect + gapless replay handled in the client).
  useEffect(() => {
    const client = createSseClient({
      url: "/api/fleet/stream",
      store,
      onStatusChange: setStatus,
      onEventTime: setLastEventMs,
    });
    return () => client.destroy();
  }, [store]);

  // ⌘K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // --- store actions (build envelopes, apply into the store) ---------------------
  const emit = useCallback(
    (run: RunState, type: Envelope["type"], payload: unknown, agentId = "operator") => {
      store.apply({ runId: run.runId, projectId: run.projectId, agentId, ts: nowSec(), type, payload } as Envelope);
    },
    [store]
  );
  const runById = useCallback((id: string) => store.getSnapshot().runs[id], [store]);

  const onApprove = useCallback(
    (runId: string, gate: GateId) => {
      const run = runById(runId);
      if (!run) return;
      const g = run.gates.find((x) => x.id === gate);
      if (g) emit(run, "gate", { id: gate, status: "approved", severity: g.severity, summary: `${g.summary} — approved` });
      // clear a blocked phase + mark promote approved
      emit(run, "phase", { phase: 4, status: "done" });
      const promote = run.phases.find((p) => p.approval?.state === "awaiting");
      if (promote) emit(run, "phase", { phase: promote.id, status: "done", approval: { kind: "promote-to-main", state: "approved" } });
    },
    [emit, runById]
  );
  const onReject = useCallback(
    (runId: string, gate: GateId) => {
      const run = runById(runId);
      if (!run) return;
      const g = run.gates.find((x) => x.id === gate);
      if (g) emit(run, "gate", { id: gate, status: "rejected", severity: g.severity, summary: `${g.summary} — rejected` });
      emit(run, "health", { verdict: "degraded", note: `Gate ${gate} rejected` });
    },
    [emit, runById]
  );
  const onAbort = useCallback(
    (runId: string) => {
      const run = runById(runId);
      if (run) emit(run, "health", { verdict: "stuck", note: "aborted by operator", lifecycle: "failed" });
    },
    [emit, runById]
  );
  const onLaunch = useCallback(
    (p: LaunchPayload) => {
      // Local optimistic launch — a fresh run in decompose. ponytail: real harness.sh
      // spawn (POST /api/runs → daemon) lands with the live bridge (Batch B+).
      const runId = `run-${Date.now()}`;
      const run = newRun(runId, p.projectId, p.projectName, p.brief, nowSec());
      store.apply({ runId, projectId: p.projectId, agentId: "operator", ts: nowSec(), type: "sync", payload: { run } });
      store.apply({ runId, projectId: p.projectId, agentId: "orchestrator", ts: nowSec(), type: "phase", payload: { phase: 1, status: "active" } });
      setSelected(runId);
    },
    [store]
  );

  const feedStale = status === "reconnecting";
  const lanes = activeLanes(state);
  const allRuns = laneOrder(state);
  const fleetTokens = useMemo(() => allRuns.reduce((sum, r) => sum + totalTokens(r), 0), [allRuns]);

  return (
    <main className="console-shell">
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span className="display" style={{ fontSize: 24, fontWeight: 700, color: "var(--amber)", letterSpacing: "0.04em" }}>HARNESS</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>mission control</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--amber)" }}>{fmtTokens(fleetTokens)} tok · {lanes.length}/3 lanes</span>
          <ConnectionPill status={status} lastEventMs={lastEventMs} />
          <button type="button" onClick={() => setPaletteOpen(true)} className="mono" style={pillBtn}>⌘K</button>
          <button type="button" onClick={() => setLaunchOpen(true)} style={{ ...pillBtn, color: "var(--bg)", background: "var(--amber)", border: "1px solid var(--amber)", fontWeight: 600 }}>Launch</button>
        </div>
      </header>

      {lanes.length > 0 ? (
        <div className="lanes">
          {lanes.map((run) => (
            <RunLane
              key={run.runId}
              run={run}
              feedStale={feedStale}
              selected={selected === run.runId}
              onSelect={setSelected}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </div>
      ) : (
        <OpsBoard projectCount={projects.length} onLaunch={() => setLaunchOpen(true)} />
      )}

      {/* discovered project registry */}
      <section aria-label="discovered projects">
        <div className="mono" style={{ marginTop: 26, marginBottom: 4, fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
          Fleet registry — {projects.length} project{projects.length === 1 ? "" : "s"}
        </div>
        <div className="cards">
          {projects.length === 0 && (
            <div style={{ padding: 16, borderRadius: 8, border: "1px dashed var(--border)", color: "var(--text-faint)", fontSize: 12 }}>
              No projects discovered on the named roots. Set HARNESS_PROJECT_ROOTS.
            </div>
          )}
          {projects.map((p) => (
            <div key={p.id} style={{ padding: 14, borderRadius: 8, background: "var(--surface-1)", border: "1px solid var(--border)" }}>
              <div className="display" style={{ fontSize: 16, color: "var(--text)" }}>{p.name}</div>
              <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.id}</div>
            </div>
          ))}
        </div>
      </section>

      <LaunchConsole open={launchOpen} projects={projects} onClose={() => setLaunchOpen(false)} onLaunch={(p) => { onLaunch(p); setLaunchOpen(false); }} />
      <CommandPalette
        open={paletteOpen}
        runs={allRuns}
        onClose={() => setPaletteOpen(false)}
        onSelect={setSelected}
        onApprove={onApprove}
        onAbort={onAbort}
        onLaunch={() => setLaunchOpen(true)}
      />
    </main>
  );
}

function ConnectionPill({ status, lastEventMs }: { status: ConnectionStatus; lastEventMs: number }) {
  // §5 degraded behavior: on drop, freeze + "data as of hh:mm:ss" + reconnecting.
  if (status === "open" || status === "connecting") {
    return <span className="mono breathe" style={{ fontSize: 11, color: "var(--live)" }}>● {status === "open" ? "live" : "connecting"}</span>;
  }
  if (status === "reconnecting") {
    return <span className="mono pulse" style={{ fontSize: 11, color: "var(--amber)" }}>◐ reconnecting · data as of {fmtClock(lastEventMs)}</span>;
  }
  return <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>○ closed · data as of {fmtClock(lastEventMs)}</span>;
}

const pillBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  color: "var(--text)",
  background: "var(--surface-2)",
  border: "1px solid var(--border-bright)",
};
