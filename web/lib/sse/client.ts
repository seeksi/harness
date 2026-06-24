// web/lib/sse/client.ts — Lane C sole writer.
// Opens an EventSource to /api/runs/[id]/stream, parses each message to SSEEvent,
// and calls store.apply(event). Never calls React setState or subscriber directly.
// The only notifier is the rAF flush (Lane B's raf-flush.ts calls store.flush()).
//
// Reconnect strategy: exponential back-off with jitter, capped at 30s.
// While disconnected, we do NOT show stale data — we leave the last known state
// visible but a "reconnecting" overlay is signalled via the onStatusChange callback.
// On reconnect the server always sends a `hello` event first; the reducer treats
// `hello` as a wholesale RunState replacement (stale pre-disconnect data is gone).

import type { RunStore } from "@/lib/contract/store";
import type { SSEEvent } from "@/lib/contract/events";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

// Terminal control frame. A finite stream (e.g. the dry run) ends by sending this
// instead of just closing the connection — EventSource treats a bare close as an
// error and auto-reconnects, which would re-replay the whole stream forever. On
// this frame the client closes WITHOUT reconnecting. It is NOT a domain SSEEvent
// and never reaches the reducer.
export const STREAM_END = "__umbrella_end";

export interface SseClientOptions {
  runId: string;
  store: RunStore;
  /** Called whenever connection status changes. NOT a React setter — use a ref or an external store. */
  onStatusChange?: (status: ConnectionStatus) => void;
  /** Override base URL for tests. Defaults to empty string (relative). */
  baseUrl?: string;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const JITTER_FACTOR = 0.25;

function backoffMs(attempt: number): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = base * JITTER_FACTOR * Math.random();
  return base + jitter;
}

export interface SseClient {
  /** Clean up: close the EventSource and cancel any pending reconnect. */
  destroy(): void;
}

export function createSseClient(opts: SseClientOptions): SseClient {
  const { runId, store, onStatusChange, baseUrl = "" } = opts;
  const url = `${baseUrl}/api/runs/${encodeURIComponent(runId)}/stream`;

  let es: EventSource | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let ended = false; // set when the stream signals terminal completion — no reconnect

  function notify(status: ConnectionStatus) {
    // ponytail: wire status into RunState.ui.connection when the contract adds it.
    onStatusChange?.(status);
  }

  function connect() {
    if (destroyed) return;
    notify(attempt === 0 ? "connecting" : "reconnecting");

    es = new EventSource(url);

    es.onopen = () => {
      attempt = 0;
      notify("open");
    };

    es.onmessage = (ev: MessageEvent) => {
      let parsed: SSEEvent;
      try {
        parsed = JSON.parse(ev.data as string) as SSEEvent;
      } catch {
        // malformed frame — skip; forward-compat: unknown `type` is handled by
        // the reducer (drops unknown events per ADR 0001 §2.3).
        return;
      }
      // Terminal control frame: stream complete. Close without reconnecting (and
      // never apply it to the store — it is not a domain event).
      if ((parsed as { type?: string }).type === STREAM_END) {
        ended = true;
        es?.close();
        es = null;
        notify("closed");
        return;
      }
      // The ONLY action here is buffering. No React notify. No subscriber call.
      // Lane B's rAF loop calls store.flush() once per frame — that is the sole
      // notification path into React and r3f.
      store.apply(parsed);
      // `hello` flows through apply → reducer, which replaces state wholesale.
      // No special-casing needed here: the contract says apply() is always buffered.
    };

    es.onerror = () => {
      es?.close();
      es = null;
      if (destroyed || ended) return; // terminal completion is not a reconnectable error
      notify("reconnecting");
      const delay = backoffMs(attempt);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    destroy() {
      destroyed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      es?.close();
      es = null;
      notify("closed");
    },
  };
}
