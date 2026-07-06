// console/app/deck/lib/series.ts
// Pure chart-data derivations (§6 chart mapping: token burn over time — line; per-lane
// comparison — bars; eval history — line/dots). No React, no SVG — DeckCharts.tsx
// only lays these numbers out. Burn-over-time is computed from the RAW envelope
// order (not the folded snapshot) so it's a genuine time series, not a single point.

import type { Envelope, UsagePayload } from "@/lib/contract/events";
import type { RunState } from "@/lib/contract/types";

export interface BurnPoint {
  ts: number;
  runId: string;
  cumulativeTokens: number;
}

function tokenSum(p: UsagePayload): number {
  return p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheCreationTokens;
}

// One ascending series per run: cumulative tokens across all lanes at each usage tick.
export function burnOverTime(envelopes: Envelope[]): Map<string, BurnPoint[]> {
  const byRun = new Map<string, BurnPoint[]>();
  const laneTotals = new Map<string, Map<string, number>>(); // runId -> laneId -> tokens

  for (const env of envelopes) {
    if (env.type !== "usage") continue;
    const laneKey = env.payload.laneId ?? "_run";
    const lanes = laneTotals.get(env.runId) ?? new Map<string, number>();
    lanes.set(laneKey, tokenSum(env.payload));
    laneTotals.set(env.runId, lanes);

    const cumulativeTokens = [...lanes.values()].reduce((a, b) => a + b, 0);
    const series = byRun.get(env.runId) ?? [];
    series.push({ ts: env.ts, runId: env.runId, cumulativeTokens });
    byRun.set(env.runId, series);
  }
  return byRun;
}

export interface LaneBar {
  laneId: string;
  tokens: number;
}

export function laneComparison(run: RunState): LaneBar[] {
  return Object.entries(run.usage.lanes)
    .map(([laneId, lane]) => ({
      laneId,
      tokens: lane.inputTokens + lane.outputTokens + lane.cacheReadTokens + lane.cacheCreationTokens,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}

export interface EvalPoint {
  runId: string;
  projectName: string;
  ts: number;
  capabilityScore: number;
  regressionPass: boolean;
}

// One dot per run that has reported evals, ordered by start time (a run history, not
// a within-run timeline — eval+promote reports once per run).
export function evalHistory(runs: RunState[]): EvalPoint[] {
  return runs
    .filter((r): r is RunState & { evals: NonNullable<RunState["evals"]> } => Boolean(r.evals))
    .map((r) => ({
      runId: r.runId,
      projectName: r.projectName,
      ts: r.startedAt,
      capabilityScore: r.evals.capabilityScore,
      regressionPass: r.evals.regressionPass,
    }))
    .sort((a, b) => a.ts - b.ts);
}
