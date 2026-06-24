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
} from "./types";

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
  | { type: "approval"; phase: PhaseId; kind: NonNullable<PhaseState["approval"]>["kind"]; state: "awaiting" | "approved" | "rejected" }
  | { type: "hello"; run: RunState };

// The reducer must be total over SSEEvent and drop any unknown `type` (forward-compat).
// `subtask` deltas merge (not replace); `hello` replaces wholesale. Body is Lane A's.
export function reducer(_state: RunState, _event: SSEEvent): RunState {
  throw new Error("reducer: implemented in Lane A");
}
