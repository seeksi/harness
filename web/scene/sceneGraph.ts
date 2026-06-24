// web/scene/sceneGraph.ts
// Lane B — `project_scene(RunState)`: the pure projection from the normalized
// store state into a minimal scene graph of node/edge descriptors. This is the
// only place the scene derives geometry from state; Canvas/NodeGraph just read
// the result in the frame loop. Pure function, no r3f/three imports, no DOM —
// trivially unit-testable and safe on zero-state.
//
// This increment is intentionally minimal: a phase rail (the six locked phases)
// plus one node per subtask, a summary label, and edge connectors. NO ambient
// graphify field, NO instancing layout, NO bloom/motion — those are later
// increments (see ponytail notes at the bottom).

import type { RunState, PhaseId, SubtaskStatus } from "@/lib/contract/types";
import { selectActivePhase } from "@/lib/contract/selectors";

export interface SceneNode {
  id: string;
  kind: "task" | "phase" | "subtask";
  label: string;
  /** simple laid-out position; [x,y,z]. Minimal deterministic layout, no physics. */
  position: [number, number, number];
  /** small status hint the renderer can map to a color/mesh later. */
  status?: string;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
}

export interface SceneGraph {
  /** headline projected facts NodeGraph renders as plain 3D text. */
  summary: {
    taskId: string;
    currentPhase: PhaseId;
    currentPhaseLabel: string;
    gateCount: number;
    raisedGateCount: number;
    activeSubtask: string | null;
  };
  nodes: SceneNode[];
  edges: SceneEdge[];
}

const PHASE_SPACING = 2;
const SUBTASK_SPACING = 1.5;

// "active" = the subtask currently being worked: the first one that is building,
// else the first non-terminal one. Pure heuristic, deterministic over the array.
const ACTIVE_ORDER: SubtaskStatus[] = ["building", "blocked", "reviewed", "pending"];

function pickActiveSubtask(state: RunState): string | null {
  for (const status of ACTIVE_ORDER) {
    const hit = state.subtasks.find((s) => s.status === status);
    if (hit) return hit.id;
  }
  return state.subtasks[0]?.id ?? null;
}

export function project_scene(state: RunState): SceneGraph {
  const raisedGateCount = state.gates.filter((g) => g.status === "raised").length;
  // Shared selector — same derivation the DOM mirror uses, so the two projections
  // never disagree on the current phase (drift fix).
  const currentPhase = selectActivePhase(state);
  const currentPhaseLabel =
    state.phases.find((p) => p.id === currentPhase)?.label ?? String(currentPhase);
  const activeSubtask = pickActiveSubtask(state);

  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];

  // task root node
  const taskNodeId = "task";
  nodes.push({
    id: taskNodeId,
    kind: "task",
    label: state.task.id || "(no task)",
    position: [0, 2, 0],
    status: state.task.state,
  });

  // phase rail along x
  const half = (state.phases.length - 1) / 2;
  for (let i = 0; i < state.phases.length; i++) {
    const phase = state.phases[i];
    const nodeId = `phase-${phase.id}`;
    nodes.push({
      id: nodeId,
      kind: "phase",
      label: phase.label,
      position: [(i - half) * PHASE_SPACING, 0, 0],
      status: phase.status,
    });
    edges.push({ id: `e-task-${nodeId}`, from: taskNodeId, to: nodeId });
  }

  // subtask nodes hung below their phase
  const subHalf = (state.subtasks.length - 1) / 2;
  for (let i = 0; i < state.subtasks.length; i++) {
    const sub = state.subtasks[i];
    const nodeId = `subtask-${sub.id}`;
    nodes.push({
      id: nodeId,
      kind: "subtask",
      label: sub.title || sub.id,
      position: [(i - subHalf) * SUBTASK_SPACING, -2, 0],
      status: sub.status,
    });
    edges.push({ id: `e-${nodeId}`, from: `phase-${sub.phase}`, to: nodeId });
  }

  return {
    summary: {
      taskId: state.task.id || "(no task)",
      currentPhase,
      currentPhaseLabel,
      gateCount: state.gates.length,
      raisedGateCount,
      activeSubtask,
    },
    nodes,
    edges,
  };
}

// ponytail: minimal projection ceiling.
// skipped: ambient graphify field, add when the backdrop increment lands (≤2k instanced nodes + LOD/cull).
// skipped: instanced layout / draw-call budgeting, add when node count grows past ~40 live nodes.
// skipped: agent-fire / firedAt stagger projection, add with the AgentFire+motion increment.
