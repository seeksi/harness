// console/lib/contract/fixture.ts
// Deterministic fixture producer — replays a convincing THREE-lane run so the fleet
// home, phase rails, burn meters, gates and health verdicts all have one shared
// ground truth (dev/demo source; the live harness.sh bridge is Batch B+).
//
// Lanes, chosen to exercise every state at once:
//   L1  hangar   · "console" build  — healthy, mid-build, 3 subtasks streaming.
//   L2  vector   · "dropship-agent" — cross-review BLOCK: Gate B raised (alert lane).
//   L3  ledger   · "memory-os"      — eval+promote, promote-to-main awaiting approval.
//
// Times are epoch-seconds; deltas are what matter. Envelopes are returned globally
// sorted by ts so a streaming replay plays the lanes interleaved.

import type { Envelope } from "./events";
import { newRun } from "./types";

const T = 1_751_000_000; // base epoch-seconds

interface Lane {
  runId: string;
  projectId: string;
  projectName: string;
  brief: string;
}

const L1: Lane = { runId: "run-console", projectId: "console", projectName: "hangar", brief: "Build the mission-control console foundation" };
const L2: Lane = { runId: "run-dropship", projectId: "dropship-agent", projectName: "vector", brief: "Nightly price-sync + reorder agent" };
const L3: Lane = { runId: "run-memoryos", projectId: "memory-os", projectName: "ledger", brief: "Second-brain retrieval packets v2" };

function sync(lane: Lane, ts: number): Envelope {
  const run = newRun(lane.runId, lane.projectId, lane.projectName, lane.brief, ts);
  return { runId: lane.runId, projectId: lane.projectId, agentId: "orchestrator", ts, type: "sync", payload: { run } };
}

// Terse per-lane envelope builder.
function e(lane: Lane, agentId: string, ts: number, type: Envelope["type"], payload: unknown): Envelope {
  return { runId: lane.runId, projectId: lane.projectId, agentId, ts, type, payload } as Envelope;
}

function laneOne(): Envelope[] {
  const l = L1;
  return [
    sync(l, T),
    e(l, "orchestrator", T + 1, "phase", { phase: 1, status: "active" }),
    e(l, "orchestrator", T + 2, "subtask", { id: "st-a", title: "design tokens", status: "pending", phase: 1 }),
    e(l, "orchestrator", T + 2, "subtask", { id: "st-b", title: "event contract", status: "pending", phase: 1 }),
    e(l, "orchestrator", T + 2, "subtask", { id: "st-c", title: "server platform", status: "pending", phase: 1 }),
    e(l, "orchestrator", T + 4, "phase", { phase: 1, status: "done" }),
    e(l, "orchestrator", T + 5, "phase", { phase: 3, status: "active" }),
    e(l, "route", T + 6, "subtask", { id: "st-a", status: "pending", phase: 3, model: "sonnet" }),
    e(l, "route", T + 6, "subtask", { id: "st-b", status: "pending", phase: 3, model: "opus" }),
    e(l, "route", T + 6, "subtask", { id: "st-c", status: "pending", phase: 3, model: "sonnet" }),
    e(l, "orchestrator", T + 7, "phase", { phase: 3, status: "done" }),
    e(l, "orchestrator", T + 8, "phase", { phase: 2, status: "active" }),
    e(l, "build:a", T + 9, "subtask", { id: "st-a", status: "building", phase: 2 }),
    e(l, "build:b", T + 9, "subtask", { id: "st-b", status: "building", phase: 2 }),
    e(l, "build:c", T + 10, "subtask", { id: "st-c", status: "building", phase: 2 }),
    e(l, "build:a", T + 11, "trace", { tool: "Read", sig: "lib/contract/types.ts", laneId: "st-a" }),
    e(l, "build:b", T + 12, "trace", { tool: "Edit", sig: "lib/contract/events.ts", laneId: "st-b" }),
    e(l, "build:c", T + 13, "trace", { tool: "Bash", sig: "vitest run", laneId: "st-c" }),
    e(l, "build:a", T + 14, "usage", { laneId: "st-a", model: "sonnet", inputTokens: 42000, outputTokens: 8100, cacheReadTokens: 30000, cacheCreationTokens: 6000, contextWindow: 200000, costUsd: 0.62 }),
    e(l, "build:b", T + 15, "usage", { laneId: "st-b", model: "opus", inputTokens: 55000, outputTokens: 14200, cacheReadTokens: 40000, cacheCreationTokens: 12000, contextWindow: 200000, costUsd: 3.1 }),
    e(l, "build:c", T + 16, "usage", { laneId: "st-c", model: "sonnet", inputTokens: 31000, outputTokens: 5200, cacheReadTokens: 20000, cacheCreationTokens: 4000, contextWindow: 200000, costUsd: 0.44 }),
    e(l, "build:b", T + 18, "trace", { tool: "Write", sig: "lib/server/persist.ts", laneId: "st-b" }),
    e(l, "orchestrator", T + 20, "health", { verdict: "healthy" }),
  ];
}

function laneTwo(): Envelope[] {
  const l = L2;
  return [
    sync(l, T + 1),
    e(l, "orchestrator", T + 3, "phase", { phase: 1, status: "done" }),
    e(l, "orchestrator", T + 3, "phase", { phase: 3, status: "done" }),
    e(l, "orchestrator", T + 3, "phase", { phase: 2, status: "done" }),
    e(l, "orchestrator", T + 4, "subtask", { id: "px-a", title: "price scraper", status: "reviewed", phase: 4, model: "sonnet" }),
    e(l, "orchestrator", T + 4, "subtask", { id: "px-b", title: "reorder policy", status: "blocked", phase: 4, model: "opus" }),
    e(l, "orchestrator", T + 5, "phase", { phase: 4, status: "blocked" }),
    // px-b is under context pressure (80% — over the 75% hard threshold, red) as well as gate-blocked.
    e(l, "review:b", T + 6, "usage", { laneId: "px-b", model: "opus", inputTokens: 120000, outputTokens: 22000, cacheReadTokens: 40000, cacheCreationTokens: 9000, contextWindow: 200000, costUsd: 4.8 }),
    e(l, "review:b", T + 7, "gate", {
      id: "B", status: "raised", severity: "high", subtaskId: "px-b",
      summary: "cross-review BLOCK on px-b: 2 high findings unresolved",
      evidence: { diff: "worktree/px-b.diff", trace: "trace/px-b", eval: "eval/px-b" },
    }),
    e(l, "review:b", T + 8, "trace", { tool: "Grep", sig: "await fetch(", laneId: "px-b" }),
    e(l, "orchestrator", T + 9, "health", { verdict: "degraded", note: "Gate B raised on px-b" }),
  ];
}

function laneThree(): Envelope[] {
  const l = L3;
  const done = (id: string, title: string, model: "haiku" | "sonnet" | "opus") =>
    e(l, "orchestrator", T + 3, "subtask", { id, title, status: "merged", phase: 5, model });
  return [
    sync(l, T + 2),
    e(l, "orchestrator", T + 3, "phase", { phase: 1, status: "done" }),
    e(l, "orchestrator", T + 3, "phase", { phase: 3, status: "done" }),
    e(l, "orchestrator", T + 3, "phase", { phase: 2, status: "done" }),
    e(l, "orchestrator", T + 3, "phase", { phase: 4, status: "done" }),
    done("mp-a", "packet router", "sonnet"),
    done("mp-b", "hit ranker", "haiku"),
    e(l, "orchestrator", T + 4, "phase", { phase: 5, status: "done" }),
    e(l, "merge", T + 5, "usage", { laneId: "mp-a", model: "sonnet", inputTokens: 60000, outputTokens: 9000, cacheReadTokens: 40000, cacheCreationTokens: 7000, contextWindow: 200000, costUsd: 0.9 }),
    e(l, "merge", T + 5, "usage", { laneId: "mp-b", model: "haiku", inputTokens: 20000, outputTokens: 3000, cacheReadTokens: 15000, cacheCreationTokens: 2000, contextWindow: 200000, costUsd: 0.08 }),
    e(l, "orchestrator", T + 6, "phase", { phase: 6, status: "active" }),
    e(l, "eval", T + 7, "health", { verdict: "healthy", evals: { regressionPass: true, capabilityScore: 0.86 } }),
    e(l, "orchestrator", T + 8, "phase", {
      phase: 6, status: "active",
      approval: { kind: "promote-to-main", state: "awaiting" },
    }),
  ];
}

// All envelopes, globally sorted by ts (stable within equal ts).
export function fixtureEnvelopes(): Envelope[] {
  const all = [...laneOne(), ...laneTwo(), ...laneThree()];
  return all
    .map((env, i) => ({ env, i }))
    .sort((a, b) => a.env.ts - b.env.ts || a.i - b.i)
    .map(({ env }) => env);
}
