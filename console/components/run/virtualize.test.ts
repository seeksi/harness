import { describe, it, expect } from "vitest";
import { computeWindow, isNearBottom } from "./virtualize";

describe("computeWindow", () => {
  it("empty feed renders nothing", () => {
    expect(computeWindow(0, 20, 0, 400)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });

  it("scrolled to top renders from index 0 with no top pad", () => {
    const w = computeWindow(400, 20, 0, 400, 6);
    expect(w.start).toBe(0);
    expect(w.topPad).toBe(0);
    expect(w.end).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(400); // DOM stays bounded — not every row rendered
  });

  it("caps the window at the total when scrolled past the end", () => {
    const w = computeWindow(50, 20, 100_000, 400, 6);
    expect(w.end).toBe(50);
    expect(w.bottomPad).toBe(0);
  });

  it("windows the middle of a long feed with symmetric overscan bounds", () => {
    const w = computeWindow(1000, 20, 5000, 400, 6);
    // scrollTop 5000 / itemH 20 = row 250; overscan 6 either side.
    expect(w.start).toBeLessThanOrEqual(250);
    expect(w.end).toBeGreaterThan(250);
    expect(w.topPad).toBe(w.start * 20);
    expect(w.bottomPad).toBe((1000 - w.end) * 20);
  });

  it("degenerates to empty on non-positive itemH (never divides by zero)", () => {
    expect(computeWindow(10, 0, 0, 400)).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });
});

describe("isNearBottom", () => {
  it("true when scrolled to the very bottom", () => {
    expect(isNearBottom(580, 400, 980)).toBe(true); // 980 - (580+400) = 0
  });

  it("true within the threshold slack", () => {
    expect(isNearBottom(560, 400, 980, 48)).toBe(true); // gap = 20
  });

  it("false once scrolled away past the threshold (scroll-lock engages)", () => {
    expect(isNearBottom(0, 400, 980, 48)).toBe(false); // gap = 580
  });
});
