// console/lib/contract/events.ts
// The provider-agnostic wire contract + the pure fleet reducer.
//
// EVERY event is an envelope: { runId, projectId, agentId, ts, type, payload }.
// `type` discriminates the payload. Six typed domain events (phase · subtask · gate ·
// usage · trace · health) plus one control frame (`sync`, the hello/replay resync).
// The reducer is TOTAL over Envelope and drops unknown `type` (forward-compat), so a
// future adapter can add event kinds without breaking this store.

import type {
  RunState,
  FleetState,
  PhaseId,
  PhaseStatus,
  SubtaskStatus,
  GateId,
  GateStatus,
  Severity,
  HealthVerdict,
  Subtask,
  Gate,
  LaneUsage,
  EvalResult,
} from "./types";
import { TRACE_WINDOW, newRun } from "./types";

// --- typed payloads ---------------------------------------------------------------
export interface PhasePayload {
  phase: PhaseId;
  status: PhaseStatus;
  approval?: { kind: "decompose-split" | "promote-to-main"; state: "awaiting" | "approved" | "rejected" };
}
export interface SubtaskPayload {
  id: string;
  status: SubtaskStatus;
  phase?: PhaseId;
  title?: string;
  model?: Subtask["model"];
}
export interface GatePayload {
  id: GateId;
  status: GateStatus;
  severity: Severity;
  summary: string;
  subtaskId?: string;
  evidence?: Gate["evidence"];
}
export interface UsagePayload {
  laneId?: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  costUsd: number;
}
export interface TracePayload {
  tool: string;
  sig: string;
  laneId?: string;
}
export interface HealthPayload {
  verdict: HealthVerdict;
  note?: string;
  // Run-quality signals ride the health channel (regression pass + capability score).
  evals?: EvalResult;
  // Explicit lifecycle transition when the producer knows it (e.g. spawn failure → failed).
  lifecycle?: RunState["status"];
}
// Control frame: full run snapshot for hello-on-connect and post-reconnect resync.
export interface SyncPayload {
  run: RunState;
}

// --- envelope ---------------------------------------------------------------------
interface Base {
  runId: string;
  projectId: string;
  agentId: string;
  ts: number; // epoch-seconds
}
export type Envelope =
  | (Base & { type: "phase"; payload: PhasePayload })
  | (Base & { type: "subtask"; payload: SubtaskPayload })
  | (Base & { type: "gate"; payload: GatePayload })
  | (Base & { type: "usage"; payload: UsagePayload })
  | (Base & { type: "trace"; payload: TracePayload })
  | (Base & { type: "health"; payload: HealthPayload })
  | (Base & { type: "sync"; payload: SyncPayload });

export type EventType = Envelope["type"];

// --- run-level reducer ------------------------------------------------------------
// Folds one envelope into ONE run. `sync` is handled at the fleet level (wholesale).
function reduceRun(run: RunState, env: Envelope): RunState {
  const withTs: RunState = { ...run, lastEventTs: Math.max(run.lastEventTs, env.ts) };

  switch (env.type) {
    case "phase": {
      const { phase, status, approval } = env.payload;
      const phases = run.phases.map((p) =>
        p.id === phase ? { ...p, status, ...(approval ? { approval } : {}) } : p
      );
      // Phase 6 done = run completed (the "run-completed" alert + green-pulse signal).
      const status6Done = phase === 6 && status === "done";
      return { ...withTs, phases, status: status6Done ? "done" : run.status };
    }

    case "subtask": {
      const { id, status, phase, title, model } = env.payload;
      const existing = run.subtasks.find((s) => s.id === id);
      if (existing) {
        const merged: Subtask = {
          ...existing,
          status,
          ...(phase !== undefined && { phase }),
          ...(title !== undefined && { title }),
          ...(model !== undefined && { model }),
        };
        return { ...withTs, subtasks: run.subtasks.map((s) => (s.id === id ? merged : s)) };
      }
      const fresh: Subtask = {
        id,
        title: title ?? id,
        status,
        phase: phase ?? run.phases.find((p) => p.status === "active")?.id ?? 1,
        ...(model !== undefined && { model }),
      };
      return { ...withTs, subtasks: [...run.subtasks, fresh] };
    }

    case "gate": {
      const { id } = env.payload;
      const raisedAt = env.payload.status === "raised" ? env.ts : undefined;
      const existing = run.gates.find((g) => g.id === id);
      if (existing) {
        return {
          ...withTs,
          gates: run.gates.map((g) =>
            g.id === id ? { ...g, ...env.payload, ...(raisedAt ? { raisedAt } : {}) } : g
          ),
        };
      }
      return { ...withTs, gates: [...run.gates, { ...env.payload, ...(raisedAt ? { raisedAt } : {}) } as Gate] };
    }

    case "usage": {
      const p = env.payload;
      const laneKey = p.laneId ?? "_run";
      const prev = run.usage.lanes[laneKey];
      const lane: LaneUsage = {
        ...(p.model !== undefined && { model: p.model }),
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        cacheReadTokens: p.cacheReadTokens,
        cacheCreationTokens: p.cacheCreationTokens,
        contextWindow: p.contextWindow,
        costUsd: p.costUsd,
      };
      const lanes = { ...run.usage.lanes, [laneKey]: lane };
      // Totals recomputed from lanes so re-reporting a lane can't double-count.
      let totalTokens = 0;
      let totalCostUsd = 0;
      for (const l of Object.values(lanes)) {
        totalTokens += l.inputTokens + l.outputTokens + l.cacheReadTokens + l.cacheCreationTokens;
        totalCostUsd += l.costUsd;
      }
      void prev;
      return { ...withTs, usage: { lanes, totalTokens, totalCostUsd } };
    }

    case "trace": {
      const tick = { ts: env.ts, agentId: env.agentId, tool: env.payload.tool, sig: env.payload.sig, laneId: env.payload.laneId };
      const ring = [...run.trace, tick];
      return { ...withTs, trace: ring.length > TRACE_WINDOW ? ring.slice(ring.length - TRACE_WINDOW) : ring };
    }

    case "health": {
      const { verdict, evals, lifecycle } = env.payload;
      return {
        ...withTs,
        reportedHealth: verdict,
        ...(evals !== undefined && { evals }),
        ...(lifecycle !== undefined && { status: lifecycle }),
      };
    }

    default:
      return withTs; // unreachable for domain events; `sync` handled at fleet level
  }
}

// --- fleet reducer ----------------------------------------------------------------
export function fleetReducer(state: FleetState, env: Envelope): FleetState {
  // Forward-compat: an envelope with an unknown type is dropped untouched.
  const known: EventType[] = ["phase", "subtask", "gate", "usage", "trace", "health", "sync"];
  if (!known.includes(env.type)) return state;

  if (env.type === "sync") {
    // Wholesale replace this run (the only resync path — post-reconnect consistency).
    const run = env.payload.run;
    const inOrder = state.order.includes(run.runId) ? state.order : [...state.order, run.runId];
    return { runs: { ...state.runs, [run.runId]: run }, order: inOrder };
  }

  const existing = state.runs[env.runId];
  const base =
    existing ??
    newRun(env.runId, env.projectId, env.projectId, "", env.ts); // name backfilled by a later sync
  const nextRun = reduceRun(base, env);
  const inOrder = state.order.includes(env.runId) ? state.order : [...state.order, env.runId];
  return { runs: { ...state.runs, [env.runId]: nextRun }, order: inOrder };
}

export function foldFleet(envelopes: Envelope[], initial: FleetState): FleetState {
  return envelopes.reduce(fleetReducer, initial);
}
