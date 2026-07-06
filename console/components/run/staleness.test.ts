import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeStaleBanner, feedIsStale, scheduleStaleTick } from "./staleness";
import { newRun, STALENESS_WINDOW_SEC, type RunState } from "@/lib/contract/types";

function run(over: Partial<RunState> = {}): RunState {
  return { ...newRun("r", "p", "n", "b", 1000), ...over };
}

describe("feedIsStale", () => {
  it("only 'reconnecting' is stale — 'closed' is a clean terminal state, not stale", () => {
    expect(feedIsStale("reconnecting")).toBe(true);
    expect(feedIsStale("closed")).toBe(false);
    expect(feedIsStale("open")).toBe(false);
    expect(feedIsStale("connecting")).toBe(false);
  });
});

describe("computeStaleBanner", () => {
  it("open feed, run silent under the threshold: not stale", () => {
    const r = run({ lastEventTs: 1000 });
    const b = computeStaleBanner(r, 1000 + STALENESS_WINDOW_SEC - 1, "open");
    expect(b.stale).toBe(false);
    expect(b.reason).toBeNull();
  });

  it("open feed, but the run itself goes silent past STALENESS_WINDOW_SEC: stale, reason no-events", () => {
    const r = run({ lastEventTs: 1000 });
    const b = computeStaleBanner(r, 1000 + STALENESS_WINDOW_SEC + 1, "open");
    expect(b.stale).toBe(true);
    expect(b.feedStale).toBe(false);
    expect(b.reason).toBe("no-events");
  });

  it("reconnecting feed is stale immediately, regardless of run silence", () => {
    const r = run({ lastEventTs: 1000 });
    const b = computeStaleBanner(r, 1000, "reconnecting");
    expect(b.stale).toBe(true);
    expect(b.feedStale).toBe(true);
    expect(b.reason).toBe("reconnecting");
  });

  it("clean close ('closed') is NOT stale even long after the last event, matching FleetHome's reconnecting-only semantics", () => {
    const r = run({ lastEventTs: 1000 });
    const b = computeStaleBanner(r, 1000 + STALENESS_WINDOW_SEC + 500, "closed");
    // The run has completed lifecycle-wise in the typical clean-close case, but even
    // for a still-"running" run, a clean close must not manufacture a false stale banner.
    expect(b.feedStale).toBe(false);
    expect(b.reason).not.toBe("reconnecting");
  });

  it("clean close short-circuits the run-silence rule entirely — never no-events, never stale, no matter how long the wall clock has silenced", () => {
    const r = run({ status: "running", lastEventTs: 1000 });
    const b = computeStaleBanner(r, 1000 + STALENESS_WINDOW_SEC + 500, "closed");
    expect(b.stale).toBe(false);
    expect(b.reason).toBeNull();
  });

  it("a done run never reports no-events silence, even long after lastEventTs", () => {
    const r = run({ status: "done", lastEventTs: 1000 });
    const b = computeStaleBanner(r, 1000 + STALENESS_WINDOW_SEC + 10_000, "open");
    expect(b.stale).toBe(false);
  });
});

describe("scheduleStaleTick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an open-but-silent feed re-evaluates on the 1s tick and crosses the staleness threshold", () => {
    const r = run({ lastEventTs: 1000 });
    let now = 1000;
    let latest = computeStaleBanner(r, now, "open");
    const cancel = scheduleStaleTick(() => {
      now += 1;
      latest = computeStaleBanner(r, now, "open");
    });

    // No new SSE frame ever arrives, but the clock tick alone must flip it stale
    // exactly when silence crosses STALENESS_WINDOW_SEC.
    vi.advanceTimersByTime((STALENESS_WINDOW_SEC - 1) * 1000);
    expect(latest.stale).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(latest.stale).toBe(true);
    expect(latest.reason).toBe("no-events");

    cancel();
  });

  it("cancel stops further ticks", () => {
    const cb = vi.fn();
    const cancel = scheduleStaleTick(cb);
    vi.advanceTimersByTime(3000);
    expect(cb).toHaveBeenCalledTimes(3);
    cancel();
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(3);
  });
});
