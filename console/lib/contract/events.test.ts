import { describe, it, expect } from "vitest";
import { fleetReducer, foldFleet, type Envelope } from "./events";
import { fixtureEnvelopes } from "./fixture";
import { initialFleetState, newRun } from "./types";
import { activeLanes, subtaskCounts, raisedGates, contextFill } from "./selectors";

const base = { runId: "r1", projectId: "p1", agentId: "a", ts: 1000 };

describe("fleetReducer", () => {
  it("creates a run on first domain event for an unknown runId", () => {
    const s = fleetReducer(initialFleetState, { ...base, type: "phase", payload: { phase: 1, status: "active" } } as Envelope);
    expect(s.runs.r1).toBeDefined();
    expect(s.runs.r1.phases[0].status).toBe("active");
    expect(s.order).toEqual(["r1"]);
  });

  it("sync replaces a run wholesale (the only resync path)", () => {
    const run = newRun("r1", "p1", "hangar", "brief", 500);
    let s = fleetReducer(initialFleetState, { ...base, type: "phase", payload: { phase: 2, status: "active" } } as Envelope);
    s = fleetReducer(s, { ...base, type: "sync", payload: { run } } as Envelope);
    expect(s.runs.r1.projectName).toBe("hangar");
    expect(s.runs.r1.phases[1].status).toBe("idle"); // wholesale replaced
  });

  it("merges subtask deltas (does not clobber untouched fields)", () => {
    let s = fleetReducer(initialFleetState, { ...base, type: "subtask", payload: { id: "st-a", title: "tokens", status: "pending", model: "sonnet" } } as Envelope);
    s = fleetReducer(s, { ...base, ts: 1001, type: "subtask", payload: { id: "st-a", status: "building" } } as Envelope);
    const st = s.runs.r1.subtasks[0];
    expect(st.status).toBe("building");
    expect(st.title).toBe("tokens"); // preserved
    expect(st.model).toBe("sonnet"); // preserved
  });

  it("recomputes usage totals from lanes (re-reporting a lane never double-counts)", () => {
    const u = (t: number) => ({ ...base, type: "usage", payload: { laneId: "st-a", inputTokens: t, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 200000, costUsd: 1 } } as Envelope);
    let s = fleetReducer(initialFleetState, u(100));
    s = fleetReducer(s, u(300)); // re-report same lane
    expect(s.runs.r1.usage.totalTokens).toBe(300);
    expect(s.runs.r1.usage.totalCostUsd).toBe(1);
  });

  it("phase 6 done marks the run completed", () => {
    const s = fleetReducer(initialFleetState, { ...base, type: "phase", payload: { phase: 6, status: "done" } } as Envelope);
    expect(s.runs.r1.status).toBe("done");
  });

  it("drops unknown event types (forward-compat)", () => {
    const s = fleetReducer(initialFleetState, { ...base, type: "wat", payload: {} } as unknown as Envelope);
    expect(s).toBe(initialFleetState);
  });

  it("tracks lastEventTs as the max ts folded", () => {
    let s = fleetReducer(initialFleetState, { ...base, ts: 1000, type: "trace", payload: { tool: "Read", sig: "x" } } as Envelope);
    s = fleetReducer(s, { ...base, ts: 900, type: "trace", payload: { tool: "Read", sig: "y" } } as Envelope);
    expect(s.runs.r1.lastEventTs).toBe(1000);
  });
});

describe("fixture fold", () => {
  const state = foldFleet(fixtureEnvelopes(), initialFleetState);

  it("produces three concurrent lanes", () => {
    expect(Object.keys(state.runs)).toHaveLength(3);
    expect(activeLanes(state).length).toBe(3);
  });

  it("lane vector (dropship) has Gate B raised", () => {
    const vector = Object.values(state.runs).find((r) => r.projectName === "vector")!;
    expect(raisedGates(vector).map((g) => g.id)).toContain("B");
  });

  it("lane hangar (console) is mid-build with building subtasks and context fill", () => {
    const hangar = Object.values(state.runs).find((r) => r.projectName === "hangar")!;
    expect(subtaskCounts(hangar).building).toBeGreaterThan(0);
    expect(contextFill(hangar)).toBeGreaterThan(0);
  });

  it("lane ledger (memory-os) reached eval+promote awaiting approval", () => {
    const ledger = Object.values(state.runs).find((r) => r.projectName === "ledger")!;
    expect(ledger.phases.find((p) => p.approval?.state === "awaiting")).toBeTruthy();
    expect(ledger.evals?.regressionPass).toBe(true);
  });
});
