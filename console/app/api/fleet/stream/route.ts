// console/app/api/fleet/stream/route.ts
// GET /api/fleet/stream — the fleet SSE endpoint. TWO producers behind one contract:
//   - FIXTURE (default, HARNESS_LIVE unset): the deterministic fixture replay. UNCHANGED
//     from before the live bridge — each frame carries an `id:` index; reconnect resumes
//     from the next index (gapless); a terminal STREAM_END closes the finite stream.
//   - LIVE (HARNESS_LIVE=1): fan out the in-process daemon broker. Each frame's `id:` is
//     the broker's monotonic seq; a reconnect (?lastEventId= / Last-Event-ID) replays the
//     ring buffer from that seq, then attaches for new events. Open-ended (no STREAM_END):
//     a dropped live connection reconnects and resumes from its cursor.
export const runtime = "nodejs";

import type { Envelope } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { STREAM_END } from "@/lib/sse/client";
import { resumeStartIndex } from "@/lib/sse/resume";
import { attachReplay, since } from "@/lib/server/broker";
import { getSnapshot } from "@/lib/server/persist";

const FRAME_MS = 220; // pacing for the streaming heartbeat (fixture)
const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function frame(env: Envelope, id: number | string): string {
  return `id: ${id}\ndata: ${JSON.stringify(env)}\n\n`;
}

function cursorFrom(req: Request): string | null {
  return req.headers.get("Last-Event-ID") ?? new URL(req.url).searchParams.get("lastEventId");
}

export async function GET(req: Request): Promise<Response> {
  if (process.env.HARNESS_LIVE === "1") return liveStream(req);
  return fixtureStream(req);
}

// --- fixture (unchanged) ----------------------------------------------------------
function fixtureStream(req: Request): Response {
  const envelopes = fixtureEnvelopes();
  const startIdx = resumeStartIndex(cursorFrom(req));

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

  return new Response(stream, { headers: SSE_HEADERS });
}

// --- live broker fan-out ----------------------------------------------------------
function liveStream(req: Request): Response {
  const raw = cursorFrom(req);
  const cursor = raw && /^\d+$/.test(raw) ? Number(raw) : 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsub: (() => void) | undefined;
      let ping: ReturnType<typeof setInterval> | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsub?.(); // release the broker listener
        if (ping) clearInterval(ping); // release the keep-alive interval
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The stream is gone: tear DOWN fully (listener + ping), not just flip a flag —
          // otherwise the broker subscription + ping interval leak for the process lifetime.
          close();
        }
      };
      req.signal.addEventListener("abort", close);

      // Flush headers immediately (an idle fleet emits nothing for a while) so the client's
      // connection opens right away instead of hanging until the first event/ping.
      enqueue(`: open\n\n`);

      // Gapless attach: subscribe-first + buffered replay, deduped by seq (no lost/duplicate
      // frame across the replay↔live window). On a stale cursor (older than the ring floor)
      // re-seed a fresh snapshot per run instead of silently skipping the evicted events.
      unsub = attachReplay(
        cursor,
        (item) => enqueue(frame(item.env, item.seq)),
        {
          onGap: () => {
            // Emit an authoritative full-run snapshot (a `sync` frame, wholesale-applied by
            // the reducer) for every run still referenced in the retained ring. No `id:` line
            // so the client's resume cursor is only advanced by the numeric replay frames.
            const runIds = new Set(since(0).map((i) => i.env.runId));
            for (const runId of runIds) {
              const snap = getSnapshot(runId);
              if (snap) {
                const sync: Envelope = {
                  runId: snap.runId,
                  projectId: snap.projectId,
                  agentId: "resync",
                  ts: Math.floor(Date.now() / 1000),
                  type: "sync",
                  payload: { run: snap },
                };
                enqueue(`data: ${JSON.stringify(sync)}\n\n`);
              }
            }
          },
        }
      );

      // Keep-alive comment so idle intermediaries don't drop the connection.
      ping = setInterval(() => enqueue(`: ping\n\n`), 15_000);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
