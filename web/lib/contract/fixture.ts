// web/lib/contract/fixture.ts
// FROZEN ARTIFACT — the canonical deterministic transcript. Lanes B and C build
// against the SAME BYTES so the scene projection, the DOM mirror, and the store's
// flush/stagger logic all have one shared ground truth. NOTES §"Lane 0".
//
// Order (intentional, do not reshuffle — the stagger + co-fire logic depends on it):
//   1. hello          — idle run snapshot on connect (the only resync path)
//   2. phase/subtask  — decompose → build progression
//   3. budget         — route-cost pricing under ceiling
//   4. trace ticks    — drawer-only feed (never enters the scene graph)
//   5. GATE B + GATE D CO-FIRE BURST — two gate events + agentFires with close
//      `firedAt` deltas so the 80–120ms severity-ordered stagger has a real case
//   6. approval       — inline promote-to-main awaiting human judgment
//   7. promote-preview tail — phase 6 active, preview-only (non-mutating)
//
// Times are epoch-seconds. Base epoch chosen for readability; deltas are what matter.

import type { SSEEvent } from "./events";
import { initialRunState } from "./types";

const T = 1_750_000_000; // base epoch-seconds for the transcript

export const dryRun: SSEEvent[] = [
  // --- 1. hello: full idle snapshot on connect ---------------------------------
  {
    type: "hello",
    run: {
      ...initialRunState,
      task: { id: "run-fixture", brief: "Build the Umbrella web UI", phase: 1, state: "running" },
    },
  },

  // --- 2. phase 1 (decompose) goes active, three subtasks appear ---------------
  { type: "phase", phase: 1, status: "active" },
  { type: "subtask", id: "st-a", status: "pending", phase: 1 },
  { type: "subtask", id: "st-b", status: "pending", phase: 1 },
  { type: "subtask", id: "st-c", status: "pending", phase: 1 },
  { type: "phase", phase: 1, status: "done" },

  // --- 3. route-cost: models assigned, batch priced under ceiling --------------
  { type: "phase", phase: 3, status: "active" },
  { type: "subtask", id: "st-a", status: "pending", phase: 3, model: "sonnet" },
  { type: "subtask", id: "st-b", status: "pending", phase: 3, model: "opus" },
  { type: "subtask", id: "st-c", status: "pending", phase: 3, model: "sonnet" },
  { type: "budget", ceilingUsd: 25, estimatedUsd: 14.2 },
  { type: "phase", phase: 3, status: "done" },

  // --- 4. build phase: subtasks start building; trace ticks stream to drawer ---
  { type: "phase", phase: 2, status: "active" },
  { type: "subtask", id: "st-a", status: "building", phase: 2 },
  { type: "subtask", id: "st-b", status: "building", phase: 2 },
  { type: "subtask", id: "st-c", status: "building", phase: 2 },
  { type: "agentFire", id: "ev-route-a", subtaskId: "st-a", kind: "route", severity: "info", firedAt: T + 10 },
  { type: "trace", ts: T + 11, tool: "Read", sig: "lib/contract/types.ts", subtaskId: "st-a" },
  { type: "trace", ts: T + 12, tool: "Edit", sig: "scene/sceneGraph.ts", subtaskId: "st-b" },
  { type: "trace", ts: T + 13, tool: "Bash", sig: "tsc --noEmit", subtaskId: "st-c" },

  // --- 5. GATE B + GATE D CO-FIRE BURST ----------------------------------------
  // st-b's cross-review BLOCKs (Gate B, high) at the SAME flush as a trajectory
  // anomaly on st-c (Gate D, critical). Their agentFires have close `firedAt`
  // deltas (40ms / 0.040s apart) so the flush layer must stagger them 80–120ms
  // severity-ordered: critical (Gate D) leads, high (Gate B) follows.
  { type: "phase", phase: 4, status: "active" },
  { type: "agentFire", id: "ev-fire-d", subtaskId: "st-c", kind: "gate", severity: "critical", firedAt: T + 20.0 },
  { type: "agentFire", id: "ev-fire-b", subtaskId: "st-b", kind: "review", severity: "high", firedAt: T + 20.04 },
  {
    type: "gate",
    id: "D",
    status: "raised",
    severity: "critical",
    subtaskId: "st-c",
    counts: { high: 0, critical: 1 },
    summary: "trajectory anomaly: tool-call loop (LOOP) on st-c",
    traceReady: true,
  },
  {
    type: "gate",
    id: "B",
    status: "raised",
    severity: "high",
    subtaskId: "st-b",
    counts: { high: 2, critical: 0 },
    summary: "cross-review BLOCK on st-b: 2 high findings unresolved",
  },
  // post-burst trace ticks land in the Gate-D drawer feed
  { type: "trace", ts: T + 21, tool: "Grep", sig: "useEffect(", subtaskId: "st-c" },
  { type: "trace", ts: T + 22, tool: "Grep", sig: "useEffect(", subtaskId: "st-c" },

  // --- 6. operator resolves both gates; subtasks proceed -----------------------
  { type: "gate", id: "B", status: "resolved", severity: "high", subtaskId: "st-b", summary: "review findings addressed; re-reviewed PASS" },
  { type: "gate", id: "D", status: "resolved", severity: "critical", subtaskId: "st-c", summary: "anomaly cleared; trajectory back within bounds" },
  { type: "subtask", id: "st-a", status: "reviewed", phase: 4 },
  { type: "subtask", id: "st-b", status: "reviewed", phase: 4 },
  { type: "subtask", id: "st-c", status: "reviewed", phase: 4 },

  // --- 7. sequential merge, then promote-preview tail (preview-only) -----------
  { type: "phase", phase: 5, status: "active" },
  { type: "agentFire", id: "ev-merge-a", subtaskId: "st-a", kind: "merge", severity: "info", firedAt: T + 40 },
  { type: "subtask", id: "st-a", status: "merged", phase: 5 },
  { type: "subtask", id: "st-b", status: "merged", phase: 5 },
  { type: "subtask", id: "st-c", status: "merged", phase: 5 },
  { type: "phase", phase: 5, status: "done" },
  { type: "phase", phase: 6, status: "active" },
  { type: "agentFire", id: "ev-promote", subtaskId: "st-a", kind: "promote", severity: "low", firedAt: T + 50 },
  { type: "approval", phase: 6, kind: "promote-to-main", state: "awaiting" },
];
