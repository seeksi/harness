import { describe, it, expect } from "vitest";
import {
  armOrConfirmReject,
  cancelReject,
  isArmed,
  buildGateApproveEnvelopes,
  buildGateRejectEnvelopes,
  buildPromoteApproveEnvelopes,
  gateEffect,
  type GateConfirmState,
} from "./gateActions";
import type { Gate, PhaseState } from "@/lib/contract/types";

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

function gate(over: Partial<Gate> = {}): Gate {
  return { id: "B", status: "raised", severity: "high", summary: "review blocked", ...over };
}

function phase(over: Partial<PhaseState> = {}): PhaseState {
  return { id: 6, label: "eval+promote", status: "active", approval: { kind: "promote-to-main", state: "awaiting" }, ...over };
}

describe("buildGateApproveEnvelopes", () => {
  it("emits approval scoped to THAT gate id only — no phase envelope, no other gate touched", () => {
    const envs = buildGateApproveEnvelopes(gate({ id: "C", summary: "budget over" }));
    expect(envs).toEqual([
      { type: "gate", payload: { id: "C", status: "approved", severity: "high", summary: "budget over — approved" } },
    ]);
    expect(envs.some((e) => e.type === "phase")).toBe(false);
  });

  it("different gate ids produce independently-addressed envelopes", () => {
    const a = buildGateApproveEnvelopes(gate({ id: "A" }));
    const d = buildGateApproveEnvelopes(gate({ id: "D" }));
    expect((a[0].payload as { id: string }).id).toBe("A");
    expect((d[0].payload as { id: string }).id).toBe("D");
  });
});

describe("buildGateRejectEnvelopes", () => {
  it("emits a rejection for that gate plus a degraded health note referencing it", () => {
    const envs = buildGateRejectEnvelopes(gate({ id: "D", summary: "anomaly" }));
    expect(envs).toEqual([
      { type: "gate", payload: { id: "D", status: "rejected", severity: "high", summary: "anomaly — rejected" } },
      { type: "health", payload: { verdict: "degraded", note: "Gate D rejected" } },
    ]);
  });
});

describe("gateEffect — LIVE routes to a POST, FIXTURE stays optimistic", () => {
  it("LIVE approve → a `post` effect carrying runId/gateId/status (no local envelopes)", () => {
    const eff = gateEffect(true, "run-xyz", gate({ id: "B" }), "approved");
    expect(eff).toEqual({ kind: "post", runId: "run-xyz", gateId: "B", status: "approved" });
  });

  it("LIVE reject → a `post` effect with status rejected", () => {
    const eff = gateEffect(true, "run-xyz", gate({ id: "C" }), "rejected");
    expect(eff).toEqual({ kind: "post", runId: "run-xyz", gateId: "C", status: "rejected" });
  });

  it("FIXTURE approve → the optimistic local envelopes (unchanged), never a post", () => {
    const eff = gateEffect(false, "run-xyz", gate({ id: "B", summary: "review blocked" }), "approved");
    expect(eff).toEqual({ kind: "emit", envelopes: buildGateApproveEnvelopes(gate({ id: "B", summary: "review blocked" })) });
    expect(eff.kind).toBe("emit");
  });

  it("FIXTURE reject → the optimistic reject envelopes (gate + degraded health), never a post", () => {
    const eff = gateEffect(false, "run-xyz", gate({ id: "B", summary: "review blocked" }), "rejected");
    expect(eff).toEqual({ kind: "emit", envelopes: buildGateRejectEnvelopes(gate({ id: "B", summary: "review blocked" })) });
  });
});

describe("buildPromoteApproveEnvelopes", () => {
  it("emits ONLY the promote-to-main approval on the awaiting phase — not a gate envelope", () => {
    const envs = buildPromoteApproveEnvelopes(phase({ id: 6 }));
    expect(envs).toEqual([
      { type: "phase", payload: { phase: 6, status: "done", approval: { kind: "promote-to-main", state: "approved" } } },
    ]);
    expect(envs.every((e) => e.type === "phase")).toBe(true);
  });
});
