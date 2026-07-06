import { describe, it, expect } from "vitest";
import { laneNowSec } from "./RunLane";
import { newRun } from "@/lib/contract/types";

// A fixture-style run whose events are far in the past (historical epoch).
const run = newRun("r", "p", "P", "b", 1000); // lastEventTs = 1000

describe("laneNowSec — fixture vs live clock (§6 stuck-badge regression)", () => {
  it("FIXTURE: derives `now` from the run's lastEventTs, so silence ≈ 0 (no ~370-day stuck badge)", () => {
    // Even with a huge wall-clock value threaded in, fixture mode ignores it.
    expect(laneNowSec(false, run, 9_999_999)).toBe(1000);
  });

  it("LIVE: uses the parent's ticked wall-clock nowSec so a silent run ages into stuck", () => {
    expect(laneNowSec(true, run, 9_999_999)).toBe(9_999_999);
  });

  it("LIVE: falls back to a fresh wall-clock read when nowSec is not threaded", () => {
    const before = Math.floor(Date.now() / 1000);
    expect(laneNowSec(true, run, undefined)).toBeGreaterThanOrEqual(before);
  });
});
