// DOM mirror parity tests.
// Given fixture-derived RunState, mirror renders: task id, phase, gate count, active subtask.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DomMirror } from "../DomMirror";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";

const baseState: RunState = {
  ...initialRunState,
  task: { id: "run-fixture", brief: "Build the Umbrella web UI", phase: 1, state: "running" },
};

describe("DomMirror — task identity", () => {
  it("renders the task id", () => {
    render(<DomMirror state={baseState} />);
    expect(screen.getByTestId("mirror-task-id").textContent).toBe("run-fixture");
  });

  it("renders — when task id is empty", () => {
    const state: RunState = {
      ...baseState,
      task: { ...baseState.task, id: "" },
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-task-id").textContent).toBe("—");
  });
});

describe("DomMirror — current phase", () => {
  it("shows phase 1 initially", () => {
    render(<DomMirror state={baseState} />);
    expect(screen.getByTestId("mirror-phase-id").textContent).toBe("1");
    expect(screen.getByTestId("mirror-phase-label").textContent).toBe("Decompose");
  });

  it("shows the active phase from phases array", () => {
    const state: RunState = {
      ...baseState,
      phases: initialRunState.phases.map((p) =>
        p.id === 4 ? { ...p, status: "active" } : p
      ),
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-phase-id").textContent).toBe("4");
    expect(screen.getByTestId("mirror-phase-label").textContent).toBe("Cross-review");
  });

  it("when multiple phases active, picks the highest-id active phase", () => {
    const state: RunState = {
      ...baseState,
      phases: initialRunState.phases.map((p) => {
        if (p.id === 2) return { ...p, status: "active" };
        if (p.id === 4) return { ...p, status: "active" };
        return p;
      }),
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-phase-id").textContent).toBe("4");
  });
});

describe("DomMirror — gate count", () => {
  it("shows 0 gates raised initially", () => {
    render(<DomMirror state={baseState} />);
    expect(screen.getByTestId("mirror-gate-count").textContent).toContain("0");
  });

  it("counts only raised gates (not resolved/clear)", () => {
    const state: RunState = {
      ...baseState,
      gates: [
        { id: "B", status: "raised", severity: "high", summary: "review block", subtaskId: "st-b" },
        { id: "D", status: "raised", severity: "critical", summary: "anomaly", subtaskId: "st-c" },
        { id: "A", status: "resolved", severity: "info", summary: "budget ok" },
      ],
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-gates-raised").textContent).toContain("2");
  });

  it("shows ALERT badge when gates are raised", () => {
    const state: RunState = {
      ...baseState,
      gates: [
        { id: "D", status: "raised", severity: "critical", summary: "anomaly", subtaskId: "st-c" },
      ],
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-gates-raised").textContent).toContain("[ALERT]");
  });
});

describe("DomMirror — active subtask", () => {
  it("shows — when no subtask is building", () => {
    render(<DomMirror state={baseState} />);
    expect(screen.getByTestId("mirror-active-subtask").textContent).toContain("—");
  });

  it("shows the building subtask id and BUILDING badge", () => {
    const state: RunState = {
      ...baseState,
      subtasks: [
        { id: "st-a", title: "Lane A", status: "building", phase: 2, ownerFiles: [] },
        { id: "st-b", title: "Lane B", status: "pending", phase: 2, ownerFiles: [] },
      ],
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-subtask-id").textContent).toBe("st-a");
    expect(screen.getByTestId("mirror-subtask-status").textContent).toContain("BUILDING");
  });

  it("shows the first building subtask when multiple are building", () => {
    const state: RunState = {
      ...baseState,
      subtasks: [
        { id: "st-a", title: "", status: "building", phase: 2, ownerFiles: [] },
        { id: "st-b", title: "", status: "building", phase: 2, ownerFiles: [] },
      ],
    };
    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-subtask-id").textContent).toBe("st-a");
  });
});

describe("DomMirror — full fixture projection", () => {
  it("projects gate B+D co-fire state correctly", () => {
    const state: RunState = {
      ...baseState,
      task: { id: "run-fixture", brief: "Build the Umbrella web UI", phase: 4, state: "running" },
      phases: initialRunState.phases.map((p) =>
        p.id === 4 ? { ...p, status: "active" } : p
      ),
      subtasks: [
        { id: "st-a", title: "", status: "reviewed", phase: 4, ownerFiles: [] },
        { id: "st-b", title: "", status: "building", phase: 4, ownerFiles: [] },
        { id: "st-c", title: "", status: "building", phase: 4, ownerFiles: [] },
      ],
      gates: [
        { id: "B", status: "raised", severity: "high", summary: "cross-review BLOCK on st-b: 2 high findings unresolved", subtaskId: "st-b", counts: { high: 2, critical: 0 } },
        { id: "D", status: "raised", severity: "critical", summary: "trajectory anomaly: tool-call loop (LOOP) on st-c", subtaskId: "st-c", counts: { high: 0, critical: 1 }, traceReady: true },
      ],
    };

    render(<DomMirror state={state} />);
    expect(screen.getByTestId("mirror-task-id").textContent).toBe("run-fixture");
    expect(screen.getByTestId("mirror-phase-id").textContent).toBe("4");
    expect(screen.getByTestId("mirror-gates-raised").textContent).toContain("2");
    // Active subtask = first building = st-b
    expect(screen.getByTestId("mirror-subtask-id").textContent).toBe("st-b");

    // Individual gate items rendered
    expect(screen.getByTestId("mirror-gate-B")).toBeDefined();
    expect(screen.getByTestId("mirror-gate-D")).toBeDefined();
  });
});
