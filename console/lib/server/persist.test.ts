import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  upsertRun,
  appendEvent,
  eventsSince,
  listRecentRuns,
  listRecentRunsForProjects,
  pruneProject,
  finalizeRun,
  getSnapshot,
  appendAudit,
  listAudit,
  migrateLegacyProjectIds,
} from "./persist";
import { slugFor } from "./discovery";
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

describe("eventsSince — LIMIT / pagination", () => {
  const ev = (ts: number): Envelope => ({ runId: "r1", projectId: "p1", agentId: "a", ts, type: "trace", payload: { tool: "T", sig: "s" } });

  it("caps a page at `limit` and pages forward from the last seq (gapless)", () => {
    seedRun("r1", "p1", 100);
    for (let i = 1; i <= 10; i++) appendEvent(ev(i));
    const page1 = eventsSince("r1", 0, 4);
    expect(page1).toHaveLength(4);
    const page2 = eventsSince("r1", page1[page1.length - 1].seq, 4);
    expect(page2).toHaveLength(4);
    // no overlap, strictly increasing seqs across pages
    expect(page2[0].seq).toBeGreaterThan(page1[page1.length - 1].seq);
    const page3 = eventsSince("r1", page2[page2.length - 1].seq, 4);
    expect(page3).toHaveLength(2); // 10 total → 4 + 4 + 2
  });
});

describe("per-run event cap", () => {
  const ev = (ts: number): Envelope => ({ runId: "r1", projectId: "p1", agentId: "a", ts, type: "trace", payload: { tool: "T", sig: "s" } });

  it("rings the durable event log to the cap, dropping the oldest first", () => {
    seedRun("r1", "p1", 100);
    for (let i = 1; i <= 10; i++) appendEvent(ev(i), 3); // cap = 3
    const kept = eventsSince("r1", 0, 100);
    expect(kept).toHaveLength(3);
    // the newest 3 (ts 8,9,10) survive; oldest pruned
    const tss = kept.map((e) => (e.env.type === "trace" ? e.env.ts : 0));
    expect(tss).toEqual([8, 9, 10]);
  });
});

describe("listRecentRunsForProjects — batched (no N+1)", () => {
  it("returns recent runs for many projects in one call, capped per project", () => {
    for (let i = 0; i < 3; i++) upsertRun(newRun(`a${i}`, "pa", "pa", "b", 1000 + i));
    for (let i = 0; i < 2; i++) upsertRun(newRun(`b${i}`, "pb", "pb", "b", 2000 + i));
    const map = listRecentRunsForProjects(["pa", "pb", "pc"]);
    expect(map.get("pa")).toHaveLength(3);
    expect(map.get("pb")).toHaveLength(2);
    expect(map.has("pc")).toBe(false); // no runs → absent
    // newest-first within a project
    expect(map.get("pa")![0].id).toBe("a2");
    // per-project cap honored
    for (let i = 0; i < 25; i++) upsertRun(newRun(`c${i}`, "pc", "pc", "b", 3000 + i));
    expect(listRecentRunsForProjects(["pc"], 20).get("pc")).toHaveLength(20);
  });

  it("empty input → empty map (no query)", () => {
    expect(listRecentRunsForProjects([]).size).toBe(0);
  });
});

describe("migrateLegacyProjectIds — rewrites pre-migration path-shaped project_id rows", () => {
  it("rewrites a seeded old-style path row to the current slug and re-homes its runs", () => {
    const legacyPath = "/home/alter/HARNESS";
    upsertRun(newRun("legacy-r1", legacyPath, "HARNESS", "b", 500));
    // Not yet queryable under the current slug — still orphaned under the old path.
    expect(listRecentRuns(slugFor(legacyPath))).toHaveLength(0);
    expect(listRecentRuns(legacyPath)).toHaveLength(1);

    const migrated = migrateLegacyProjectIds();
    expect(migrated).toBe(1);

    expect(listRecentRuns(slugFor(legacyPath))).toHaveLength(1);
    expect(listRecentRuns(slugFor(legacyPath))[0].id).toBe("legacy-r1");
    expect(listRecentRuns(legacyPath)).toHaveLength(0); // old path id no longer resolves
  });

  it("also rewrites the persisted snapshot JSON's projectId, not just the column", () => {
    const legacyPath = "/home/alter/HARNESS";
    upsertRun(newRun("legacy-r3", legacyPath, "HARNESS", "b", 500));
    // Pre-migration: the snapshot getSnapshot() returns still embeds the raw path.
    expect(getSnapshot("legacy-r3")?.projectId).toBe(legacyPath);

    expect(migrateLegacyProjectIds()).toBe(1);

    const snap = getSnapshot("legacy-r3");
    expect(snap?.projectId).toBe(slugFor(legacyPath));
    // The raw persisted JSON itself must carry no '/'-prefixed (path-shaped) project id —
    // re-serializing what getSnapshot() parsed straight out of the snapshot column.
    expect(JSON.stringify(snap)).not.toMatch(/"projectId":"\//);
  });

  it("is idempotent — a second run is a no-op once already migrated", () => {
    upsertRun(newRun("legacy-r2", "/home/alter/HARNESS", "HARNESS", "b", 500));
    expect(migrateLegacyProjectIds()).toBe(1);
    expect(migrateLegacyProjectIds()).toBe(0);
  });

  it("never touches an already-opaque (non-path-shaped) project_id", () => {
    seedRun("r1", "already-a-slug", 100);
    expect(migrateLegacyProjectIds()).toBe(0);
    expect(listRecentRuns("already-a-slug")).toHaveLength(1);
  });
});

describe("audit table", () => {
  it("appends audit rows and lists them newest-first (no secrets stored)", () => {
    appendAudit({ ts: 1, cmd: "wt-new", argv: ["wt-new", "lane-x"], outcome: "exit", code: 0 });
    appendAudit({ ts: 2, cmd: "budget", argv: [], outcome: "invalid-args", error: "HarnessArgError" });
    const rows = listAudit();
    expect(rows[0]).toMatchObject({ cmd: "budget", outcome: "invalid-args", error: "HarnessArgError" });
    expect(rows[1]).toMatchObject({ cmd: "wt-new", outcome: "exit", code: 0 });
    expect(rows[1].argv).toEqual(["wt-new", "lane-x"]);
  });
});
