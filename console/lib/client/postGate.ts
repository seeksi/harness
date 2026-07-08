// console/lib/client/postGate.ts
// Client → live gate endpoint. Shared by FleetHome (fleet lane) and RunFocus (the
// run-focus page) so the operator's approve/reject verdict routes to the harness the
// SAME way from both surfaces. CSRF-headed (matches lib/server/csrf.ts). Best-effort:
// the SSE stream is what actually reflects the result, so a network error is swallowed.
import type { GateId, GateStatus } from "@/lib/contract/types";

export function postGate(runId: string, gateId: GateId, status: GateStatus): void {
  void fetch(`/api/runs/${encodeURIComponent(runId)}/gate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-request": "1" },
    body: JSON.stringify({ gateId, status }),
  }).catch(() => {});
}
