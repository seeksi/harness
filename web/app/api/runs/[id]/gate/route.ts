// web/app/api/runs/[id]/gate/route.ts
// POST /api/runs/[id]/gate
// Validates: id ∈ {A,B,C,D} and status ∈ {clear,raised,resolved}. 422 on bad, 404 unknown run.
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { csrfOk } from "@/lib/api/csrf";
import { getSnapshot } from "@/lib/store/persist";
import type { GateId } from "@/lib/contract/types";

const VALID_GATE_IDS = ["A", "B", "C", "D"] as const;
const VALID_GATE_STATUSES = ["clear", "raised", "resolved"] as const;
type GateStatus = (typeof VALID_GATE_STATUSES)[number];

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

  let body: { gateId: GateId; status: GateStatus };
  try {
    const raw = await req.json() as Record<string, unknown>;
    if (!VALID_GATE_IDS.includes(raw.gateId as GateId)) {
      return NextResponse.json(
        { error: `gateId must be one of: ${VALID_GATE_IDS.join(", ")}` },
        { status: 422 }
      );
    }
    if (!VALID_GATE_STATUSES.includes(raw.status as GateStatus)) {
      return NextResponse.json(
        { error: `status must be one of: ${VALID_GATE_STATUSES.join(", ")}` },
        { status: 422 }
      );
    }
    body = { gateId: raw.gateId as GateId, status: raw.status as GateStatus };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, runId: id, gateId: body.gateId, status: body.status });
}
