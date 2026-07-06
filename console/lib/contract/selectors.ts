// console/lib/contract/selectors.ts
// Pure metric derivations off RunState/FleetState (§6). No React, no side effects.

import type { RunState, FleetState, PhaseId, GateId, Gate } from "./types";
import { MAX_LANES } from "./types";

// Phase position — the 10-second answer. Current = the active phase, else the last done.
export function currentPhase(run: RunState): PhaseId {
  const active = run.phases.find((p) => p.status === "active" || p.status === "blocked");
  if (active) return active.id;
  const done = [...run.phases].reverse().find((p) => p.status === "done");
  return done?.id ?? 1;
}

export interface SubtaskCounts {
  pending: number;
  building: number;
  done: number; // reviewed | merged
  blocked: number;
  total: number;
}
export function subtaskCounts(run: RunState): SubtaskCounts {
  const c: SubtaskCounts = { pending: 0, building: 0, done: 0, blocked: 0, total: run.subtasks.length };
  for (const s of run.subtasks) {
    if (s.status === "building") c.building++;
    else if (s.status === "pending") c.pending++;
    else if (s.status === "blocked") c.blocked++;
    else c.done++; // reviewed | merged
  }
  return c;
}

export function gate(run: RunState, id: GateId): Gate | undefined {
  return run.gates.find((g) => g.id === id);
}
export function raisedGates(run: RunState): Gate[] {
  return run.gates.filter((g) => g.status === "raised");
}
export function hasRaisedGate(run: RunState): boolean {
  return run.gates.some((g) => g.status === "raised");
}

// Context fill = max across lanes of (input + cacheRead) / window. 0..1.
export function contextFill(run: RunState): number {
  let max = 0;
  for (const l of Object.values(run.usage.lanes)) {
    if (l.contextWindow <= 0) continue;
    const used = (l.inputTokens + l.cacheReadTokens) / l.contextWindow;
    if (used > max) max = used;
  }
  return max;
}

export function totalTokens(run: RunState): number {
  return run.usage.totalTokens;
}

// Alerts sort to top: runs with raised gates first, then stuck/degraded, then by recency.
export function laneOrder(state: FleetState): RunState[] {
  const runs = state.order.map((id) => state.runs[id]).filter(Boolean);
  const score = (r: RunState): number => {
    if (hasRaisedGate(r)) return 0;
    if (r.reportedHealth === "stuck") return 1;
    if (r.reportedHealth === "degraded") return 2;
    if (r.status === "running") return 3;
    return 4;
  };
  return [...runs].sort((a, b) => score(a) - score(b) || b.lastEventTs - a.lastEventTs);
}

// The up-to-3 active lanes to render side-by-side.
export function activeLanes(state: FleetState): RunState[] {
  return laneOrder(state)
    .filter((r) => r.status === "running")
    .slice(0, MAX_LANES);
}
