// console/components/run/gateActions.ts
// Gate-card confirm-on-destructive state (§5: "amber approve / red reject w/
// confirm"). Approve fires immediately; reject arms a confirm step first — the
// SAME gate's reject clicked again is the confirmation, any other click cancels
// it. Pure reducer so the confirm flow is unit-testable without a DOM.
//
// Also: the pure envelope builders for gate approve/reject and promote. Each is
// gate-id-aware and emits ONLY what that specific action means — approving gate
// B never blindly closes phase 4, and promote is its own action (never a fake
// "approve gate A"). Structured as plain {type, payload} pairs (the Envelope
// shape minus the runId/projectId/agentId/ts envelope fields the caller adds) so
// a live bridge can route them to the daemon later without touching this logic.

import type { Gate, GateId, PhaseState } from "@/lib/contract/types";
import type { GatePayload, HealthPayload, PhasePayload } from "@/lib/contract/events";

export type GateConfirmState = { gateId: GateId } | null;

export type ActionEnvelope =
  | { type: "gate"; payload: GatePayload }
  | { type: "phase"; payload: PhasePayload }
  | { type: "health"; payload: HealthPayload };

// Approving a gate emits approval for THAT gate id only — no bundled phase
// advance, no bundled promote approval. Phase 4 completing (or not) is a
// producer-side/derived concern, never inferred client-side from one gate click.
export function buildGateApproveEnvelopes(gate: Gate): ActionEnvelope[] {
  return [
    { type: "gate", payload: { id: gate.id, status: "approved", severity: gate.severity, summary: `${gate.summary} — approved` } },
  ];
}

export function buildGateRejectEnvelopes(gate: Gate): ActionEnvelope[] {
  return [
    { type: "gate", payload: { id: gate.id, status: "rejected", severity: gate.severity, summary: `${gate.summary} — rejected` } },
    { type: "health", payload: { verdict: "degraded", note: `Gate ${gate.id} rejected` } },
  ];
}

// Promote is its own action, scoped to the awaiting phase's promote-to-main
// approval — never disguised as approving gate "A".
export function buildPromoteApproveEnvelopes(phase: PhaseState): ActionEnvelope[] {
  return [
    { type: "phase", payload: { phase: phase.id, status: "done", approval: { kind: "promote-to-main", state: "approved" } } },
  ];
}

export interface RejectStep {
  next: GateConfirmState;
  confirmed: boolean; // true = this click is the confirmation; caller should now emit the reject
}

// First reject click on a gate arms it ("are you sure?"); a second click on the
// SAME gate confirms; a reject click on a DIFFERENT gate re-arms for that one
// instead (never silently confirms the wrong gate).
export function armOrConfirmReject(state: GateConfirmState, gateId: GateId): RejectStep {
  if (state && state.gateId === gateId) return { next: null, confirmed: true };
  return { next: { gateId }, confirmed: false };
}

export function cancelReject(): GateConfirmState {
  return null;
}

export function isArmed(state: GateConfirmState, gateId: GateId): boolean {
  return state?.gateId === gateId;
}
