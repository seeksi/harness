// web/app/api/runs/route.ts
// POST /api/runs  — start a run (server-generated ID, single-slot)
// GET  /api/runs  — return current snapshot (or idle state)
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { csrfOk } from "@/lib/api/csrf";
import { startRun, SlotTakenError } from "@/lib/daemon/daemon";
import { currentSlot, getSnapshot } from "@/lib/store/persist";
import { initialRunState } from "@/lib/contract/types";

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!csrfOk(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Strict JSON validation — reject non-JSON and unknown fields.
  let body: { brief: string };
  try {
    const raw = await req.json() as Record<string, unknown>;
    // Only allow the `brief` field.
    const allowed = new Set(["brief"]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        return NextResponse.json({ error: `unknown field: ${key}` }, { status: 422 });
      }
    }
    if (typeof raw.brief !== "string" || raw.brief.trim() === "") {
      return NextResponse.json({ error: "brief must be a non-empty string" }, { status: 422 });
    }
    body = { brief: raw.brief.trim() };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Server-generated ID — NEVER client-supplied.
  const runId = crypto.randomBytes(12).toString("hex");

  try {
    // Kicks off the background producer; events flow via the broker + persistence.
    startRun(runId, body.brief);
    return NextResponse.json({ id: runId }, { status: 201 });
  } catch (e) {
    if (e instanceof SlotTakenError) {
      return NextResponse.json({ error: "slot occupied" }, { status: 409 });
    }
    throw e;
  }
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const slot = currentSlot();
  if (!slot) {
    return NextResponse.json({ state: initialRunState });
  }
  const snapshot = getSnapshot(slot);
  return NextResponse.json({ id: slot, state: snapshot ?? initialRunState });
}
