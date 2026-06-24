// web/hud/a11y/DomMirror.tsx — Lane C sole writer.
// project_dom(RunState) → real semantic HTML.
// Shows the SAME facts the 3D scene shows: task id, current phase, gate count,
// active subtask. Pure projection — reads ONLY from RunState; never from scene/**.
// Every colour snap has a paired persistent non-color text badge (WCAG 1.4.1).
"use client";

import React from "react";
import type { RunState, PhaseId } from "@/lib/contract/types";
import { PHASE_LABELS, STATUS_BADGE } from "./announce";

// Re-export so callers have a named function matching the contract name.
export { projectDom as project_dom };

interface DomMirrorProps {
  state: RunState;
}

/** Active phase: the highest-id phase currently "active", or the task's `.phase`. */
function activePhase(state: RunState): PhaseId {
  const active = [...state.phases]
    .reverse()
    .find((p) => p.status === "active");
  return active ? active.id : state.task.phase;
}

/** Active subtask: first subtask whose status is "building". */
function activeSubtask(state: RunState) {
  return state.subtasks.find((s) => s.status === "building") ?? null;
}

/** Raised gates count (not yet resolved). */
function raisedGateCount(state: RunState): number {
  return state.gates.filter((g) => g.status === "raised").length;
}

/**
 * Pure projection of RunState to semantic HTML.
 * This is the function name that matches the two-renderer rule in the contract README.
 */
function projectDom(state: RunState): React.ReactElement {
  const phase = activePhase(state);
  const phaseLabel = PHASE_LABELS[phase];
  const subtask = activeSubtask(state);
  const gateCount = raisedGateCount(state);

  return (
    <section aria-label="Pipeline state mirror">
      {/* Task identity */}
      <dl>
        <div>
          <dt>Task ID</dt>
          <dd data-testid="mirror-task-id">{state.task.id || "—"}</dd>
        </div>
        <div>
          <dt>Run state</dt>
          <dd data-testid="mirror-task-state">
            {/* non-color badge pairing for WCAG 1.4.1 */}
            <span data-testid="mirror-task-state-badge">
              [{state.task.state.toUpperCase()}]
            </span>{" "}
            {state.task.brief || "—"}
          </dd>
        </div>

        {/* Current phase */}
        <div>
          <dt>Current phase</dt>
          <dd data-testid="mirror-phase">
            <span data-testid="mirror-phase-id">{phase}</span>
            {" — "}
            <span data-testid="mirror-phase-label">{phaseLabel}</span>
          </dd>
        </div>

        {/* Raised gates */}
        <div>
          <dt>Open gates</dt>
          <dd data-testid="mirror-gate-count">
            {gateCount === 0 ? (
              <span>[CLEAR] 0 gates raised</span>
            ) : (
              <span data-testid="mirror-gates-raised">
                [ALERT] {gateCount} gate{gateCount !== 1 ? "s" : ""} raised
              </span>
            )}
          </dd>
        </div>

        {/* Active subtask */}
        <div>
          <dt>Active subtask</dt>
          <dd data-testid="mirror-active-subtask">
            {subtask ? (
              <>
                <span data-testid="mirror-subtask-id">{subtask.id}</span>
                {" "}
                <span data-testid="mirror-subtask-status">
                  {STATUS_BADGE[subtask.status]}
                </span>
                {subtask.title && <> — {subtask.title}</>}
              </>
            ) : (
              <span>—</span>
            )}
          </dd>
        </div>
      </dl>

      {/* Subtask list — full roster for AT navigation */}
      {state.subtasks.length > 0 && (
        <ul aria-label="Subtask roster">
          {state.subtasks.map((st) => (
            <li key={st.id} data-testid={`mirror-subtask-${st.id}`}>
              <span>{st.id}</span>
              {": "}
              <span>{STATUS_BADGE[st.status]}</span>
              {st.model && <span> ({st.model})</span>}
            </li>
          ))}
        </ul>
      )}

      {/* Raised gate detail list */}
      {state.gates.filter((g) => g.status === "raised").length > 0 && (
        <ul aria-label="Raised gates">
          {state.gates
            .filter((g) => g.status === "raised")
            .map((g) => (
              <li key={g.id} data-testid={`mirror-gate-${g.id}`}>
                <span>Gate {g.id}</span>
                {" — "}
                <span>[{g.severity.toUpperCase()}]</span>
                {": "}
                <span>{g.summary}</span>
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

/** React component wrapper — mounts the DOM mirror, accepts RunState as prop. */
export function DomMirror({ state }: DomMirrorProps) {
  return projectDom(state);
}
