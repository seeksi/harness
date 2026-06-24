// web/app/api/runs/[id]/stream/route.ts
// GET /api/runs/[id]/stream — SSE endpoint
// Emits: hello snapshot first, then the dry-run events in order, then a terminal
// STREAM_END frame. Raw events are streamed; the client store reduces them.
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import type { SSEEvent } from "@/lib/contract/events";
import { dryRun } from "@/lib/contract/fixture";
import { getSnapshot } from "@/lib/store/persist";
import { STREAM_END } from "@/lib/sse/client";

function sseChunk(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const { id } = await params;

  // Validate run id exists (must be in DB).
  const snapshot = getSnapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) =>
        controller.enqueue(encoder.encode(chunk));

      // Stop the replay if the client disconnects — otherwise the 50ms timer
      // chain runs to completion against a dead connection.
      let aborted = req.signal.aborted;
      const onAbort = () => {
        aborted = true;
      };
      req.signal.addEventListener("abort", onAbort);

      try {
        if (aborted) return;
        // 1. Emit hello with current snapshot (the only resync path).
        enqueue(sseChunk({ type: "hello", run: snapshot }));

        // 2. Replay the dry-run events (raw; the client store reduces them).
        for (const event of dryRun) {
          if (aborted) return;
          if (event.type === "hello") continue; // already sent the real snapshot above
          enqueue(sseChunk(event));
          await new Promise<void>((res) => setTimeout(res, 50));
        }

        // 3. Terminal frame: the dry run is finite. Without this the client's
        // EventSource would treat the close as an error and reconnect, re-replaying
        // the whole fixture forever.
        if (aborted) return;
        enqueue(`data: ${JSON.stringify({ type: STREAM_END })}\n\n`);
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // already closed (e.g. client disconnected) — nothing to do.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Explicitly no CORS headers (security requirement).
    },
  });
}
