// web/app/api/runs/[id]/approve/route.ts
// POST /api/runs/[id]/approve
// Validates: kind ∈ {decompose-split, promote-to-main} AND kind matches the
// phase the run is actually in. 422 on mismatch, 404 unknown run.
//
// promote-to-main is PREVIEW-ONLY (non-mutating) in this increment.
// ponytail: real git ff-only is behind ENABLE_PROMOTE_TO_MAIN env flag;
// add when the harness-bridge spawn is wired and the threat model is confirmed.
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { csrfOk } from "@/lib/api/csrf";
import { getSnapshot } from "@/lib/store/persist";

const ENABLE_PROMOTE_TO_MAIN = process.env.ENABLE_PROMOTE_TO_MAIN === "1";

const VALID_KINDS = ["decompose-split", "promote-to-main"] as const;
type ApprovalKind = (typeof VALID_KINDS)[number];

// Phase that owns each approval kind.
const KIND_PHASE: Record<ApprovalKind, number> = {
  "decompose-split": 1,
  "promote-to-main": 6,
};

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

  let body: { kind: ApprovalKind };
  try {
    const raw = await req.json() as Record<string, unknown>;
    if (!VALID_KINDS.includes(raw.kind as ApprovalKind)) {
      return NextResponse.json(
        { error: `kind must be one of: ${VALID_KINDS.join(", ")}` },
        { status: 422 }
      );
    }
    body = { kind: raw.kind as ApprovalKind };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Server-check: kind must match the current phase.
  const currentPhase = snapshot.task.phase;
  const expectedPhase = KIND_PHASE[body.kind];
  if (currentPhase !== expectedPhase) {
    return NextResponse.json(
      {
        error: `kind '${body.kind}' requires phase ${expectedPhase}, run is in phase ${currentPhase}`,
      },
      { status: 422 }
    );
  }

  if (body.kind === "promote-to-main" && !ENABLE_PROMOTE_TO_MAIN) {
    // ponytail: real ff-only promote via harness-bridge; add when ENABLE_PROMOTE_TO_MAIN=1.
    return NextResponse.json({
      ok: true,
      preview: true,
      note: "promote-to-main is preview-only in this increment; no git mutation performed",
    });
  }

  // decompose-split (or promote when flag is on): acknowledge.
  return NextResponse.json({ ok: true, runId: id, kind: body.kind });
}
