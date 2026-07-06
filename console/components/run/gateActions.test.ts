import { describe, it, expect } from "vitest";
import { armOrConfirmReject, cancelReject, isArmed, type GateConfirmState } from "./gateActions";

describe("armOrConfirmReject", () => {
  it("first click arms the gate without confirming", () => {
    const r = armOrConfirmReject(null, "B");
    expect(r.confirmed).toBe(false);
    expect(r.next).toEqual({ gateId: "B" });
  });

  it("second click on the SAME gate confirms and clears the armed state", () => {
    const armed: GateConfirmState = { gateId: "B" };
    const r = armOrConfirmReject(armed, "B");
    expect(r.confirmed).toBe(true);
    expect(r.next).toBeNull();
  });

  it("a click on a DIFFERENT gate re-arms instead of confirming the old one", () => {
    const armed: GateConfirmState = { gateId: "A" };
    const r = armOrConfirmReject(armed, "B");
    expect(r.confirmed).toBe(false);
    expect(r.next).toEqual({ gateId: "B" });
  });
});

describe("cancelReject / isArmed", () => {
  it("cancelReject always clears to null", () => {
    expect(cancelReject()).toBeNull();
  });

  it("isArmed reflects whether the given gate is the one pending confirmation", () => {
    const armed: GateConfirmState = { gateId: "C" };
    expect(isArmed(armed, "C")).toBe(true);
    expect(isArmed(armed, "D")).toBe(false);
    expect(isArmed(null, "C")).toBe(false);
  });
});
