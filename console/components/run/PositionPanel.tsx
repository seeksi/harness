// console/components/run/PositionPanel.tsx
// Top-left quadrant per §5: phase rail + position OWNS this zone — 6 phases,
// current position, building subtasks, what's next. Gate/action signals ride the
// rail but never displace it (they render as separate GateCard zones alongside).
"use client";

import type { RunState } from "@/lib/contract/types";
import { PHASE_LABELS } from "@/lib/contract/types";
import { currentPhase, subtaskCounts } from "@/lib/contract/selectors";
import { PhaseRail } from "@/components/PhaseRail";

export function PositionPanel({ run }: { run: RunState }) {
  const cur = currentPhase(run);
  const counts = subtaskCounts(run);
  const next = cur < 6 ? (PHASE_LABELS[(cur + 1) as 1 | 2 | 3 | 4 | 5 | 6]) : null;
  const building = run.subtasks.filter((s) => s.status === "building");

  return (
    <section aria-label="run position" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PhaseRail run={run} size="focus" />

      <div className="mono" style={{ fontSize: 13, color: "var(--amber)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
        {cur}/6 · {PHASE_LABELS[cur]}
        {next && <span style={{ color: "var(--text-faint)", marginLeft: 10 }}>next → {next}</span>}
      </div>

      <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>
        building {counts.building} · pending {counts.pending} · done {counts.done}
        {counts.blocked ? <span style={{ color: "var(--fail)" }}> · blocked {counts.blocked}</span> : null}
      </div>

      {building.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {building.map((s) => (
            <li
              key={s.id}
              className="pulse"
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 6,
                background: "var(--amber-fill)",
                border: "1px solid var(--amber-line)",
                fontSize: 12,
              }}
            >
              <span style={{ color: "var(--text)" }}>{s.title}</span>
              <span className="mono" style={{ color: "var(--text-faint)", fontSize: 10 }}>{s.model ?? "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
