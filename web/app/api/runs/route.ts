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

// Active run generator — module-level singleton for the single slot.
// ponytail: move to a shared context / singleton module when fan-out is needed.
let activeHandle: { runId: string; gen: AsyncGenerator<unknown, void, unknown> } | null = null;

/** Drain the generator in the background so the run progresses without a subscriber. */
function drainInBackground(handle: Awaited<ReturnType<typeof startRun>>): void {
  const { runId, events } = handle;
  activeHandle = { runId, gen: events };
  void (async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of events) {
      // Persist is done inside the generator; nothing more needed here.
    }
    if (activeHandle?.runId === runId) activeHandle = null;
  })();
}

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
    const handle = await startRun(runId, body.brief);
    drainInBackground(handle);
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
