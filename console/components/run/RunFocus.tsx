// console/components/run/RunFocus.tsx
// Run focus — the steering view (§4/§5): one run expanded, deep-linkable at
// /run/[id]. Same rAF-batched fleetStore + fleet SSE stream as fleet home (the
// daemon is the sole event source); this view just selects and renders one run.
// SSR renders the folded-fixture run (so a deep link/curl sees real content);
// hydration wires the live SSE stream for kinetic updates, same as FleetHome.
"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FleetState, GateId } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";
import { raisedGates, currentPhase } from "@/lib/contract/selectors";
import { deriveHealth } from "@/lib/contract/health";
import { PHASE_LABELS } from "@/lib/contract/types";
import { createFleetStore, type FleetStore } from "@/lib/store/fleetStore";
import { createSseClient, type ConnectionStatus } from "@/lib/sse/client";
import { fmtClock } from "@/lib/format";
import { HealthBadge } from "@/components/meters";
import { lookupRun } from "./selectRun";
import { PositionPanel } from "./PositionPanel";
import { GateCard } from "./GateCard";
import { LiveFeed } from "./LiveFeed";
import { BudgetPanel } from "./BudgetPanel";
import { computeStaleBanner, scheduleStaleTick } from "./staleness";
import { buildGateApproveEnvelopes, buildGateRejectEnvelopes, buildPromoteApproveEnvelopes, type ActionEnvelope } from "./gateActions";
import styles from "./RunFocus.module.css";

const nowSec = () => Math.floor(Date.now() / 1000);

// fmtClock renders in the LOCAL timezone; the server's tz rarely matches the
// browser's, so formatting it during SSR produces a hydration mismatch. Same
// hazard/fix as LiveFeed: stable placeholder pre-mount, real clock only after.
const CLOCK_PLACEHOLDER = "--:--:--";

export function RunFocus({ initial, runId }: { initial: FleetState; runId: string }) {
  const storeRef = useRef<FleetStore | null>(null);
  if (!storeRef.current) storeRef.current = createFleetStore(initial);
  const store = storeRef.current;

  const getServer = useCallback(() => initial, [initial]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, getServer);

  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  // Clock tick (§5): an open-but-silent feed never emits a new frame to trigger a
  // re-render on its own, so a 1s interval re-evaluates staleness against the wall
  // clock. See staleness.ts for the pure threshold logic this drives.
  const [now, setNow] = useState(nowSec);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // rAF flush loop — one commit + one notify per frame (same discipline as fleet home).
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      store.flush();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  // The fleet SSE stream is the sole event source; this view filters to one run.
  useEffect(() => {
    const client = createSseClient({
      url: "/api/fleet/stream",
      store,
      onStatusChange: setStatus,
    });
    return () => client.destroy();
  }, [store]);

  useEffect(() => scheduleStaleTick(() => setNow(nowSec())), []);

  const { run, notFound } = lookupRun(state, runId);

  const emitAll = useCallback(
    (envelopes: ActionEnvelope[], agentId = "operator") => {
      if (!run) return;
      for (const e of envelopes) {
        store.apply({ runId: run.runId, projectId: run.projectId, agentId, ts: nowSec(), type: e.type, payload: e.payload } as Envelope);
      }
    },
    [store, run]
  );
  // Gate-id-aware: approving/rejecting gate X emits ONLY an envelope for gate X —
  // never a blind phase-4 close, never touching any other gate. Structured via the
  // pure builders in gateActions.ts so a live bridge can route these later.
  const onApprove = useCallback(
    (gate: GateId) => {
      if (!run) return;
      const g = run.gates.find((x) => x.id === gate);
      if (g) emitAll(buildGateApproveEnvelopes(g));
    },
    [emitAll, run]
  );
  const onReject = useCallback(
    (gate: GateId) => {
      if (!run) return;
      const g = run.gates.find((x) => x.id === gate);
      if (g) emitAll(buildGateRejectEnvelopes(g));
    },
    [emitAll, run]
  );
  // Promote is its own action — never a disguised "approve gate A".
  const onPromote = useCallback(() => {
    if (!run) return;
    const phase = run.phases.find((p) => p.approval?.state === "awaiting");
    if (phase) emitAll(buildPromoteApproveEnvelopes(phase));
  }, [emitAll, run]);

  if (notFound || !run) {
    return (
      <main className={styles.shell}>
        <div className={styles.panel}>
          <div className="mono" style={{ fontSize: 13, color: "var(--fail)" }}>run not found</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 6 }}>
            No run with id <code>{runId}</code> in the fleet. <a href="/" style={{ color: "var(--info)" }}>Back to fleet home</a>.
          </div>
        </div>
      </main>
    );
  }

  // Freeze+badge (§5): stale from either an SSE drop OR the run itself going quiet
  // past the staleness window — never silently pretend liveness either way. A clean
  // "closed" status is terminal-but-not-stale (matches FleetHome's ConnectionPill).
  const banner = computeStaleBanner(run, now, status);
  // A cleanly closed stream is terminal — the run is over, silence is expected.
  // deriveHealth's own runIncomplete/silence→"stuck" rule doesn't know about the
  // feed's connection status, so freeze the clock it sees at the last real event
  // once the stream has closed cleanly; this keeps the "data as of" timestamp
  // informational without ever letting wall-clock silence escalate a closed
  // stream to stuck/degraded. See computeStaleBanner for the matching short-
  // circuit on the stale banner itself.
  const healthNow = status === "closed" ? run.lastEventTs : now;
  const verdict = deriveHealth({ run, nowSec: healthNow, feedStale: banner.feedStale });
  const gates = raisedGates(run);
  const promote = run.phases.find((p) => p.approval?.state === "awaiting");
  const cur = currentPhase(run);

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <a href="/" className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textDecoration: "none" }}>← fleet</a>
          <span className="display" style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>{run.projectName}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>{run.projectId} · {run.brief}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <HealthBadge verdict={verdict} />
          {banner.stale && (
            <span className="mono pulse" role="status" style={{ fontSize: 11, color: "var(--amber)" }}>
              ◐ {banner.reason === "reconnecting" ? "reconnecting" : "no events"} · data as of {mounted ? fmtClock(run.lastEventTs * 1000) : CLOCK_PLACEHOLDER}
            </span>
          )}
        </div>
      </header>

      <div className={styles.grid}>
        <div className={`${styles.position} ${styles.panel}`}>
          <PositionPanel run={run} />
        </div>

        <div className={styles.gates}>
          {gates.length === 0 && !promote && (
            <div className={styles.panel} style={{ fontSize: 12, color: "var(--text-faint)" }}>
              no gates raised · {cur}/6 {PHASE_LABELS[cur]}
            </div>
          )}
          {gates.map((g) => (
            <GateCard key={g.id} gate={g} onApprove={onApprove} onReject={onReject} />
          ))}
          {promote && (
            // Pending/interactive, not yet decided — amber, not green. Green (--live)
            // is reserved for genuine live/healthy signals; this is an awaiting action.
            <div className={styles.panel} style={{ background: "var(--amber-fill)", border: "1px solid var(--amber-line)" }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--amber)" }}>PROMOTE · awaiting</div>
              <div style={{ fontSize: 12, color: "var(--text)", margin: "4px 0 8px" }}>
                eval+promote ready — approve to fast-forward main
              </div>
              <button
                type="button"
                onClick={onPromote}
                style={{ padding: "5px 11px", borderRadius: 5, fontSize: 11, fontWeight: 600, cursor: "pointer", color: "var(--amber)", background: "transparent", border: "1px solid var(--amber)" }}
              >
                Approve promote
              </button>
            </div>
          )}
        </div>

        <div className={`${styles.feed} ${styles.panel}`}>
          <LiveFeed run={run} />
        </div>

        <div className={`${styles.budget} ${styles.panel}`}>
          <BudgetPanel run={run} />
        </div>
      </div>
    </main>
  );
}
