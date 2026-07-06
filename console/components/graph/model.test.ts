// console/components/graph/model.test.ts
// Collapse/disclosure logic + layout determinism — the two acceptance-named suites.
import { describe, it, expect } from "vitest";
import type { TraceTick } from "@/lib/contract/types";
import {
  ACTIVE_WINDOW_SEC,
  RECENT_WINDOW_SEC,
  classifyActivity,
  summarizeActivity,
  buildGraph,
  computeLayout,
  type RosterAgent,
} from "./model";

const NOW = 1_000_000;

function tick(agentId: string, ts: number, tool = "Read", sig = "x", laneId?: string): TraceTick {
  return { ts, agentId, tool, sig, laneId };
}

describe("classifyActivity", () => {
  it("is active within the active window", () => {
    expect(classifyActivity(NOW - ACTIVE_WINDOW_SEC, NOW)).toBe("active");
  });
  it("is recent just past the active window but within the recent window", () => {
    expect(classifyActivity(NOW - ACTIVE_WINDOW_SEC - 1, NOW)).toBe("recent");
    expect(classifyActivity(NOW - RECENT_WINDOW_SEC, NOW)).toBe("recent");
  });
  it("is idle past the recent window", () => {
    expect(classifyActivity(NOW - RECENT_WINDOW_SEC - 1, NOW)).toBe("idle");
  });
  it("is idle when never seen", () => {
    expect(classifyActivity(undefined, NOW)).toBe("idle");
  });
});

describe("summarizeActivity", () => {
  it("keeps the latest tool/sig and caps the trace snippet", () => {
    const traces = Array.from({ length: 9 }, (_, i) => tick("build:a", NOW - 100 + i, `tool${i}`, `sig${i}`));
    const summary = summarizeActivity(traces).get("build:a")!;
    expect(summary.eventCount).toBe(9);
    expect(summary.lastTool).toBe("tool8");
    expect(summary.recentTicks).toHaveLength(5);
    expect(summary.recentTicks[4].tool).toBe("tool8");
  });
});

describe("buildGraph — collapse/disclosure", () => {
  const roster: RosterAgent[] = [
    { id: "architect", niche: "opus", label: "architect" },
    { id: "qa-lead", niche: "opus", label: "qa-lead" },
    { id: "devops", niche: "sonnet", label: "devops" },
  ];

  it("collapses a lone idle roster agent into a group node (uniform rule, even for N=1)", () => {
    const { nodes } = buildGraph({
      rosterAgents: [{ id: "devops", niche: "sonnet", label: "devops" }],
      activity: new Map(),
      traces: [],
      nowSec: NOW,
      showpiece: false,
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ id: "group:sonnet", kind: "group", memberCount: 1 });
  });

  it("keeps an active agent as its own node, never collapsed", () => {
    const activity = summarizeActivity([tick("devops", NOW - 5)]);
    const { nodes } = buildGraph({
      rosterAgents: [{ id: "devops", niche: "sonnet", label: "devops" }],
      activity,
      traces: [tick("devops", NOW - 5)],
      nowSec: NOW,
      showpiece: false,
    });
    expect(nodes).toEqual([expect.objectContaining({ id: "devops", kind: "agent", activity: "active" })]);
  });

  it("mixed niche: active agent node + idle-siblings group node coexist, distinctly", () => {
    const activity = summarizeActivity([tick("architect", NOW - 2)]);
    const { nodes } = buildGraph({
      rosterAgents: roster,
      activity,
      traces: [tick("architect", NOW - 2)],
      nowSec: NOW,
      showpiece: false,
    });
    const opusNodes = nodes.filter((n) => n.niche === "opus");
    expect(opusNodes).toHaveLength(2);
    expect(opusNodes.find((n) => n.id === "architect")).toMatchObject({ kind: "agent", activity: "active" });
    const group = opusNodes.find((n) => n.kind === "group")!;
    expect(group).toMatchObject({ id: "group:opus", memberCount: 1, members: ["qa-lead"] });
  });

  it("showpiece disables collapsing entirely — every roster id gets its own node", () => {
    const { nodes } = buildGraph({
      rosterAgents: roster,
      activity: new Map(),
      traces: [],
      nowSec: NOW,
      showpiece: true,
    });
    expect(nodes).toHaveLength(roster.length);
    expect(nodes.every((n) => n.kind === "agent")).toBe(true);
  });

  it("derives handoff edges from consecutive distinct agents on the same lane", () => {
    const traces = [tick("orchestrator", NOW - 30, "spawn", "st-a", "st-a"), tick("build:a", NOW - 5, "Edit", "x", "st-a")];
    const activity = summarizeActivity(traces);
    const { edges } = buildGraph({
      rosterAgents: [],
      activity,
      traces,
      nowSec: NOW,
      showpiece: true,
    });
    expect(edges).toEqual([{ from: "orchestrator", to: "build:a", weight: 1, lastTs: NOW - 5 }]);
  });

  it("drops self-loop edges created when two idle siblings collapse into the same group", () => {
    const traces = [
      tick("build:a", NOW - 200, "Read", "x", "st-a"),
      tick("build:b", NOW - 190, "Edit", "y", "st-a"), // both idle by NOW, same niche "build"
    ];
    const activity = summarizeActivity(traces);
    const { edges, nodes } = buildGraph({
      rosterAgents: [],
      activity,
      traces,
      nowSec: NOW,
      showpiece: false,
    });
    expect(nodes).toEqual([expect.objectContaining({ id: "group:build", kind: "group", memberCount: 2 })]);
    expect(edges).toHaveLength(0); // from === to === "group:build" after remap — dropped
  });

  it("ignores trace ticks with no laneId for edge derivation (nothing to hand off between)", () => {
    const traces = [tick("orchestrator", NOW - 10, "a", "x"), tick("build:a", NOW - 5, "b", "y")];
    const { edges } = buildGraph({ rosterAgents: [], activity: summarizeActivity(traces), traces, nowSec: NOW, showpiece: true });
    expect(edges).toHaveLength(0);
  });
});

describe("computeLayout — determinism", () => {
  const nodes = [
    { id: "architect", kind: "agent" as const, niche: "opus", label: "architect", activity: "idle" as const, memberCount: 1 },
    { id: "qa-lead", kind: "agent" as const, niche: "opus", label: "qa-lead", activity: "idle" as const, memberCount: 1 },
    { id: "devops", kind: "agent" as const, niche: "sonnet", label: "devops", activity: "idle" as const, memberCount: 1 },
  ];

  it("returns identical positions across repeated calls (pure function, no Math.random/Date.now)", () => {
    const a = computeLayout(nodes, 800, 600);
    const b = computeLayout(nodes, 800, 600);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("is independent of input array order", () => {
    const shuffled = [nodes[2], nodes[0], nodes[1]];
    const a = computeLayout(nodes, 800, 600);
    const b = computeLayout(shuffled, 800, 600);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });

  it("places every node within canvas bounds with no exact-duplicate coordinates, even at N=300 (showpiece scale)", () => {
    const big = Array.from({ length: 300 }, (_, i) => ({
      id: `agent-${String(i).padStart(3, "0")}`,
      kind: "agent" as const,
      niche: `niche-${i % 12}`,
      label: `agent-${i}`,
      activity: "idle" as const,
      memberCount: 1,
    }));
    const layout = computeLayout(big, 1600, 900);
    expect(layout.size).toBe(300);
    const seen = new Set<string>();
    for (const [id, p] of layout) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      const key = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(id).toBeTruthy();
    }
  });
});
