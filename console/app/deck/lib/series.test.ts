import { describe, it, expect } from "vitest";
import { burnOverTime, laneComparison, evalHistory } from "./series";
import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";

const envelopes = fixtureEnvelopes();
const state = foldFleet(envelopes, initialFleetState);

describe("burnOverTime", () => {
  it("produces a monotonically non-decreasing cumulative series per run", () => {
    const byRun = burnOverTime(envelopes);
    expect(byRun.size).toBeGreaterThan(0);
    for (const series of byRun.values()) {
      for (let i = 1; i < series.length; i++) {
        expect(series[i].cumulativeTokens).toBeGreaterThanOrEqual(series[i - 1].cumulativeTokens);
        expect(series[i].ts).toBeGreaterThanOrEqual(series[i - 1].ts);
      }
    }
  });

  it("matches the folded run's final total tokens at the last point", () => {
    const byRun = burnOverTime(envelopes);
    const consoleSeries = byRun.get("run-console")!;
    const last = consoleSeries[consoleSeries.length - 1];
    expect(last.cumulativeTokens).toBe(state.runs["run-console"].usage.totalTokens);
  });
});

describe("laneComparison", () => {
  it("returns one bar per lane, sorted descending by tokens", () => {
    const bars = laneComparison(state.runs["run-console"]);
    expect(bars.length).toBe(3); // st-a, st-b, st-c
    for (let i = 1; i < bars.length; i++) expect(bars[i].tokens).toBeLessThanOrEqual(bars[i - 1].tokens);
  });

  it("returns [] for a run with no usage yet", () => {
    const bare = { ...state.runs["run-console"], usage: { lanes: {}, totalTokens: 0, totalCostUsd: 0 } };
    expect(laneComparison(bare)).toEqual([]);
  });
});

describe("evalHistory", () => {
  it("includes only runs that reported evals, ordered by start time", () => {
    const points = evalHistory(Object.values(state.runs));
    expect(points.length).toBe(1); // only the memory-os lane reports evals in the fixture
    expect(points[0].runId).toBe("run-memoryos");
    expect(points[0].regressionPass).toBe(true);
    expect(points[0].capabilityScore).toBeCloseTo(0.86);
  });
});
