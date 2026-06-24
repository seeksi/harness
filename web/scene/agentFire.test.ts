// web/scene/agentFire.test.ts
import { describe, it, expect } from "vitest";
import { staggerFires, severityRank } from "./agentFire";
import { MOTION } from "./motion";
import type { AgentEvent } from "@/lib/contract/types";

const fire = (id: string, severity: AgentEvent["severity"], firedAt: number): AgentEvent => ({
  id,
  subtaskId: `st-${id}`,
  kind: "gate",
  severity,
  firedAt,
});

describe("agent-fire stagger", () => {
  it("ranks severity high→low", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
    expect(severityRank("low")).toBeGreaterThan(severityRank("info"));
  });

  it("orders co-fires by severity desc and staggers peaks by the locked offset", () => {
    // Mirrors the fixture co-fire burst: critical (Gate D) must lead high (Gate B).
    const out = staggerFires([
      fire("b", "high", 20.04),
      fire("d", "critical", 20.0),
    ]);
    expect(out.map((f) => f.id)).toEqual(["d", "b"]);
    expect(out[0].peakOffsetMs).toBe(0);
    expect(out[1].peakOffsetMs).toBe(MOTION.coFireStaggerMs);
  });

  it("breaks severity ties by firedAt (earlier leads)", () => {
    const out = staggerFires([fire("late", "high", 99), fire("early", "high", 1)]);
    expect(out.map((f) => f.id)).toEqual(["early", "late"]);
  });
});
