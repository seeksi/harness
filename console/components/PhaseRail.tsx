// console/components/PhaseRail.tsx
// The pipeline spine — 6 LOCKED phases. Current phase PULSES amber (the interface
// voice), completed phases sit steady in amber-rest, a blocked gate BURNS red on the
// rail at its phase. Identical component at lane-size and focus-size (via `size`).
"use client";

import type { RunState, PhaseState } from "@/lib/contract/types";
import { currentPhase } from "@/lib/contract/selectors";

function segColor(p: PhaseState, isCurrent: boolean): { bg: string; cls: string; text: string } {
  if (p.status === "blocked") return { bg: "var(--fail-fill)", cls: "burn", text: "var(--fail)" };
  if (isCurrent && p.status === "active") return { bg: "var(--amber-fill)", cls: "pulse", text: "var(--amber)" };
  if (p.status === "done") return { bg: "transparent", cls: "", text: "var(--amber-rest)" };
  return { bg: "transparent", cls: "", text: "var(--text-faint)" };
}

export function PhaseRail({ run, size = "lane" }: { run: RunState; size?: "lane" | "focus" }) {
  const cur = currentPhase(run);
  const focus = size === "focus";
  const barH = focus ? 6 : 4;
  return (
    <div
      role="list"
      aria-label="phase rail"
      style={{ display: "grid", gridTemplateColumns: `repeat(${run.phases.length}, 1fr)`, gap: 4 }}
    >
      {run.phases.map((p) => {
        const isCurrent = p.id === cur;
        const c = segColor(p, isCurrent);
        return (
          <div key={p.id} role="listitem" aria-current={isCurrent ? "step" : undefined} title={`${p.id}. ${p.label} — ${p.status}`}>
            <div
              className={c.cls}
              style={{
                height: barH,
                borderRadius: 2,
                background: p.status === "done" ? "var(--amber-rest)" : c.bg,
                border: `1px solid ${p.status === "idle" ? "var(--border)" : "var(--amber-line)"}`,
                borderColor: p.status === "blocked" ? "var(--fail)" : undefined,
              }}
            />
            {focus && (
              <div className="mono" style={{ marginTop: 6, fontSize: 10, color: c.text, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                {p.id}·{p.label}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
