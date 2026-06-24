// web/lib/contract/reducer.test.ts
// Table-driven unit tests for the reducer (all SSEEvent variants + edge cases).

import { describe, it, expect } from "vitest";
import { reducer } from "./events";
import { initialRunState, TRACE_WINDOW } from "./types";
import type { RunState } from "./types";
import type { SSEEvent } from "./events";

const base = (): RunState => JSON.parse(JSON.stringify(initialRunState)) as RunState;

describe("reducer", () => {
  it("hello — wholesale replaces state (stale gates gone)", () => {
    // Start with a state that has a gate.
    const withGate = reducer(base(), {
      type: "gate",
      id: "A",
      status: "raised",
      severity: "high",
      summary: "over budget",
    });
    expect(withGate.gates).toHaveLength(1);

    // hello replaces wholesale.
    const helloState: RunState = {
      ...base(),
      task: { id: "r1", brief: "hello", phase: 1, state: "running" },
    };
    const result = reducer(withGate, { type: "hello", run: helloState });
    expect(result.gates).toHaveLength(0); // stale gate gone
    expect(result.task.id).toBe("r1");
  });

  it("phase — updates matching phase status", () => {
    const s = reducer(base(), { type: "phase", phase: 1, status: "active" });
    expect(s.phases.find((p) => p.id === 1)?.status).toBe("active");
    // Other phases untouched.
    expect(s.phases.find((p) => p.id === 2)?.status).toBe("idle");
  });

  it("subtask — adds new subtask if id not seen", () => {
    const s = reducer(base(), {
      type: "subtask",
      id: "st-1",
      status: "pending",
      phase: 1,
      model: "sonnet",
    });
    expect(s.subtasks).toHaveLength(1);
    expect(s.subtasks[0].model).toBe("sonnet");
  });

  it("subtask delta MERGES — does not null out previously-set model", () => {
    // First event sets model.
    let s = reducer(base(), {
      type: "subtask",
      id: "st-1",
      status: "pending",
      phase: 1,
      model: "opus",
    });
    // Second event sends only status — model must survive.
    s = reducer(s, { type: "subtask", id: "st-1", status: "building" });
    expect(s.subtasks[0].model).toBe("opus"); // not nulled
    expect(s.subtasks[0].status).toBe("building");
  });

  it("subtask delta MERGES — does not null out previously-set phase", () => {
    let s = reducer(base(), {
      type: "subtask",
      id: "st-1",
      status: "pending",
      phase: 2,
    });
    // Status update without phase.
    s = reducer(s, { type: "subtask", id: "st-1", status: "reviewed" });
    expect(s.subtasks[0].phase).toBe(2); // phase preserved
  });

  it("gate — adds new gate", () => {
    const s = reducer(base(), {
      type: "gate",
      id: "B",
      status: "raised",
      severity: "high",
      summary: "BLOCK on st-a",
      counts: { high: 2, critical: 0 },
    });
    expect(s.gates).toHaveLength(1);
    expect(s.gates[0].id).toBe("B");
  });

  it("gate — updates existing gate (resolve)", () => {
    let s = reducer(base(), {
      type: "gate",
      id: "D",
      status: "raised",
      severity: "critical",
      summary: "anomaly",
    });
    s = reducer(s, {
      type: "gate",
      id: "D",
      status: "resolved",
      severity: "critical",
      summary: "cleared",
    });
    expect(s.gates).toHaveLength(1);
    expect(s.gates[0].status).toBe("resolved");
  });

  it("agentFire — appends and dedups by id", () => {
    let s = reducer(base(), {
      type: "agentFire",
      id: "ev-1",
      subtaskId: "st-a",
      kind: "route",
      severity: "info",
      firedAt: 1000,
    });
    // Same id again — dedup.
    s = reducer(s, {
      type: "agentFire",
      id: "ev-1",
      subtaskId: "st-a",
      kind: "route",
      severity: "low",
      firedAt: 1001,
    });
    expect(s.agentEvents).toHaveLength(1);
    expect(s.agentEvents[0].severity).toBe("low"); // latest wins
  });

  it("agentFire — prunes events older than bloom window", () => {
    const BLOOM = 60; // matches AGENT_BLOOM_WINDOW
    let s = base();
    // Add an old event.
    s = reducer(s, {
      type: "agentFire",
      id: "old-ev",
      subtaskId: "st-a",
      kind: "gate",
      severity: "info",
      firedAt: 100,
    });
    // Add a new event far in the future.
    s = reducer(s, {
      type: "agentFire",
      id: "new-ev",
      subtaskId: "st-b",
      kind: "merge",
      severity: "info",
      firedAt: 100 + BLOOM + 1, // pushes old-ev past cutoff
    });
    expect(s.agentEvents.some((e) => e.id === "old-ev")).toBe(false);
    expect(s.agentEvents.some((e) => e.id === "new-ev")).toBe(true);
  });

  it("trace — appends into ring buffer", () => {
    const s = reducer(base(), {
      type: "trace",
      ts: 1000,
      tool: "Read",
      sig: "foo.ts",
    });
    expect(s.trace).toHaveLength(1);
    expect(s.trace[0].tool).toBe("Read");
  });

  it("trace — ring buffer capped at TRACE_WINDOW", () => {
    let s = base();
    // Fill past TRACE_WINDOW.
    for (let i = 0; i < TRACE_WINDOW + 10; i++) {
      s = reducer(s, { type: "trace", ts: i, tool: "T", sig: `s${i}` });
    }
    expect(s.trace).toHaveLength(TRACE_WINDOW);
    // Oldest entries should be gone; newest present.
    expect(s.trace[s.trace.length - 1].sig).toBe(`s${TRACE_WINDOW + 9}`);
  });

  it("budget — replaces budget", () => {
    const s = reducer(base(), {
      type: "budget",
      ceilingUsd: 25,
      estimatedUsd: 14.2,
    });
    expect(s.budget.ceilingUsd).toBe(25);
    expect(s.budget.estimatedUsd).toBe(14.2);
  });

  it("usage — records a lane keyed by subtaskId and bumps the run total", () => {
    const s = reducer(base(), {
      type: "usage",
      subtaskId: "lane-a",
      model: "claude-sonnet-4-6",
      inputTokens: 5,
      outputTokens: 398,
      cacheReadTokens: 97328,
      cacheCreationTokens: 12841,
      contextWindow: 200000,
      costUsd: 0.1122,
    });
    expect(s.usage.lanes["lane-a"]).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 5,
      outputTokens: 398,
      cacheReadTokens: 97328,
      cacheCreationTokens: 12841,
      contextWindow: 200000,
      costUsd: 0.1122,
    });
    expect(s.usage.totalCostUsd).toBeCloseTo(0.1122);
  });

  it("usage — merges multiple lanes and sums totalCostUsd", () => {
    let s = reducer(base(), {
      type: "usage",
      subtaskId: "lane-a",
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextWindow: 200000, costUsd: 0.1,
    });
    s = reducer(s, {
      type: "usage",
      subtaskId: "lane-b",
      inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextWindow: 200000, costUsd: 0.25,
    });
    expect(Object.keys(s.usage.lanes).sort()).toEqual(["lane-a", "lane-b"]);
    expect(s.usage.totalCostUsd).toBeCloseTo(0.35);
  });

  it("usage — a lane-less event falls into the _run bucket", () => {
    const s = reducer(base(), {
      type: "usage",
      inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextWindow: 0, costUsd: 0.05,
    });
    expect(s.usage.lanes["_run"]).toBeDefined();
    expect(s.usage.lanes["_run"].model).toBeUndefined();
    expect(s.usage.totalCostUsd).toBeCloseTo(0.05);
  });

  it("approval — sets approval on the correct phase", () => {
    const s = reducer(base(), {
      type: "approval",
      phase: 6,
      kind: "promote-to-main",
      state: "awaiting",
    });
    const p6 = s.phases.find((p) => p.id === 6);
    expect(p6?.approval).toEqual({ kind: "promote-to-main", state: "awaiting" });
  });

  it("unknown type — returns state unchanged (no throw)", () => {
    const s = base();
    // Cast to any to simulate a forward-compat unknown event.
    const unknown = { type: "futureEvent", data: 42 } as unknown as SSEEvent;
    const result = reducer(s, unknown);
    expect(result).toBe(s); // same reference
  });
});
