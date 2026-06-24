// web/hud/sacred.ts
// "Open detail context is sacred" (design package stress-test, risk-mitigation):
// a gate auto-surfaces ONLY when no detail panel is open; otherwise it queues to a
// loud inbox item and a non-blocking toast is offered when the detail later closes.
// Pure decision so the rule is unit-tested and the component just executes it.

export type GateArrivalAction =
  | { type: "surface"; gateId: string }
  | { type: "queue"; gateId: string; toastOnClose: true };

export function onGateArrival(gateId: string, isDetailOpen: boolean): GateArrivalAction {
  return isDetailOpen
    ? { type: "queue", gateId, toastOnClose: true }
    : { type: "surface", gateId };
}
