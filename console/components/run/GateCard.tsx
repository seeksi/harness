// console/components/run/GateCard.tsx
// Inline gate card, run-focus flavor: id A-D, what's blocked, evidence links
// (diff/trace/eval), amber approve / red reject with confirm-on-destructive.
// RunLane (fleet home) renders a terser inline version with no evidence links
// and no confirm step; this is the focus-size extension the spec calls for, not
// a fork of it — same gate id/severity/summary vocabulary, same amber/red rule.
"use client";

import { useState } from "react";
import Link from "next/link";
import type { Gate, GateId } from "@/lib/contract/types";
import { deckRunRoute } from "@/lib/routes";
import { armOrConfirmReject, isArmed, type GateConfirmState } from "./gateActions";

interface Props {
  gate: Gate;
  runId: string; // the deck target for this gate's evidence links (§4 drill-through)
  onApprove: (gate: GateId) => void;
  onReject: (gate: GateId) => void;
}

export function GateCard({ gate, runId, onApprove, onReject }: Props) {
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
        <div style={{ display: "flex", gap: 10, marginBottom: 9, flexWrap: "wrap" }}>
          {evidenceLinks.map((k) => (
            // The deck (run-scoped) is now a real target for this gate's evidence —
            // link into it instead of a plain label (§4 drill-through). The deck
            // itself is where the diff/trace/eval this cites gets inspected.
            <Link
              key={k}
              href={deckRunRoute(runId)}
              className="mono"
              style={{ fontSize: 11, color: "var(--info)", textDecoration: "underline" }}
              title={`open ${k} in the observability deck`}
            >
              {k}: {evidence[k]}
            </Link>
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
