// web/lib/contract/events.ts
// FROZEN — ADR 0001 §2.3. The SSE wire contract (one discriminated union over `type`)
// plus the reducer SIGNATURE. Lane A produces the stream and implements the reducer
// body; Lanes B and C import the type and the signature only.
//
// Lane 0 freezes the seam — it does NOT implement the reducer.

import type {
  RunState,
  PhaseId,
  PhaseState,
  GateId,
  Severity,
  Gate,
  SubtaskStatus,
  Subtask,
  AgentEvent,
  LaneUsage,
} from "./types";
import { TRACE_WINDOW } from "./types";

export type SSEEvent =
  | { type: "phase"; phase: PhaseId; status: PhaseState["status"] }
  | { type: "subtask"; id: string; status: SubtaskStatus; phase?: PhaseId; model?: Subtask["model"] }
  | {
      type: "gate";
      id: GateId;
      status: Gate["status"];
      severity: Severity;
      subtaskId?: string;
      counts?: Gate["counts"];
      summary: string;
      traceReady?: boolean;
    }
  | { type: "agentFire"; id: string; subtaskId: string; kind: AgentEvent["kind"]; severity: Severity; firedAt: number }
  | { type: "trace"; ts: number; tool: string; sig: string; subtaskId?: string }
  | { type: "budget"; ceilingUsd: number; estimatedUsd: number; spentUsd?: number; overBy?: number }
  | {
      type: "usage";
      subtaskId?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      contextWindow: number;
      costUsd: number;
    }
  | { type: "approval"; phase: PhaseId; kind: NonNullable<PhaseState["approval"]>["kind"]; state: "awaiting" | "approved" | "rejected" }
  | { type: "hello"; run: RunState };

// Bloom-decay window for agentFire dedup (seconds). Events older than this are pruned.
export const AGENT_BLOOM_WINDOW = 60;

// The reducer must be total over SSEEvent and drop any unknown `type` (forward-compat).
// `subtask` deltas merge (not replace); `hello` replaces wholesale. Body is Lane A's.
export function reducer(state: RunState, event: SSEEvent): RunState {
  switch (event.type) {
    case "hello":
      // Wholesale replace — the only resync path.
      return event.run;

    case "phase": {
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.id === event.phase ? { ...p, status: event.status } : p
        ),
      };
    }

    case "subtask": {
      const existing = state.subtasks.find((s) => s.id === event.id);
      if (existing) {
        // MERGE delta: only overwrite fields the event actually carries.
        const merged: Subtask = {
          ...existing,
          status: event.status,
          ...(event.phase !== undefined && { phase: event.phase }),
          ...(event.model !== undefined && { model: event.model }),
        };
        return {
          ...state,
          subtasks: state.subtasks.map((s) => (s.id === event.id ? merged : s)),
        };
      }
      // New subtask — seed with required fields; optional fields only if present.
      const fresh: Subtask = {
        id: event.id,
        title: event.id, // title not on wire; use id as placeholder until hello resync
        status: event.status,
        phase: event.phase ?? state.task.phase,
        ownerFiles: [],
        ...(event.model !== undefined && { model: event.model }),
      };
      return { ...state, subtasks: [...state.subtasks, fresh] };
    }

    case "gate": {
      const { type: _t, ...gateFields } = event;
      const existing = state.gates.find((g) => g.id === event.id);
      if (existing) {
        return {
          ...state,
          gates: state.gates.map((g) => (g.id === event.id ? { ...g, ...gateFields } : g)),
        };
      }
      return { ...state, gates: [...state.gates, gateFields as Gate] };
    }

    case "agentFire": {
      const { type: _t, ...evFields } = event;
      const newEvent = evFields as AgentEvent;
      // Dedup by id; prune by bloom-decay window from the newest firedAt.
      const nowish = newEvent.firedAt;
      const cutoff = nowish - AGENT_BLOOM_WINDOW;
      const deduped = state.agentEvents.filter((e) => e.id !== newEvent.id && e.firedAt >= cutoff);
      return { ...state, agentEvents: [...deduped, newEvent] };
    }

    case "trace": {
      const { type: _t, ...tick } = event;
      const ring = [...state.trace, tick];
      // Cap ring buffer at TRACE_WINDOW (drop oldest first).
      return {
        ...state,
        trace: ring.length > TRACE_WINDOW ? ring.slice(ring.length - TRACE_WINDOW) : ring,
      };
    }

    case "budget": {
      const { type: _t, ...b } = event;
      return { ...state, budget: b };
    }

    case "usage": {
      // ACTUAL usage (not the Gate-A ceiling). Merge into the lane keyed by subtaskId
      // (fall back to a single "_run" bucket when the event carries no lane) and bump
      // the run total by this event's cost.
      const laneKey = event.subtaskId ?? "_run";
      const lane: LaneUsage = {
        ...(event.model !== undefined && { model: event.model }),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        contextWindow: event.contextWindow,
        costUsd: event.costUsd,
      };
      return {
        ...state,
        usage: {
          lanes: { ...state.usage.lanes, [laneKey]: lane },
          totalCostUsd: state.usage.totalCostUsd + event.costUsd,
        },
      };
    }

    case "approval": {
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.id === event.phase
            ? { ...p, approval: { kind: event.kind, state: event.state } }
            : p
        ),
      };
    }

    default:
      // Forward-compat: unknown event type → return state unchanged (no throw).
      return state;
  }
}
