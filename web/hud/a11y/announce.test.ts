// web/hud/a11y/announce.test.ts
import { describe, it, expect } from "vitest";
import { announceGateCleared, announceGateResolved } from "./announce";

describe("announceGateCleared", () => {
  it("surfaces the commit summary so the operator is told what cleared", () => {
    expect(announceGateCleared("B", "lane feat/built committed and clean")).toBe(
      "Gate B clear — lane feat/built committed and clean"
    );
  });

  it("is distinct from the operator-resolved copy", () => {
    expect(announceGateCleared("B", "x")).not.toBe(announceGateResolved("B"));
  });
});
