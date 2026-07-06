import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, upsertRun, appendEvent, eventsSince, listRecentRuns, pruneProject, finalizeRun, getSnapshot } from "./persist";
import { newRun } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";

beforeEach(() => resetDb(":memory:"));

function seedRun(id: string, project: string, startedAt: number) {
  const r = newRun(id, project, project, `brief ${id}`, startedAt);
  upsertRun(r);
  return r;
}

describe("persistence + retention", () => {
  it("upserts and reads back a run snapshot", () => {
    seedRun("r1", "p1", 100);
    expect(getSnapshot("r1")?.projectId).toBe("p1");
  });

  it("appends events and replays them gaplessly from a seq", () => {
    seedRun("r1", "p1", 100);
    const ev = (ts: number, tool: string): Envelope => ({ runId: "r1", projectId: "p1", agentId: "a", ts, type: "trace", payload: { tool, sig: "x" } });
    appendEvent(ev(1, "Read"));
    appendEvent(ev(2, "Edit"));
    appendEvent(ev(3, "Bash"));
    const all = eventsSince("r1", 0);
    expect(all.map((e) => (e.env.type === "trace" ? e.env.payload.tool : ""))).toEqual(["Read", "Edit", "Bash"]);
    const tail = eventsSince("r1", all[0].seq);
    expect(tail).toHaveLength(2); // gapless resume after seq 1
  });

  it("prunes to 20 runs per project (oldest first) and drops their events", () => {
    for (let i = 0; i < 25; i++) seedRun(`r${i}`, "p1", 1000 + i);
    // seed some events on the very oldest run
    appendEvent({ runId: "r0", projectId: "p1", agentId: "a", ts: 1, type: "trace", payload: { tool: "Read", sig: "x" } });
    upsertRun(newRun("r0", "p1", "p1", "b", 1000)); // triggers prune again
    const kept = listRecentRuns("p1", 20);
    expect(kept).toHaveLength(20);
    // newest kept, oldest pruned
    expect(kept.some((r) => r.id === "r24")).toBe(true);
    expect(kept.some((r) => r.id === "r0")).toBe(false);
    expect(eventsSince("r0", 0)).toHaveLength(0); // pruned run's events gone
  });

  it("retention is per-project (does not cross projects)", () => {
    for (let i = 0; i < 22; i++) seedRun(`a${i}`, "pa", 1000 + i);
    for (let i = 0; i < 5; i++) seedRun(`b${i}`, "pb", 1000 + i);
    expect(listRecentRuns("pa", 20)).toHaveLength(20);
    expect(listRecentRuns("pb", 20)).toHaveLength(5);
  });

  it("finalizeRun records terminal outcome", () => {
    seedRun("r1", "p1", 100);
    finalizeRun("r1", "done", 200);
    expect(listRecentRuns("p1")[0].outcome).toBe("done");
  });

  it("pruneProject returns count pruned", () => {
    for (let i = 0; i < 23; i++) seedRun(`r${i}`, "p1", 1000 + i);
    // already pruned to 20 by upsert; an explicit prune now removes 0
    expect(pruneProject("p1", 20)).toBe(0);
    expect(pruneProject("p1", 10)).toBe(10);
  });
});
