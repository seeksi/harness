// web/hud/InboxRail.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InboxRail } from "./InboxRail";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";

const raised: RunState = {
  ...initialRunState,
  gates: [
    { id: "D", status: "raised", severity: "critical", summary: "trajectory anomaly", subtaskId: "st-c", counts: { high: 0, critical: 1 } },
  ],
};

describe("InboxRail", () => {
  it("renders the four-fact action line and fires onSelect", () => {
    const onSelect = vi.fn();
    render(<InboxRail state={raised} onSelect={onSelect} />);
    expect(screen.getByTestId("inbox-line-gate-D").textContent).toBe(
      "Gate D · trajectory · st-c · 1 Critical"
    );
    fireEvent.click(screen.getByTestId("inbox-line-gate-D"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when there is nothing to triage", () => {
    const { container } = render(<InboxRail state={initialRunState} />);
    expect(container.firstChild).toBeNull();
  });
});
