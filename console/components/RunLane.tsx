// console/components/RunLane.tsx
// One fleet lane: project name (display face) · phase rail · health verdict ·
// gate/alert strip (inline gate card w/ approve/reject) · mini burn meter.
// Click/Enter selects the run (focus route is Batch B+ — here it calls onSelect).
"use client";

import type { RunState, GateId } from "@/lib/contract/types";
import { deriveHealth } from "@/lib/contract/health";
import { subtaskCounts, raisedGates, currentPhase } from "@/lib/contract/selectors";
import { PHASE_LABELS } from "@/lib/contract/types";
import { PhaseRail } from "./PhaseRail";
import { BurnMeter, HealthBadge } from "./meters";

interface Props {
  run: RunState;
  feedStale: boolean;
  selected?: boolean;
  onSelect: (runId: string) => void;
  onApprove: (runId: string, gate: GateId) => void;
  onReject: (runId: string, gate: GateId) => void;
}

export function RunLane({ run, feedStale, selected, onSelect, onApprove, onReject }: Props) {
  const verdict = deriveHealth({ run, nowSec: run.lastEventTs, feedStale });
  const counts = subtaskCounts(run);
  const gates = raisedGates(run);
  const cur = currentPhase(run);
  const promote = run.phases.find((p) => p.approval?.state === "awaiting");

  return (
    <section
      aria-label={`run ${run.projectName}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: "var(--radius)",
        background: "var(--surface-1)",
        border: `1px solid ${gates.length ? "var(--fail)" : selected ? "var(--amber)" : "var(--border)"}`,
        minWidth: 0,
      }}
    >
      {/* header: project name (display) + health */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <button
          type="button"
          onClick={() => onSelect(run.runId)}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left", minWidth: 0 }}
        >
          <div className="display" style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", lineHeight: 1.05, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {run.projectName}
          </div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {run.projectId} · {run.brief}
          </div>
        </button>
        <HealthBadge verdict={verdict} />
      </div>

      {/* phase rail + position label */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <PhaseRail run={run} size="lane" />
        <div className="mono" style={{ fontSize: 10, color: "var(--amber)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          {cur}/6 · {PHASE_LABELS[cur]}
          <span style={{ color: "var(--text-faint)" }}>
            {"  "}build {counts.building} · done {counts.done} · pend {counts.pending}
            {counts.blocked ? ` · blocked ${counts.blocked}` : ""}
          </span>
        </div>
      </div>

      {/* gate/alert strip — inline gate card (approve/reject wired to store actions) */}
      {gates.map((g) => (
        <div key={g.id} role="alert" style={{ padding: 8, borderRadius: 6, background: "var(--fail-fill)", border: "1px solid var(--fail)" }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--fail)" }}>GATE {g.id} · {g.severity}</div>
          <div style={{ fontSize: 12, color: "var(--text)", margin: "3px 0 7px" }}>{g.summary}</div>
          <div style={{ display: "flex", gap: 6 }}>
            <ActionBtn kind="ok" label="Approve" onClick={() => onApprove(run.runId, g.id)} />
            <ActionBtn kind="danger" label="Reject" onClick={() => onReject(run.runId, g.id)} />
          </div>
        </div>
      ))}

      {/* promote-to-main awaiting (green pulse — success-adjacent, healthy path) */}
      {promote && (
        <div style={{ padding: 8, borderRadius: 6, background: "var(--live-fill)", border: "1px solid var(--live)" }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--live)" }}>PROMOTE · awaiting</div>
          <div style={{ fontSize: 12, color: "var(--text)", margin: "3px 0 7px" }}>eval+promote ready — approve to fast-forward main</div>
          <ActionBtn kind="ok" label="Approve promote" onClick={() => onApprove(run.runId, "A")} />
        </div>
      )}

      <BurnMeter run={run} />
    </section>
  );
}

function ActionBtn({ kind, label, onClick }: { kind: "ok" | "danger"; label: string; onClick: () => void }) {
  // Interactive affordance → amber. Green (--live) is STRICTLY a live/healthy signal,
  // never a button; amber owns every interactive/interface element (approve included).
  const color = kind === "ok" ? "var(--amber)" : "var(--fail)";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 10px",
        borderRadius: 5,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        color,
        background: "transparent",
        border: `1px solid ${color}`,
      }}
    >
      {label}
    </button>
  );
}
