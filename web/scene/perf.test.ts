// web/scene/perf.test.ts
import { describe, it, expect } from "vitest";
import {
  MAX_AMBIENT_NODES,
  MIN_NODE_RADIUS,
  MAX_BLOOM_RADIUS,
  nodeRender,
  clampAmbientCount,
  clampBloomRadius,
} from "./perf";

describe("perf floors", () => {
  it("applies the min node-radius floor and flags degrade-to-ring below it", () => {
    const below = nodeRender(MIN_NODE_RADIUS - 0.05);
    expect(below.radius).toBe(MIN_NODE_RADIUS);
    expect(below.degradeToRing).toBe(true);

    const above = nodeRender(0.4);
    expect(above.radius).toBe(0.4);
    expect(above.degradeToRing).toBe(false);
  });

  it("clamps ambient count to the cap and to a non-negative integer", () => {
    expect(clampAmbientCount(50_000)).toBe(MAX_AMBIENT_NODES);
    expect(clampAmbientCount(-5)).toBe(0);
    expect(clampAmbientCount(12.9)).toBe(12);
    expect(clampAmbientCount(NaN)).toBe(0);
  });

  it("clamps bloom radius to the ceiling", () => {
    expect(clampBloomRadius(5)).toBe(MAX_BLOOM_RADIUS);
    expect(clampBloomRadius(-1)).toBe(0);
    expect(clampBloomRadius(0.4)).toBe(0.4);
  });
});
