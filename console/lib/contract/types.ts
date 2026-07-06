// console/lib/contract/types.ts
// The normalized client-side store shapes for the multi-project console. Times are
// epoch-SECONDS. All ids are stable strings. This module is provider-agnostic: the
// envelope (events.ts) carries {runId, projectId, agentId, ts, type, payload} so a
// non-harness event source (e.g. an external agent fleet) can feed the same store
// later without reworking the reducer or views. The harness is source #1 only.

// 6 LOCKED phases — decompose · build · route-cost · cross-review · merge · eval+promote.
export type PhaseId = 1 | 2 | 3 | 4 | 5 | 6;
export type PhaseStatus = "idle" | "active" | "done" | "blocked";
export type SubtaskStatus = "pending" | "building" | "reviewed" | "merged" | "blocked";
export type GateId = "A" | "B" | "C" | "D"; // A budget · B review-block · C integration-red · D anomaly
export type GateStatus = "clear" | "raised" | "approved" | "rejected";
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export type HealthVerdict = "healthy" | "degraded" | "stuck";
export type RunLifecycle = "running" | "done" | "failed";

export const PHASE_LABELS: Record<PhaseId, string> = {
  1: "decompose",
  2: "build",
  3: "route-cost",
  4: "cross-review",
  5: "merge",
  6: "eval+promote",
};

// Context-fill thresholds (fraction of the model window) — unchanged harness semantics.
// SOFT 60% = amber warn + handoff prep; HARD 75% = red + HANDOFF respawn expected.
export const CONTEXT_SOFT = 0.6;
export const CONTEXT_HARD = 0.75;

// A run with an incomplete phase and NO event for this many seconds is "stuck".
export const STALENESS_WINDOW_SEC = 60;

// Trace feed ring-buffer cap so multi-hour runs never grow the DOM unbounded.
export const TRACE_WINDOW = 400;

// System-managed concurrency cap: at most this many active lanes render side-by-side.
export const MAX_LANES = 3;

// Derived-$ garnish: tokens are primary. Blended $/million-tokens per route-cost tier.
// ponytail: flat blended rate; swap for the daemon's real tier map when the bridge lands.
export const TIER_RATE_USD_PER_MTOK: Record<string, number> = {
  haiku: 1,
  sonnet: 3,
  opus: 15,
};

export interface Subtask {
  id: string;
  title: string;
  status: SubtaskStatus;
  phase: PhaseId;
  model?: "haiku" | "sonnet" | "opus";
}

export interface PhaseState {
  id: PhaseId;
  label: string;
  status: PhaseStatus;
  // Inline human-judgment points (decompose split, promote-to-main).
  approval?: { kind: "decompose-split" | "promote-to-main"; state: "awaiting" | "approved" | "rejected" };
}

export interface Gate {
  id: GateId;
  status: GateStatus;
  severity: Severity;
  summary: string;
  subtaskId?: string;
  raisedAt?: number;
  evidence?: { diff?: string; trace?: string; eval?: string };
}

export interface TraceTick {
  ts: number;
  agentId: string;
  tool: string;
  sig: string;
  laneId?: string;
}

// ACTUAL per-lane usage the agent reported. Context gauge compares
// cacheReadTokens+inputTokens vs contextWindow. Tokens are the primary unit.
export interface LaneUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  costUsd: number;
}

export interface RunUsage {
  lanes: Record<string, LaneUsage>; // keyed by laneId (subtask id or "_run")
  totalTokens: number;
  totalCostUsd: number;
}

export interface EvalResult {
  regressionPass: boolean;
  capabilityScore: number; // 0..1
}

export interface RunState {
  runId: string;
  projectId: string;
  projectName: string;
  brief: string;
  status: RunLifecycle;
  startedAt: number;
  lastEventTs: number; // ts of the most recent envelope folded into this run
  phases: PhaseState[];
  subtasks: Subtask[];
  gates: Gate[];
  trace: TraceTick[];
  usage: RunUsage;
  // The verdict the PRODUCER last reported (trajectory anomaly detection etc.).
  // The EFFECTIVE verdict (combining this with client-side staleness) is derived
  // by health.ts:deriveHealth — never store the derived value.
  reportedHealth: HealthVerdict;
  evals?: EvalResult;
}

// Up to MAX_LANES active runs + recent finished ones, keyed by runId.
export interface FleetState {
  runs: Record<string, RunState>;
  order: string[]; // insertion order of runIds; lane sort (alerts-to-top) is a selector
}

export function seedPhases(): PhaseState[] {
  return (Object.keys(PHASE_LABELS) as unknown as string[]).map((k) => {
    const id = Number(k) as PhaseId;
    return { id, label: PHASE_LABELS[id], status: "idle" as PhaseStatus };
  });
}

export function newRun(runId: string, projectId: string, projectName: string, brief: string, ts: number): RunState {
  return {
    runId,
    projectId,
    projectName,
    brief,
    status: "running",
    startedAt: ts,
    lastEventTs: ts,
    phases: seedPhases(),
    subtasks: [],
    gates: [],
    trace: [],
    usage: { lanes: {}, totalTokens: 0, totalCostUsd: 0 },
    reportedHealth: "healthy",
  };
}

export const initialFleetState: FleetState = { runs: {}, order: [] };
