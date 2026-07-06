// console/components/run/BudgetPanel.tsx
// Token-primary budget (§6: tokens primary, $ secondary/derived) + per-lane
// context-fill meters at the existing soft-60%/hard-75% thresholds. Reuses the
// run-level BurnMeter (fleet-lane component) for the run total, then adds the
// per-lane breakdown the focus view needs that the lane-size component doesn't.
"use client";

import type { RunState } from "@/lib/contract/types";
import { CONTEXT_SOFT, CONTEXT_HARD } from "@/lib/contract/types";
import { fmtTokens, fmtUsd, fmtPct } from "@/lib/format";
import { BurnMeter } from "@/components/meters";

export function BudgetPanel({ run }: { run: RunState }) {
  const lanes = Object.entries(run.usage.lanes);
  return (
    <section aria-label="budget" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        Budget — {fmtTokens(run.usage.totalTokens)} tok · {fmtUsd(run.usage.totalCostUsd)}
      </div>
      <BurnMeter run={run} />

      {lanes.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {lanes.map(([laneId, lane]) => {
            const fill = lane.contextWindow > 0 ? (lane.inputTokens + lane.cacheReadTokens) / lane.contextWindow : 0;
            const color = fill >= CONTEXT_HARD ? "var(--fail)" : fill >= CONTEXT_SOFT ? "var(--amber)" : "var(--amber-rest)";
            const tokens = lane.inputTokens + lane.outputTokens + lane.cacheReadTokens + lane.cacheCreationTokens;
            return (
              <div key={laneId} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                  <span className="mono" style={{ color: "var(--text)" }}>{laneId} <span style={{ color: "var(--text-faint)" }}>{lane.model ?? ""}</span></span>
                  <span className="mono" style={{ color: "var(--text-faint)" }}>{fmtTokens(tokens)} tok · {fmtPct(fill)}</span>
                </div>
                <div style={{ position: "relative", height: 4, background: "var(--amber-fill)", borderRadius: 2 }} title={`${laneId} context ${fmtPct(fill)}`}>
                  <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, fill * 100)}%`, background: color, borderRadius: 2 }} />
                  <div style={{ position: "absolute", top: -2, bottom: -2, left: `${CONTEXT_SOFT * 100}%`, width: 1, background: "var(--amber-rest)" }} />
                  <div style={{ position: "absolute", top: -2, bottom: -2, left: `${CONTEXT_HARD * 100}%`, width: 1, background: "var(--fail)" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
