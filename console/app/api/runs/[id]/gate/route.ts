// console/app/api/runs/[id]/gate/route.ts
// POST /api/runs/[id]/gate — operator's gate decision (the live target of RunLane's
// approve/reject). Validates: gateId ∈ {A,B,C,D} and status ∈ {approved,rejected,clear,raised}.
// 404 unknown run, 422 bad input. On success it records the decision as a `gate` envelope
// (persisted + broadcast) so every connected fleet client reflects it live. CSRF-guarded.
//
// This route does NOT itself mutate git — it records the operator's verdict on a gate the
// harness raised; the harness pipeline observes the cleared gate on its next step.
// ponytail: wire gate-clear back into a resumable harness step when the daemon supports
// pausing at a gate; add when the run pauses instead of exiting on a raised gate.
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { csrfOk } from "@/lib/server/csrf";
import { getSnapshot, appendEvent } from "@/lib/server/persist";
import { publish } from "@/lib/server/broker";
import type { Envelope } from "@/lib/contract/events";
import type { GateId, GateStatus } from "@/lib/contract/types";

const VALID_GATE_IDS: readonly GateId[] = ["A", "B", "C", "D"];
const VALID_STATUSES: readonly GateStatus[] = ["approved", "rejected", "clear", "raised"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  if (!csrfOk(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const snapshot = getSnapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  let gateId: GateId;
  let status: GateStatus;
  try {
    const raw = (await req.json()) as Record<string, unknown>;
    if (!VALID_GATE_IDS.includes(raw.gateId as GateId)) {
      return NextResponse.json({ error: `gateId must be one of: ${VALID_GATE_IDS.join(", ")}` }, { status: 422 });
    }
    if (!VALID_STATUSES.includes(raw.status as GateStatus)) {
      return NextResponse.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 422 });
    }
    gateId = raw.gateId as GateId;
    status = raw.status as GateStatus;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Reuse the raised gate's severity/summary/subtask so the decision keeps its context.
  const existing = snapshot.gates.find((g) => g.id === gateId);
  const env: Envelope = {
    runId: id,
    projectId: snapshot.projectId,
    agentId: "operator",
    ts: Math.floor(Date.now() / 1000),
    type: "gate",
    payload: {
      id: gateId,
      status,
      severity: existing?.severity ?? "info",
      summary: existing ? `${existing.summary} — ${status}` : `Gate ${gateId} ${status}`,
      ...(existing?.subtaskId ? { subtaskId: existing.subtaskId } : {}),
    },
  };
  try {
    appendEvent(env);
  } catch {
    /* persistence best-effort; the broadcast is what the UI consumes live */
  }
  publish(env);

  return NextResponse.json({ ok: true, runId: id, gateId, status });
}
