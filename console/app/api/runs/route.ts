// console/app/api/runs/route.ts
// POST /api/runs — launch a LIVE harness run. The server generates the runId (NEVER
// client-supplied) and drives the spawn pipeline (daemon.startRun). Strict validation:
//   - projectId MUST match a discovered project (an arbitrary path is rejected — it never
//     becomes a cwd or a provenance value);
//   - brief is a non-empty, length-capped string (opaque task text — not provenance);
//   - routing is an OPTIONAL enum whitelist (auto|haiku|sonnet|opus).
// CSRF-guarded. LIVE-gated: with HARNESS_LIVE unset this returns 503 and the client keeps
// its fixture-mode optimistic launch (regression-critical — the fixture path is untouched).
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { csrfOk } from "@/lib/server/csrf";
import { discoverProjects } from "@/lib/server/discovery";
import { startRun, currentSlot, SlotTakenError, type Routing } from "@/lib/server/daemon";

const BRIEF_MAX = 4000; // length cap (§5 brief is required, non-empty)
const VALID_ROUTING: readonly Routing[] = ["auto", "haiku", "sonnet", "opus"];
const ALLOWED_FIELDS = new Set(["projectId", "brief", "routing"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!csrfOk(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (process.env.HARNESS_LIVE !== "1") {
    // Fixture mode: the client launches optimistically in-browser (unchanged). The live
    // spawn endpoint is off until HARNESS_LIVE=1.
    return NextResponse.json({ error: "live mode disabled (HARNESS_LIVE unset)", live: false }, { status: 503 });
  }

  let projectId: string;
  let brief: string;
  let routing: Routing = "auto";
  try {
    const raw = (await req.json()) as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!ALLOWED_FIELDS.has(key)) {
        return NextResponse.json({ error: `unknown field: ${key}` }, { status: 422 });
      }
    }
    if (typeof raw.projectId !== "string" || raw.projectId.trim() === "") {
      return NextResponse.json({ error: "projectId must be a non-empty string" }, { status: 422 });
    }
    if (typeof raw.brief !== "string" || raw.brief.trim() === "") {
      return NextResponse.json({ error: "brief must be a non-empty string" }, { status: 422 });
    }
    if (raw.brief.length > BRIEF_MAX) {
      return NextResponse.json({ error: `brief exceeds ${BRIEF_MAX} chars` }, { status: 422 });
    }
    if (raw.routing !== undefined) {
      if (typeof raw.routing !== "string" || !VALID_ROUTING.includes(raw.routing as Routing)) {
        return NextResponse.json(
          { error: `routing must be one of: ${VALID_ROUTING.join(", ")}` },
          { status: 422 }
        );
      }
      routing = raw.routing as Routing;
    }
    projectId = raw.projectId;
    brief = raw.brief.trim();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // projectId MUST resolve to a discovered project — not an arbitrary caller string.
  const project = discoverProjects().find((p) => p.id === projectId);
  if (!project) {
    return NextResponse.json({ error: "unknown projectId (not a discovered project)" }, { status: 422 });
  }

  // Server-generated ID — NEVER client-supplied (threat model T1: provenance is derived
  // from this, never from the brief/projectId).
  const runId = crypto.randomBytes(12).toString("hex");

  try {
    startRun({ runId, projectId: project.id, projectName: project.name, brief, routing });
    return NextResponse.json({ id: runId, live: true }, { status: 201 });
  } catch (e) {
    if (e instanceof SlotTakenError) {
      return NextResponse.json({ error: "slot occupied — a run is already in flight" }, { status: 409 });
    }
    throw e;
  }
}

// GET /api/runs — mode probe for the client: is live spawning enabled, and is the slot
// occupied. The client uses `live` to decide launch/approve routing (POST vs optimistic).
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ live: process.env.HARNESS_LIVE === "1", slot: currentSlot() });
}
