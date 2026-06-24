// web/hud/inbox.test.ts
import { describe, it, expect } from "vitest";
import { deriveInbox } from "./inbox";
import { initialRunState } from "@/lib/contract/types";
import type { RunState } from "@/lib/contract/types";

describe("deriveInbox", () => {
  it("is empty with no raised gates or awaiting approvals", () => {
    expect(deriveInbox(initialRunState)).toEqual([]);
  });

  it("emits a four-fact action line per raised gate, severity-ordered", () => {
    const state: RunState = {
      ...initialRunState,
      gates: [
        { id: "B", status: "raised", severity: "high", summary: "review BLOCK", subtaskId: "st-b", counts: { high: 2, critical: 0 } },
        { id: "D", status: "raised", severity: "critical", summary: "trajectory anomaly", subtaskId: "st-c", counts: { high: 0, critical: 1 } },
        { id: "A", status: "resolved", severity: "info", summary: "budget ok" },
      ],
    };
    const items = deriveInbox(state);
    expect(items).toHaveLength(2); // resolved gate excluded
    // critical leads
    expect(items[0].id).toBe("gate-D");
    expect(items[0].line).toBe("Gate D · trajectory · st-c · 1 Critical");
    expect(items[1].line).toBe("Gate B · review · st-b · 2 High");
  });

  it("includes awaiting approvals", () => {
    const state: RunState = {
      ...initialRunState,
      phases: initialRunState.phases.map((p) =>
        p.id === 6 ? { ...p, approval: { kind: "promote-to-main", state: "awaiting" } } : p
      ),
    };
    const items = deriveInbox(state);
    expect(items.some((i) => i.kind === "approval" && i.line.includes("promote-to-main"))).toBe(true);
  });
});
