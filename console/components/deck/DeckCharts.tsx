// console/components/deck/DeckCharts.tsx
// The deck's "dense + real charts" tier (§6): token burn over time (line), per-lane
// comparison (bars), eval score history (line/dots). Hand-rolled SVG — no chart deps.
// Mapping rules (binding): axes start at zero, no dual-axis, no pies. CRT palette —
// amber is the data voice (it's the only hue with an intensity ladder); green/red are
// reserved for the eval pass/fail signal only, matching their role everywhere else.
"use client";

import { useMemo } from "react";
import type { Envelope } from "@/lib/contract/events";
import type { RunState } from "@/lib/contract/types";
import { burnOverTime, laneComparison, evalHistory } from "@/app/deck/lib/series";
import { fmtTokens, fmtClock } from "@/lib/format";
import { SectionTitle } from "./SectionTitle";

const W = 560;
const H = 160;
const PAD = { top: 10, right: 10, bottom: 22, left: 46 };
const SERIES_COLORS = ["var(--amber)", "var(--amber-bright)", "var(--amber-rest)"];

function scale(domainMax: number, range: number): (v: number) => number {
  const max = domainMax > 0 ? domainMax : 1;
  return (v: number) => range - (v / max) * range;
}

interface Props {
  envelopes: Envelope[];
  runs: RunState[];
  selectedRun?: RunState;
}

export function DeckCharts({ envelopes, runs, selectedRun }: Props) {
  const burn = useMemo(() => burnOverTime(envelopes), [envelopes]);
  const laneRun = selectedRun ?? runs[0];
  const bars = useMemo(() => (laneRun ? laneComparison(laneRun) : []), [laneRun]);
  const evals = useMemo(() => evalHistory(runs), [runs]);

  return (
    <section aria-label="burn and eval charts" style={{ marginTop: 22, display: "grid", gap: 18, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
      <div>
        <SectionTitle>Token burn over time</SectionTitle>
        <BurnLineChart series={burn} />
      </div>
      <div>
        <SectionTitle>Per-lane tokens{laneRun ? ` — ${laneRun.projectName}` : ""}</SectionTitle>
        <LaneBarChart bars={bars} />
      </div>
      <div>
        <SectionTitle>Eval history</SectionTitle>
        <EvalHistoryChart points={evals} />
      </div>
    </section>
  );
}

function ChartFrame({ children, empty }: { children?: React.ReactNode; empty?: boolean }) {
  return (
    <div style={{ borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--surface-1)", padding: 8 }}>
      {empty ? (
        <div style={{ height: H, display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: 12 }}>no data yet</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
          {children}
        </svg>
      )}
    </div>
  );
}

// Zero-baseline axis lines, shared by all three charts.
function Axes({ innerW, innerH }: { innerW: number; innerH: number }) {
  return (
    <g transform={`translate(${PAD.left},${PAD.top})`}>
      <line x1={0} y1={innerH} x2={innerW} y2={innerH} stroke="var(--border-bright)" strokeWidth={1} />
      <line x1={0} y1={0} x2={0} y2={innerH} stroke="var(--border-bright)" strokeWidth={1} />
    </g>
  );
}

function BurnLineChart({ series }: { series: Map<string, { ts: number; runId: string; cumulativeTokens: number }[]> }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const runIds = [...series.keys()];
  if (runIds.length === 0) return <ChartFrame empty />;

  const allPoints = runIds.flatMap((id) => series.get(id) ?? []);
  const tMin = Math.min(...allPoints.map((p) => p.ts));
  const tMax = Math.max(...allPoints.map((p) => p.ts));
  const tokMax = Math.max(...allPoints.map((p) => p.cumulativeTokens));
  const x = (t: number) => (tMax > tMin ? ((t - tMin) / (tMax - tMin)) * innerW : 0);
  const y = scale(tokMax, innerH);

  return (
    <ChartFrame>
      <Axes innerW={innerW} innerH={innerH} />
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {runIds.map((id, i) => {
          const pts = series.get(id) ?? [];
          const d = pts.map((p, j) => `${j === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.cumulativeTokens).toFixed(1)}`).join(" ");
          return <path key={id} d={d} fill="none" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth={2} />;
        })}
      </g>
      <text x={PAD.left} y={H - 6} className="mono" fontSize={9} fill="var(--text-faint)">{fmtClock(tMin * 1000)}</text>
      <text x={W - PAD.right} y={H - 6} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">{fmtClock(tMax * 1000)}</text>
      <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">{fmtTokens(tokMax)}</text>
      <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">0</text>
    </ChartFrame>
  );
}

function LaneBarChart({ bars }: { bars: { laneId: string; tokens: number }[] }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  if (bars.length === 0) return <ChartFrame empty />;
  const max = Math.max(...bars.map((b) => b.tokens));
  const y = scale(max, innerH);
  const bw = innerW / bars.length - 10;

  return (
    <ChartFrame>
      <Axes innerW={innerW} innerH={innerH} />
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {bars.map((b, i) => {
          const x0 = i * (innerW / bars.length) + 5;
          const yTop = y(b.tokens);
          return (
            <g key={b.laneId}>
              <rect x={x0} y={yTop} width={bw} height={innerH - yTop} fill="var(--amber)" opacity={0.85} />
              <text x={x0 + bw / 2} y={innerH + 14} textAnchor="middle" className="mono" fontSize={9} fill="var(--text-faint)">
                {b.laneId}
              </text>
              <text x={x0 + bw / 2} y={yTop - 4} textAnchor="middle" className="mono" fontSize={9} fill="var(--text-dim)">
                {fmtTokens(b.tokens)}
              </text>
            </g>
          );
        })}
      </g>
      <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">{fmtTokens(max)}</text>
      <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">0</text>
    </ChartFrame>
  );
}

function EvalHistoryChart({ points }: { points: { runId: string; ts: number; capabilityScore: number; regressionPass: boolean }[] }) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  if (points.length === 0) return <ChartFrame empty />;
  const tMin = Math.min(...points.map((p) => p.ts));
  const tMax = Math.max(...points.map((p) => p.ts));
  const x = (t: number) => (tMax > tMin ? ((t - tMin) / (tMax - tMin)) * innerW : innerW / 2);
  const y = scale(1, innerH); // capability score is 0..1 — axis fixed at [0,1], zero baseline

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ts).toFixed(1)},${y(p.capabilityScore).toFixed(1)}`).join(" ");

  return (
    <ChartFrame>
      <Axes innerW={innerW} innerH={innerH} />
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        <path d={d} fill="none" stroke="var(--amber-rest)" strokeWidth={1.5} />
        {points.map((p) => (
          <circle
            key={p.runId}
            cx={x(p.ts)}
            cy={y(p.capabilityScore)}
            r={4}
            fill={p.regressionPass ? "var(--live)" : "var(--fail)"}
          >
            <title>{`${p.runId}: score ${p.capabilityScore.toFixed(2)}, regression ${p.regressionPass ? "pass" : "fail"}`}</title>
          </circle>
        ))}
      </g>
      <text x={PAD.left - 4} y={PAD.top + 4} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">1.0</text>
      <text x={PAD.left - 4} y={H - PAD.bottom} textAnchor="end" className="mono" fontSize={9} fill="var(--text-faint)">0</text>
    </ChartFrame>
  );
}
