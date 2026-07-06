// console/components/meters.tsx — mini burn meter + context-fill gauge + health badge.
"use client";

import type { RunState, HealthVerdict } from "@/lib/contract/types";
import { CONTEXT_SOFT, CONTEXT_HARD } from "@/lib/contract/types";
import { contextFill, totalTokens } from "@/lib/contract/selectors";
import { fmtTokens, fmtUsd, fmtPct } from "@/lib/format";

// Mini burn meter — tokens primary, $ secondary. Amber is the burn voice.
export function BurnMeter({ run }: { run: RunState }) {
  const tokens = totalTokens(run);
  const fill = contextFill(run);
  const ctxColor = fill >= CONTEXT_HARD ? "var(--fail)" : fill >= CONTEXT_SOFT ? "var(--amber)" : "var(--amber-rest)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--amber)" }}>{fmtTokens(tokens)} tok</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{fmtUsd(run.usage.totalCostUsd)}</span>
      </div>
      {/* context-fill track: 60% soft (amber) / 75% hard (red) thresholds */}
      <div style={{ position: "relative", height: 4, background: "var(--amber-fill)", borderRadius: 2 }} title={`context ${fmtPct(fill)}`}>
        <div style={{ position: "absolute", inset: 0, width: `${Math.min(100, fill * 100)}%`, background: ctxColor, borderRadius: 2 }} />
        <div style={{ position: "absolute", top: -2, bottom: -2, left: `${CONTEXT_SOFT * 100}%`, width: 1, background: "var(--amber-rest)" }} />
        <div style={{ position: "absolute", top: -2, bottom: -2, left: `${CONTEXT_HARD * 100}%`, width: 1, background: "var(--fail)" }} />
      </div>
    </div>
  );
}

const HEALTH_STYLE: Record<HealthVerdict, { color: string; fill: string; label: string; cls: string }> = {
  healthy: { color: "var(--live)", fill: "var(--live-fill)", label: "LIVE", cls: "breathe" },
  degraded: { color: "var(--amber)", fill: "var(--amber-fill)", label: "DEGRADED", cls: "pulse" },
  stuck: { color: "var(--fail)", fill: "var(--fail-fill)", label: "STUCK", cls: "burn" },
};

export function HealthBadge({ verdict }: { verdict: HealthVerdict }) {
  const s = HEALTH_STYLE[verdict];
  return (
    <span
      className={`mono ${s.cls}`}
      role="status"
      aria-label={`health ${verdict}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 7px",
        borderRadius: 4,
        fontSize: 10,
        letterSpacing: "0.1em",
        color: s.color,
        background: s.fill,
        border: `1px solid ${s.color}`,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color }} />
      {s.label}
    </span>
  );
}
