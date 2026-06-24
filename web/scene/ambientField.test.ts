// web/scene/ambientField.test.ts
import { describe, it, expect } from "vitest";
import { generateAmbientField } from "./ambientField";
import { MAX_AMBIENT_NODES } from "./perf";

describe("generateAmbientField", () => {
  it("returns count*3 finite coordinates and respects the cap", () => {
    const f = generateAmbientField(100);
    expect(f).toHaveLength(300);
    expect([...f].every(Number.isFinite)).toBe(true);

    const capped = generateAmbientField(10_000);
    expect(capped).toHaveLength(MAX_AMBIENT_NODES * 3);
  });

  it("is deterministic for a given seed and varies by seed", () => {
    expect([...generateAmbientField(20, 1)]).toEqual([...generateAmbientField(20, 1)]);
    expect([...generateAmbientField(20, 1)]).not.toEqual([...generateAmbientField(20, 2)]);
  });

  it("keeps points behind the foreground (z < 0)", () => {
    const f = generateAmbientField(200);
    for (let i = 0; i < f.length; i += 3) expect(f[i + 2]).toBeLessThan(0);
  });
});
