import { describe, it, expect } from "vitest";
import { deriveHealth, silenceSeconds } from "./health";
import { newRun, STALENESS_WINDOW_SEC, type RunState } from "./types";

function run(over: Partial<RunState> = {}): RunState {
  return { ...newRun("r", "p", "n", "b", 1000), ...over };
}

describe("deriveHealth", () => {
  it("healthy = flowing, no gates, no amber conditions", () => {
    expect(deriveHealth({ run: run(), nowSec: 1000 })).toBe("healthy");
  });

  it("degraded when the producer reported degraded", () => {
    expect(deriveHealth({ run: run({ reportedHealth: "degraded" }), nowSec: 1000 })).toBe("degraded");
  });

  it("degraded when the SSE feed is stale (frozen), even if the run looks fine", () => {
    expect(deriveHealth({ run: run(), nowSec: 1000, feedStale: true })).toBe("degraded");
  });

  it("degraded when a gate is raised", () => {
    const r = run({ gates: [{ id: "B", status: "raised", severity: "high", summary: "block" }] });
    expect(deriveHealth({ run: r, nowSec: 1000 })).toBe("degraded");
  });

  it("degraded when a lane crosses the soft context threshold (60%)", () => {
    const r = run({ usage: { lanes: { a: { inputTokens: 130000, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 200000, costUsd: 0 } }, totalTokens: 130000, totalCostUsd: 0 } });
    expect(deriveHealth({ run: r, nowSec: 1000 })).toBe("degraded");
  });

  it("stuck when the producer reported stuck (wins over everything)", () => {
    expect(deriveHealth({ run: run({ reportedHealth: "stuck" }), nowSec: 1000 })).toBe("stuck");
  });

  it("stuck when an incomplete run goes silent past the 60s staleness window", () => {
    const r = run({ lastEventTs: 1000 }); // phases all idle → incomplete, running
    const past = 1000 + STALENESS_WINDOW_SEC + 1;
    expect(deriveHealth({ run: r, nowSec: past })).toBe("stuck");
  });

  it("NOT stuck from silence once the run has completed", () => {
    const done = run({
      status: "done",
      lastEventTs: 1000,
      phases: newRun("r", "p", "n", "b", 1000).phases.map((p) => ({ ...p, status: "done" })),
    });
    expect(deriveHealth({ run: done, nowSec: 1000 + 10_000 })).toBe("healthy");
  });

  it("silenceSeconds never goes negative", () => {
    expect(silenceSeconds(run({ lastEventTs: 2000 }), 1000)).toBe(0);
    expect(silenceSeconds(run({ lastEventTs: 1000 }), 1090)).toBe(90);
  });
});
