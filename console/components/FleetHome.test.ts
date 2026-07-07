import { describe, it, expect } from "vitest";
import { buildRunsPostBody } from "./FleetHome";
import type { LaunchPayload } from "./LaunchConsole";

const basePayload: LaunchPayload = {
  projectId: "p1",
  projectName: "Project One",
  brief: "build the thing",
  modelRouting: "auto",
};

describe("buildRunsPostBody — LIVE-mode POST /api/runs body (decompose toggle)", () => {
  it("omits `decompose` when the payload didn't carry it (default OFF, unchanged body shape)", () => {
    const body = buildRunsPostBody(basePayload);
    expect(body).toEqual({ projectId: "p1", brief: "build the thing", routing: "auto" });
    expect("decompose" in body).toBe(false);
  });

  it("includes `decompose: true` when the operator toggled it on", () => {
    const body = buildRunsPostBody({ ...basePayload, decompose: true });
    expect(body).toEqual({ projectId: "p1", brief: "build the thing", routing: "auto", decompose: true });
  });

  it("omits `decompose` (does not send `false`) when the payload explicitly carries false", () => {
    const body = buildRunsPostBody({ ...basePayload, decompose: false });
    expect("decompose" in body).toBe(false);
  });
});
