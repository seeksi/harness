// console/components/deck/EvalPanel.tsx
// Eval results panel — regression pass/fail + capability score for the selected run
// (§4/§6, straight off RunState.evals; source of truth = eval-gate output). A run
// that hasn't reached phase 6 yet has no verdict — render "—", not a fake 0/fail.
"use client";

import type { RunState } from "@/lib/contract/types";

export function EvalPanel({ run }: { run: RunState }) {
  const evals = run.evals;
  return (
    <div role="region" aria-label="eval results" style={{ padding: 14, borderRadius: "var(--radius)", background: "var(--surface-1)", border: "1px solid var(--border)" }}>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
        eval results — {run.projectName}
      </div>
      {!evals ? (
        <div style={{ color: "var(--text-faint)", fontSize: 12 }}>— not yet reported (eval+promote hasn&apos;t run)</div>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
          <span
            className="mono"
            style={{
              padding: "2px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              color: evals.regressionPass ? "var(--live)" : "var(--fail)",
              background: evals.regressionPass ? "var(--live-fill)" : "var(--fail-fill)",
              border: `1px solid ${evals.regressionPass ? "var(--live)" : "var(--fail)"}`,
            }}
          >
            regression {evals.regressionPass ? "PASS" : "FAIL"}
          </span>
          <span className="mono" style={{ fontSize: 13, color: "var(--amber)" }}>
            capability {(evals.capabilityScore * 100).toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
}
