// web/scene/sceneGraph.test.ts
// Lane B — project_scene is a pure projection: must handle zero-state without
// crashing, and must surface the headline facts NodeGraph renders.

import { describe, it, expect } from "vitest";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";
import { project_scene } from "./sceneGraph";

describe("project_scene", () => {
  it("handles zero-state (empty subtasks/gates) without crashing", () => {
    const g = project_scene(initialRunState);
    expect(g).toBeDefined();
    expect(g.summary.gateCount).toBe(0);
    expect(g.summary.raisedGateCount).toBe(0);
    expect(g.summary.activeSubtask).toBeNull();
    // six phase nodes + one task node, no subtask nodes
    expect(g.nodes.filter((n) => n.kind === "phase")).toHaveLength(6);
    expect(g.nodes.filter((n) => n.kind === "task")).toHaveLength(1);
    expect(g.nodes.filter((n) => n.kind === "subtask")).toHaveLength(0);
  });

  it("projects subtasks, gates, and the active subtask", () => {
    const state: RunState = {
      ...initialRunState,
      task: { id: "run-1", brief: "b", phase: 4, state: "running" },
      subtasks: [
        { id: "st-a", title: "A", status: "reviewed", phase: 4, ownerFiles: [] },
        { id: "st-b", title: "B", status: "building", phase: 2, ownerFiles: [] },
      ],
      gates: [
        { id: "B", status: "raised", severity: "high", summary: "block" },
        { id: "D", status: "resolved", severity: "critical", summary: "cleared" },
      ],
    };
    const g = project_scene(state);
    expect(g.summary.taskId).toBe("run-1");
    expect(g.summary.currentPhase).toBe(4);
    expect(g.summary.currentPhaseLabel).toBe("cross-review");
    expect(g.summary.gateCount).toBe(2);
    expect(g.summary.raisedGateCount).toBe(1);
    // building beats reviewed in the active heuristic
    expect(g.summary.activeSubtask).toBe("st-b");
    expect(g.nodes.filter((n) => n.kind === "subtask")).toHaveLength(2);
    // every edge points at existing nodes
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it("folds the canonical fixture end-state shape without throwing", () => {
    // Light smoke: project a state with all phases done + merged subtasks.
    const state: RunState = {
      ...initialRunState,
      task: { id: "run-fixture", brief: "x", phase: 6, state: "running" },
      subtasks: [
        { id: "st-a", title: "", status: "merged", phase: 5, ownerFiles: [] },
        { id: "st-b", title: "", status: "merged", phase: 5, ownerFiles: [] },
        { id: "st-c", title: "", status: "merged", phase: 5, ownerFiles: [] },
      ],
    };
    const g = project_scene(state);
    expect(g.summary.currentPhaseLabel).toBe("eval+promote");
    // shared selector: active = first "building", else null (none building here)
    expect(g.summary.activeSubtask).toBeNull();
  });
});
