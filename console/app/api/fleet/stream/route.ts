// console/app/api/fleet/stream/route.ts
// GET /api/fleet/stream — the fleet SSE endpoint. Day-one source is the deterministic
// fixture (the live harness.sh bridge is Batch B+). Each frame carries an `id:` (its
// index) so EventSource reconnects with Last-Event-ID and we RESUME from the next
// index — gapless replay, no duplicate frames, no gap. A terminal STREAM_END frame
// closes the client cleanly (a bare close would auto-reconnect + re-replay forever).
export const runtime = "nodejs";

import type { Envelope } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { STREAM_END } from "@/lib/sse/client";

const FRAME_MS = 220; // pacing for the streaming heartbeat

function frame(env: Envelope, id: number): string {
  return `id: ${id}\ndata: ${JSON.stringify(env)}\n\n`;
}

export async function GET(req: Request): Promise<Response> {
  const envelopes = fixtureEnvelopes();
  const lastId = Number(req.headers.get("Last-Event-ID"));
  const startIdx = Number.isFinite(lastId) && lastId >= 0 ? lastId + 1 : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);

      for (let i = startIdx; i < envelopes.length; i++) {
        if (closed || req.signal.aborted) break;
        enqueue(frame(envelopes[i], i));
        await new Promise((r) => setTimeout(r, FRAME_MS));
      }
      enqueue(`data: ${JSON.stringify({ type: STREAM_END })}\n\n`);
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
