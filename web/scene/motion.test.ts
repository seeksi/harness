// web/scene/motion.test.ts
import { describe, it, expect } from "vitest";
import { MOTION, breathe, easeInRamp, fireEnvelope, prefersReducedMotion } from "./motion";

describe("motion tokens", () => {
  it("keeps the locked named tokens within their ratified ranges", () => {
    expect(MOTION.foregroundMs).toBeLessThan(200);
    expect(MOTION.breathingMs).toBeGreaterThanOrEqual(600);
    expect(MOTION.breathingMs).toBeLessThanOrEqual(900);
    expect(MOTION.fireAttackMs).toBeLessThan(120);
    expect(MOTION.fireDecayMs).toBeGreaterThanOrEqual(400);
    expect(MOTION.fireDecayMs).toBeLessThanOrEqual(600);
    expect(MOTION.energyRampMs).toBeGreaterThanOrEqual(1200);
    expect(MOTION.energyRampMs).toBeLessThanOrEqual(1800);
    expect(MOTION.coFireStaggerMs).toBeGreaterThanOrEqual(80);
    expect(MOTION.coFireStaggerMs).toBeLessThanOrEqual(120);
  });

  it("breathe oscillates in [0,1], 0 at t=0 and 1 at half-period", () => {
    expect(breathe(0)).toBeCloseTo(0, 5);
    expect(breathe(MOTION.breathingMs / 2)).toBeCloseTo(1, 5);
    expect(breathe(MOTION.breathingMs)).toBeCloseTo(0, 5);
  });

  it("easeInRamp clamps and accelerates", () => {
    expect(easeInRamp(-1)).toBe(0);
    expect(easeInRamp(2)).toBe(1);
    expect(easeInRamp(0.5)).toBe(0.25);
  });

  it("fireEnvelope: 0 before, peaks at attack end, decays to 0", () => {
    expect(fireEnvelope(-1)).toBe(0);
    expect(fireEnvelope(MOTION.fireAttackMs)).toBeCloseTo(1, 5);
    expect(fireEnvelope(MOTION.fireAttackMs / 2)).toBeCloseTo(0.5, 5);
    expect(fireEnvelope(MOTION.fireAttackMs + MOTION.fireDecayMs + 1)).toBe(0);
    // mid-decay is strictly between 0 and 1
    const mid = fireEnvelope(MOTION.fireAttackMs + MOTION.fireDecayMs / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("prefersReducedMotion is false without a window (SSR-safe)", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});
