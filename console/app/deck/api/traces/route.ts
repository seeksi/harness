// console/app/deck/api/traces/route.ts
// GET /deck/api/traces            — list available raw session ids (best-effort).
// GET /deck/api/traces?session=X  — read+parse one .claude/traces/<X>.jsonl (validated).
// Read-only trust boundary: see lib/traceFile.ts for the session-id whitelist + the
// symlink/size hardening. Any request-controlled input reaching fs is validated there
// BEFORE it's used, never after.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { listSessions, readTraceFile, isValidSessionId } from "@/app/deck/lib/traceFile";

function repoRoot(): string {
  return process.env.HARNESS_REPO ?? process.cwd();
}

export async function GET(req: Request): Promise<NextResponse> {
  const session = new URL(req.url).searchParams.get("session");
  const root = repoRoot();

  if (session === null) {
    try {
      return NextResponse.json({ sessions: listSessions(root) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "failed to list traces";
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  if (!isValidSessionId(session)) {
    return NextResponse.json({ error: "invalid session id" }, { status: 400 });
  }
  try {
    const lines = readTraceFile(root, session);
    return NextResponse.json({ session, lines });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed to read trace";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
