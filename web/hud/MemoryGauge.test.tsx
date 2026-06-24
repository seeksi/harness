// web/hud/MemoryGauge.test.tsx
// Fixture usage state: a lane fill bar = (cacheRead+input)/contextWindow, the run
// totalCostUsd shown prominently, and a contextWindow=0 lane guarded to "n/a".
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryGauge } from "./MemoryGauge";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";

const withUsage: RunState = {
  ...initialRunState,
  usage: {
    totalCostUsd: 4.27,
    lanes: {
      "st-a": {
        model: "sonnet",
        inputTokens: 30_000,
        outputTokens: 5_000,
        cacheReadTokens: 60_000,
        cacheCreationTokens: 0,
        contextWindow: 200_000,
        costUsd: 1.5,
      },
      "st-z": {
        inputTokens: 1_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0, // guard → n/a
        costUsd: 0,
      },
    },
  },
};

describe("MemoryGauge", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<MemoryGauge state={withUsage} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows total cost, a fill bar with the right percent, and per-lane cost", () => {
    render(<MemoryGauge state={withUsage} open />);
    expect(screen.getByTestId("total-cost").textContent).toBe("$4.27");

    // (60000 + 30000) / 200000 = 45%
    expect(screen.getByTestId("lane-fill-st-a").getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByTestId("lane-window-st-a").textContent).toContain("90,000/200,000 (45%)");
    expect(screen.getByTestId("lane-cost-st-a").textContent).toBe("$1.50");
  });

  it("guards contextWindow=0 → n/a", () => {
    render(<MemoryGauge state={withUsage} open />);
    expect(screen.getByTestId("lane-window-st-z").textContent).toBe("n/a");
  });

  it("shows an empty state when there is no lane usage", () => {
    render(<MemoryGauge state={initialRunState} open />);
    expect(screen.getByTestId("memory-empty")).toBeInTheDocument();
  });
});
