import { describe, it, expect } from "vitest";
import { deriveStoreEvents, filterEvents, facetValues, sortByTs } from "./filters";
import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import type { ToolCallEvent } from "./types";

const state = foldFleet(fixtureEnvelopes(), initialFleetState);

describe("deriveStoreEvents", () => {
  it("folds every run's trace ring into a flat, run/lane/agent-tagged list", () => {
    const events = deriveStoreEvents(state);
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.origin).toBe("store");
      expect(ev.runId).toBeTruthy();
      expect(typeof ev.tool).toBe("string");
      expect(typeof ev.sig).toBe("string");
    }
    // the fixture's console lane logs a Read/Edit/Bash/Write trajectory
    expect(events.some((e) => e.tool === "Read")).toBe(true);
    expect(events.some((e) => e.runId === "run-console")).toBe(true);
  });

  it("gives every event a stable, unique id", () => {
    const events = deriveStoreEvents(state);
    const ids = new Set(events.map((e) => e.id));
    expect(ids.size).toBe(events.length);
  });
});

describe("filterEvents", () => {
  const events = deriveStoreEvents(state);

  it("narrows by runId", () => {
    const out = filterEvents(events, { runId: "run-console" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.runId === "run-console")).toBe(true);
  });

  it("narrows by laneId", () => {
    const out = filterEvents(events, { laneId: "st-a" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.laneId === "st-a")).toBe(true);
  });

  it("narrows by tool (event type)", () => {
    const out = filterEvents(events, { tool: "Grep" });
    expect(out.every((e) => e.tool === "Grep")).toBe(true);
    expect(out.some((e) => e.tool === "Grep")).toBe(true); // review:b greps in the fixture
  });

  it("free-text search matches tool/sig/agent/run, is case-insensitive", () => {
    const out = filterEvents(events, { q: "PERSIST" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.sig.toLowerCase().includes("persist"))).toBe(true);
  });

  it("combines filters with AND semantics", () => {
    const out = filterEvents(events, { runId: "run-console", tool: "Edit" });
    expect(out.every((e) => e.runId === "run-console" && e.tool === "Edit")).toBe(true);
  });

  it("empty filters return everything", () => {
    expect(filterEvents(events, {})).toHaveLength(events.length);
  });

  it("a filter with no matches returns []", () => {
    expect(filterEvents(events, { runId: "does-not-exist" })).toEqual([]);
  });
});

describe("facetValues", () => {
  it("returns distinct, sorted values for a key", () => {
    const events = deriveStoreEvents(state);
    const runIds = facetValues(events, "runId");
    expect(runIds).toEqual([...new Set(runIds)].sort());
    expect(runIds).toContain("run-console");
  });

  it("omits falsy/missing values", () => {
    const events: ToolCallEvent[] = [
      { id: "a", ts: 1, tool: "Read", sig: "x", origin: "file", sessionId: "sess1" },
      { id: "b", ts: 2, tool: "Edit", sig: "y", origin: "store", runId: "r1" },
    ];
    expect(facetValues(events, "runId")).toEqual(["r1"]);
  });
});

describe("sortByTs", () => {
  it("sorts ascending by default", () => {
    const events = deriveStoreEvents(state);
    const sorted = sortByTs(events);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].ts).toBeGreaterThanOrEqual(sorted[i - 1].ts);
  });

  it("sorts descending on request", () => {
    const events = deriveStoreEvents(state);
    const sorted = sortByTs(events, "desc");
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].ts).toBeLessThanOrEqual(sorted[i - 1].ts);
  });

  it("does not mutate the input array", () => {
    const events = deriveStoreEvents(state);
    const copy = [...events];
    sortByTs(events, "desc");
    expect(events).toEqual(copy);
  });
});
