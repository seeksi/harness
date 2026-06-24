// web/lib/contract/selectors.ts
// Shared pure selectors over RunState. Both projections — the 3D scene
// (scene/sceneGraph.ts) and the semantic DOM mirror (hud/a11y/DomMirror.tsx) —
// MUST derive shared "current" facts here so they can never disagree (no
// projection drift). Lives in the contract seam, importable by scene/** and
// hud/** alike.

import type { RunState, PhaseId, Subtask } from "./types";

/**
 * Current phase: the last phase in array order currently "active", else the
 * task's `.phase`. (The reducer advances phase *status*, not `task.phase`, so the
 * live current phase is derived from the phases array, not the static pointer.)
 */
export function selectActivePhase(state: RunState): PhaseId {
  for (let i = state.phases.length - 1; i >= 0; i--) {
    if (state.phases[i].status === "active") return state.phases[i].id;
  }
  return state.task.phase;
}

/**
 * The currently-active subtask: the first one that is "building", else null.
 * Shared by BOTH projections (scene + DOM mirror) so they never disagree on what
 * is active.
 */
export function selectActiveSubtask(state: RunState): Subtask | null {
  return state.subtasks.find((s) => s.status === "building") ?? null;
}
