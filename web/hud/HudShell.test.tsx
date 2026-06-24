// web/hud/HudShell.test.tsx
// Integration for the "open-detail-is-sacred" triage: when multiple gates land in
// one flush, the highest-severity surfaces and the rest queue; closing the detail
// toasts the highest-severity still-queued gate (not a dropped/resolved one).
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
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

  it("announces a gate that clears (a lane committed) — not just raised/resolved", async () => {
    const store = createStore(initialRunState);
    render(<HudShell store={store} />);

    // Gate B is raised (commit needed), then the verify clears it.
    act(() => {
      store.apply(gate("B", "high", "st-b", "commit needed"));
      store.flush();
    });
    act(() => {
      store.apply({
        type: "gate",
        id: "B",
        status: "clear",
        severity: "info",
        subtaskId: "st-b",
        summary: "lane feat/built committed and clean",
      });
      store.flush();
    });

    // The polite live region must surface the commit/clear — previously silent.
    const polite = screen.getByLabelText("Pipeline status updates");
    await waitFor(() =>
      expect(polite.textContent).toContain("Gate B clear — lane feat/built committed and clean")
    );
  });

  it("does not announce anything at startup (no gates, no events)", () => {
    const store = createStore(initialRunState);
    render(<HudShell store={store} />);
    expect(screen.getByLabelText("Pipeline status updates").textContent).toBe("");
    expect(screen.getByLabelText("Critical gate escalations").textContent).toBe("");
  });

  it("does not drop a clear when another gate changes in the same flush", async () => {
    const store = createStore(initialRunState);
    render(<HudShell store={store} />);

    // Two gates raised first (B is iterated before C)…
    act(() => {
      store.apply(gate("B", "high", "st-b", "commit needed"));
      store.apply(gate("C", "high", "st-c", "integration red"));
      store.flush();
    });
    // …then in ONE flush: B clears (commit) AND C resolves. Last-wins would drop B's
    // clear because C is iterated last; accumulation keeps both.
    act(() => {
      store.apply({
        type: "gate",
        id: "B",
        status: "clear",
        severity: "info",
        subtaskId: "st-b",
        summary: "lane feat/built committed and clean",
      });
      store.apply({
        type: "gate",
        id: "C",
        status: "resolved",
        severity: "high",
        subtaskId: "st-c",
        summary: "integration green",
      });
      store.flush();
    });

    const polite = screen.getByLabelText("Pipeline status updates");
    await waitFor(() => {
      expect(polite.textContent).toContain("Gate B clear");
      expect(polite.textContent).toContain("Gate C resolved");
    });
  });
});
