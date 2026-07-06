// console/components/run/GateCard.tsx
// Inline gate card, run-focus flavor: id A-D, what's blocked, evidence links
// (diff/trace/eval), amber approve / red reject with confirm-on-destructive.
// RunLane (fleet home) renders a terser inline version with no evidence links
// and no confirm step; this is the focus-size extension the spec calls for, not
// a fork of it — same gate id/severity/summary vocabulary, same amber/red rule.
"use client";

import { useState } from "react";
import type { Gate, GateId } from "@/lib/contract/types";
import { armOrConfirmReject, isArmed, type GateConfirmState } from "./gateActions";

interface Props {
  gate: Gate;
  onApprove: (gate: GateId) => void;
  onReject: (gate: GateId) => void;
}

export function GateCard({ gate, onApprove, onReject }: Props) {
  const [confirm, setConfirm] = useState<GateConfirmState>(null);
  const armed = isArmed(confirm, gate.id);

  function handleReject() {
    const { next, confirmed } = armOrConfirmReject(confirm, gate.id);
    setConfirm(next);
    if (confirmed) onReject(gate.id);
  }

  const evidence = gate.evidence ?? {};
  const evidenceLinks = (["diff", "trace", "eval"] as const).filter((k) => evidence[k]);

  return (
    <div
      role="alert"
      aria-label={`gate ${gate.id}`}
      style={{ padding: 12, borderRadius: 8, background: "var(--fail-fill)", border: "1px solid var(--fail)" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="mono" style={{ fontSize: 12, color: "var(--fail)", letterSpacing: "0.04em" }}>
          GATE {gate.id} · {gate.severity}
        </span>
        {gate.raisedAt !== undefined && (
          <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>raised</span>
        )}
      </div>
      <div style={{ fontSize: 13, color: "var(--text)", margin: "5px 0 8px" }}>{gate.summary}</div>

      {evidenceLinks.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 9 }}>
          {evidenceLinks.map((k) => (
            // Plain label, not a link: these have no real target yet (the deck view
            // that provides one lands in a later lane) — a dead `#` anchor would be
            // a false affordance.
            <span key={k} className="mono" style={{ fontSize: 11, color: "var(--info)" }}>
              {k}: {evidence[k]}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" onClick={() => onApprove(gate.id)} style={btnStyle("var(--amber)")}>
          Approve
        </button>
        <button
          type="button"
          onClick={handleReject}
          style={btnStyle("var(--fail)")}
          aria-pressed={armed}
        >
          {armed ? "Confirm reject?" : "Reject"}
        </button>
        {armed && (
          <button type="button" onClick={() => setConfirm(null)} style={{ ...btnStyle("var(--text-faint)"), border: "1px solid var(--border-bright)" }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function btnStyle(color: string): React.CSSProperties {
  return {
    padding: "5px 11px",
    borderRadius: 5,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    color,
    background: "transparent",
    border: `1px solid ${color}`,
  };
}
