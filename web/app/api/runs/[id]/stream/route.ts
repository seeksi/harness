// web/app/api/runs/[id]/stream/route.ts
// GET /api/runs/[id]/stream — SSE endpoint.
// Emits a `hello` snapshot (the resync), then forwards the daemon's LIVE events
// from the broker (no independent fixture replay), then a terminal STREAM_END
// frame so the client closes cleanly instead of reconnect-replaying.
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import type { SSEEvent } from "@/lib/contract/events";
import { getSnapshot, isRunFinalized } from "@/lib/store/persist";
import { STREAM_END } from "@/lib/sse/client";
import { subscribe, onDone, isDone } from "@/lib/daemon/broker";
import { assertNoCredential } from "@/lib/security/credentials";

function sseChunk(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const END_FRAME = `data: ${JSON.stringify({ type: STREAM_END })}\n\n`;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse | Response> {
  const { id } = await params;

  // Validate run id exists (must be in DB).
  if (!getSnapshot(id)) {
    return NextResponse.json({ error: "run not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller already closed (client gone) — ignore.
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed — ignore.
        }
      };

      // Read the snapshot and subscribe synchronously in the same tick, so the
      // daemon's timer-driven publish cannot interleave between them — the hello
      // snapshot and the live subscription join with no gap.
      const helloEvent: SSEEvent = { type: "hello", run: getSnapshot(id)! };
      // Fail-closed guard (T4b): never serialize a credential to the browser.
      assertNoCredential(helloEvent);
      enqueue(sseChunk(helloEvent));

      // Run already finished before this client connected (in-memory broker done,
      // or a terminal outcome persisted — e.g. after a process restart) → end now.
      if (isDone(id) || isRunFinalized(id)) {
        enqueue(END_FRAME);
        close();
        return;
      }

      const unsubEvents = subscribe(id, (event) => enqueue(sseChunk(event)));
      const unsubDone = onDone(id, () => {
        enqueue(END_FRAME);
        cleanup();
        close();
      });
      const onAbort = () => {
        cleanup();
        close();
      };
      req.signal.addEventListener("abort", onAbort);

      function cleanup() {
        unsubEvents();
        unsubDone();
        req.signal.removeEventListener("abort", onAbort);
      }

      if (req.signal.aborted) onAbort();
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
