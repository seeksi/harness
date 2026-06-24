// web/hud/sacred.test.ts
import { describe, it, expect } from "vitest";
import { onGateArrival } from "./sacred";

describe("open-detail-is-sacred", () => {
  it("surfaces a gate when no detail is open", () => {
    expect(onGateArrival("D", false)).toEqual({ type: "surface", gateId: "D" });
  });

  it("queues + offers a close-toast when a detail is open", () => {
    expect(onGateArrival("D", true)).toEqual({ type: "queue", gateId: "D", toastOnClose: true });
  });
});
