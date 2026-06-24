// web/hud/TaskLoop.test.tsx
// Fixture subtasks/phases: the active phase header, a building subtask under NOW with
// its model badge + status, and a pending subtask under PLANNED.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskLoop } from "./TaskLoop";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";

const state: RunState = {
  ...initialRunState,
  phases: initialRunState.phases.map((p) =>
    p.id === 2 ? { ...p, status: "active" as const } : p
  ),
  subtasks: [
    { id: "st-a", title: "build scene", status: "building", phase: 2, ownerFiles: [], model: "sonnet" },
    { id: "st-b", title: "build hud", status: "pending", phase: 2, ownerFiles: [], model: "opus" },
  ],
};

describe("TaskLoop", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<TaskLoop state={state} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the active phase, the building subtask under NOW, and the pending one under PLANNED", () => {
    render(<TaskLoop state={state} open />);
    expect(screen.getByTestId("active-phase").textContent).toContain("build");

    const now = screen.getByTestId("loop-subtask-st-a");
    expect(now.textContent).toContain("build scene");
    expect(now.textContent).toContain("building");
    expect(now.textContent).toContain("sonnet");

    const planned = screen.getByTestId("loop-subtask-st-b");
    expect(planned.textContent).toContain("build hud");
    expect(planned.textContent).toContain("pending");
    expect(planned.textContent).toContain("opus");
  });

  it("shows empty states when nothing is active or planned", () => {
    render(<TaskLoop state={initialRunState} open />);
    expect(screen.getByTestId("loop-now-empty")).toBeInTheDocument();
    expect(screen.getByTestId("loop-planned-empty")).toBeInTheDocument();
    expect(screen.getByTestId("active-phase").textContent).toBe("idle");
  });
});
