import { describe, it, expect } from "vitest";
import { lookupRun } from "./selectRun";
import { initialFleetState, newRun, type FleetState } from "@/lib/contract/types";

function stateWith(runId: string): FleetState {
  const run = newRun(runId, "p1", "hangar", "brief", 1000);
  return { runs: { [runId]: run }, order: [runId] };
}

describe("lookupRun", () => {
  it("resolves a run present in the fleet by string id", () => {
    const s = stateWith("run-console");
    const r = lookupRun(s, "run-console");
    expect(r.notFound).toBe(false);
    expect(r.run?.runId).toBe("run-console");
  });

  it("reports notFound for an unknown id", () => {
    const r = lookupRun(initialFleetState, "run-nope");
    expect(r.notFound).toBe(true);
    expect(r.run).toBeUndefined();
  });

  it("reports notFound for an undefined param", () => {
    const r = lookupRun(initialFleetState, undefined);
    expect(r.notFound).toBe(true);
    expect(r.runId).toBe("");
  });

  it("defensively takes the first id when handed an array (catch-all shape)", () => {
    const s = stateWith("run-console");
    const r = lookupRun(s, ["run-console", "extra"]);
    expect(r.run?.runId).toBe("run-console");
  });

  it("treats an empty array as not found without throwing", () => {
    const r = lookupRun(initialFleetState, []);
    expect(r.notFound).toBe(true);
  });
});
