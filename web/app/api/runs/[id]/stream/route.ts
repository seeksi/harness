// web/app/api/runs/[id]/stream/route.ts
// GET /api/runs/[id]/stream — SSE endpoint
// Emits: hello snapshot first, then the dry-run events in order.
// Each event is persisted by the daemon generator.
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { reducer } from "@/lib/contract/events";
import { initialRunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";
import { dryRun } from "@/lib/contract/fixture";
import { getSnapshot } from "@/lib/store/persist";

function sseChunk(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  _req: NextRequest,
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

      try {
        // 1. Emit hello with current snapshot (the only resync path).
        const helloEvent: SSEEvent = { type: "hello", run: snapshot };
        enqueue(sseChunk(helloEvent));

        // 2. Replay the dry-run events, reducing state as we go.
        let state = snapshot;
        for (const event of dryRun) {
          if (event.type === "hello") continue; // already sent the real snapshot above
          state = reducer(state, event);
          enqueue(sseChunk(event));
          await new Promise<void>((res) => setTimeout(res, 50));
        }
      } finally {
        controller.close();
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
