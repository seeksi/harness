import { describe, it, expect } from "vitest";
import { notificationsFor } from "./notifier";
import { newRun } from "@/lib/contract/types";
import type { RunState, Gate } from "@/lib/contract/types";

function run(over: Partial<RunState> = {}): RunState {
  return { ...newRun("r1", "proj", "vector", "a brief", 100), ...over };
}
const raised = (id: Gate["id"], subtaskId?: string): Gate => ({
  id,
  status: "raised",
  severity: "high",
  summary: `block ${id}`,
  ...(subtaskId ? { subtaskId } : {}),
});

describe("notificationsFor — edge-triggered alert transitions (§6)", () => {
  it("fires gate-raised once when a gate first becomes raised, with a deep-link", () => {
    const before = run();
    const after = run({ gates: [raised("B", "px-b")] });
    const n = notificationsFor(before, after);
    expect(n).toHaveLength(1);
    expect(n[0].kind).toBe("gate-raised");
    expect(n[0].link).toBe("/run/r1");
    expect(n[0].detail).toContain("Gate B");
    expect(n[0].detail).toContain("px-b");
    // no re-fire when the same gate stays raised
    expect(notificationsFor(after, after)).toHaveLength(0);
  });

  it("fires run-completed when status reaches done", () => {
    const n = notificationsFor(run({ status: "running" }), run({ status: "done" }));
    expect(n).toHaveLength(1);
    expect(n[0].kind).toBe("run-completed");
  });

  it("fires run-failed on lifecycle failed (not also run-stuck)", () => {
    const n = notificationsFor(run({ status: "running" }), run({ status: "failed", reportedHealth: "stuck" }));
    expect(n.map((x) => x.kind)).toEqual(["run-failed"]);
  });

  it("fires run-stuck on a trajectory-anomaly verdict without a failed lifecycle", () => {
    const n = notificationsFor(run({ reportedHealth: "healthy" }), run({ reportedHealth: "stuck" }));
    expect(n.map((x) => x.kind)).toEqual(["run-stuck"]);
  });

  it("no notifications on a benign transition or a fresh run (before=undefined, healthy)", () => {
    expect(notificationsFor(run(), run({ lastEventTs: 200 }))).toHaveLength(0);
    expect(notificationsFor(undefined, run())).toHaveLength(0);
  });
});
