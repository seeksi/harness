// console/components/run/gateActions.ts
// Gate-card confirm-on-destructive state (§5: "amber approve / red reject w/
// confirm"). Approve fires immediately; reject arms a confirm step first — the
// SAME gate's reject clicked again is the confirmation, any other click cancels
// it. Pure reducer so the confirm flow is unit-testable without a DOM.

import type { GateId } from "@/lib/contract/types";

export type GateConfirmState = { gateId: GateId } | null;

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
