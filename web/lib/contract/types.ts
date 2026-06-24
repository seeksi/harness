// web/lib/contract/types.ts
// FROZEN — ADR 0001 §2.2. The normalized client-side store shape: the single source
// of truth both projections (scene = Lane B, dom = Lane C) read. Times are
// epoch-seconds (matching the trace `ts` field); all ids are stable strings.
// Authored by Lane A. Imported (never redefined) by Lanes B and C.

export type PhaseId = 1 | 2 | 3 | 4 | 5 | 6; // decompose · build · route-cost · cross-review · merge · eval+promote
export type SubtaskStatus = "pending" | "building" | "reviewed" | "merged" | "blocked";
export type GateId = "A" | "B" | "C" | "D"; // A budget · B review-block · C integration-red · D anomaly
export type Severity = "info" | "low" | "medium" | "high" | "critical";

export interface Subtask {
  id: string;
  title: string;
  status: SubtaskStatus;
  phase: PhaseId;
  ownerFiles: string[];
  model?: "haiku" | "sonnet" | "opus";
}

export interface PhaseState {
  id: PhaseId;
  label: string;
  status: "idle" | "active" | "done" | "blocked";
  approval?: { kind: "decompose-split" | "promote-to-main"; state: "awaiting" | "approved" | "rejected" };
}

export interface Gate {
  id: GateId;
  status: "clear" | "raised" | "resolved";
  severity: Severity;
  subtaskId?: string;
  counts?: { high: number; critical: number };
  summary: string;
  raisedAt?: number;
  traceReady?: boolean;
}

export interface AgentEvent {
  id: string;
  subtaskId: string;
  kind: "route" | "review" | "gate" | "merge" | "promote";
  severity: Severity;
  firedAt: number;
}

export interface TraceTick {
  ts: number;
  tool: string;
  sig: string;
  subtaskId?: string;
}

export interface Budget {
  ceilingUsd: number;
  estimatedUsd: number;
  spentUsd?: number;
  overBy?: number;
}

// ACTUAL per-lane usage the agent reported (distinct from Budget, which is the Gate-A
// cost CEILING). The HUD context gauge compares cacheReadTokens+inputTokens vs
// contextWindow; the cost panel sums costUsd into totalCostUsd.
export interface LaneUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  costUsd: number;
}

export interface Usage {
  lanes: Record<string, LaneUsage>; // keyed by subtaskId
  totalCostUsd: number;
}

export interface RunState {
  task: { id: string; brief: string; phase: PhaseId; state: "idle" | "running" | "done" | "failed" };
  subtasks: Subtask[];
  phases: PhaseState[];
  gates: Gate[];
  agentEvents: AgentEvent[];
  trace: TraceTick[];
  budget: Budget;
  usage: Usage;
  ui: {
    openDetail: { kind: "gate" | "phase" | null; id: string | null };
    pendingToast?: { gate: GateId; message: string };
  };
}

// ring-buffer cap; B's store (lib/store/store.ts) and C's drawer (hud/TraceDrawer.tsx)
// agree on this bound so the trace feed never grows unbounded (ADR risk 17).
export const TRACE_WINDOW = 500;

// The canonical idle RunState. Defined, never undefined: qa requires getSnapshot()
// to return a defined value before any event arrives. The six-phase rail is seeded
// idle with its locked labels; everything else is empty / zeroed.
export const initialRunState: RunState = {
  task: { id: "", brief: "", phase: 1, state: "idle" },
  subtasks: [],
  phases: [
    { id: 1, label: "decompose", status: "idle" },
    { id: 2, label: "build", status: "idle" },
    { id: 3, label: "route-cost", status: "idle" },
    { id: 4, label: "cross-review", status: "idle" },
    { id: 5, label: "merge", status: "idle" },
    { id: 6, label: "eval+promote", status: "idle" },
  ],
  gates: [],
  agentEvents: [],
  trace: [],
  budget: { ceilingUsd: 0, estimatedUsd: 0 },
  usage: { lanes: {}, totalCostUsd: 0 },
  ui: { openDetail: { kind: null, id: null } },
};
