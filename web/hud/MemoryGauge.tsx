// web/hud/MemoryGauge.tsx — Lane C.
// The "active context window / memory constraints" view. Per lane bucket
// (RunState.usage.lanes), a context-window fill bar = (cacheRead + input) / contextWindow,
// the indigo→violet accent ramp for the fill, in/out/cache tokens + per-lane cost in
// tabular mono, and the run totalCostUsd prominently. contextWindow 0 ⇒ "n/a" (no bar).
"use client";

import type { RunState, LaneUsage } from "@/lib/contract/types";
import { glassSurface } from "./glass";

const MONO = "var(--font-mono)";

// Accent ramp by fill pressure: idle→rest→mid→vivid→neon as the window fills.
function rampColor(ratio: number): string {
  if (ratio >= 0.9) return "var(--accent-neon)";
  if (ratio >= 0.7) return "var(--accent-vivid)";
  if (ratio >= 0.4) return "var(--accent-mid)";
  if (ratio > 0) return "var(--accent-rest-glow)";
  return "var(--accent-dim-fill)";
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function LaneBar({ id, lane }: { id: string; lane: LaneUsage }) {
  const used = lane.cacheReadTokens + lane.inputTokens;
  const hasWindow = lane.contextWindow > 0;
  const ratio = hasWindow ? Math.min(used / lane.contextWindow, 1) : 0;
  const pct = Math.round(ratio * 100);

  return (
    <li
      data-testid={`lane-${id}`}
      style={{
        padding: "6px 8px",
        borderRadius: 6,
        background: "var(--surface-1)",
        marginBottom: 6,
        fontFamily: MONO,
        fontSize: 12,
        fontVariantNumeric: "tabular-nums lining-nums",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ color: "var(--text)" }}>
          {id}
          {lane.model ? <span style={{ color: "var(--text-faint)" }}> · {lane.model}</span> : null}
        </span>
        <span data-testid={`lane-cost-${id}`} style={{ color: "var(--text-dim)" }}>
          {usd(lane.costUsd)}
        </span>
      </div>

      {/* context-window fill bar */}
      <div
        data-testid={`lane-fill-${id}`}
        role="meter"
        aria-label={`${id} context window`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--surface-3)",
          overflow: "hidden",
          marginBottom: 4,
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: rampColor(ratio),
            transition: "width 120ms linear",
          }}
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--text-faint)" }}>
        <span>
          in {fmt(lane.inputTokens)} · out {fmt(lane.outputTokens)} · cache {fmt(lane.cacheReadTokens)}
        </span>
        <span data-testid={`lane-window-${id}`}>
          {hasWindow ? `${fmt(used)}/${fmt(lane.contextWindow)} (${pct}%)` : "n/a"}
        </span>
      </div>
    </li>
  );
}

export function MemoryGauge({ state, open }: { state: RunState; open: boolean }) {
  if (!open) return null;
  const lanes = Object.entries(state.usage.lanes);

  return (
    <section
      aria-label="Memory gauge"
      data-testid="memory-gauge"
      style={{
        ...glassSurface(),
        position: "absolute",
        bottom: 16,
        left: 16,
        width: 320,
        padding: 12,
        borderRadius: 8,
        fontFamily: MONO,
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 11, letterSpacing: 1, color: "var(--text-dim)" }}>
          MEMORY · CONTEXT
        </span>
        <span
          data-testid="total-cost"
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--accent-vivid)",
            fontVariantNumeric: "tabular-nums lining-nums",
          }}
        >
          {usd(state.usage.totalCostUsd)}
        </span>
      </header>

      {lanes.length === 0 ? (
        <p data-testid="memory-empty" style={{ color: "var(--text-faint)", fontSize: 12, margin: 0 }}>
          no lane usage yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {lanes.map(([id, lane]) => (
            <LaneBar key={id} id={id} lane={lane} />
          ))}
        </ul>
      )}
    </section>
  );
}
