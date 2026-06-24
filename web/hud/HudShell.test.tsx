// web/hud/HudShell.test.tsx
// Integration for the "open-detail-is-sacred" triage: when multiple gates land in
// one flush, the highest-severity surfaces and the rest queue; closing the detail
// toasts the highest-severity still-queued gate (not a dropped/resolved one).
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { createStore } from "@/lib/store/store";
import { initialRunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";
import { HudShell } from "./HudShell";

const gate = (
  id: "A" | "B" | "C" | "D",
  severity: "critical" | "high",
  subtaskId: string,
  summary: string
): SSEEvent => ({ type: "gate", id, status: "raised", severity, subtaskId, summary });

describe("HudShell triage", () => {
  it("surfaces the highest-severity gate, queues the rest, toasts on close", () => {
    const store = createStore(initialRunState);
    render(<HudShell store={store} />);

    act(() => {
      store.apply(gate("B", "high", "st-b", "review block"));
      store.apply(gate("D", "critical", "st-c", "trajectory anomaly"));
      store.flush();
    });

    // Critical Gate D surfaces (not the high Gate B).
    expect(screen.getByTestId("detail-line").textContent).toContain("Gate D");

    // Closing the detail offers a toast for the queued Gate B.
    fireEvent.click(screen.getByTestId("detail-close"));
    expect(screen.getByTestId("toast").textContent).toContain("Gate B");
  });
});
