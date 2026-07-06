// console/lib/sse/client.ts
// Opens an EventSource to the fleet stream, parses each frame to an Envelope, and
// calls store.apply() (buffer only — the rAF flush is the sole notifier). Reconnect
// is exponential back-off with jitter, capped at 30s. On drop we FREEZE last-known
// state (never blank) and signal "reconnecting"; on reconnect the server sends fresh
// `sync` frames so state resyncs with no gap (EventSource resumes via Last-Event-ID).

import type { Envelope } from "@/lib/contract/events";
import type { FleetStore } from "@/lib/store/fleetStore";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

// Terminal control frame — a finite stream ends by sending this instead of a bare
// close (which EventSource treats as an error and would auto-reconnect forever).
export const STREAM_END = "__console_end";

export interface SseClientOptions {
  url: string;
  store: FleetStore;
  onStatusChange?: (s: ConnectionStatus) => void;
  onEventTime?: (tsMs: number) => void; // wall-clock of last received frame (stale badge)
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function backoffMs(attempt: number): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base + base * 0.25 * Math.random();
}

export interface SseClient {
  destroy(): void;
}

export function createSseClient(opts: SseClientOptions): SseClient {
  const { url, store, onStatusChange, onEventTime } = opts;
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  let ended = false;

  const notify = (s: ConnectionStatus) => onStatusChange?.(s);

  function connect() {
    if (destroyed) return;
    notify(attempt === 0 ? "connecting" : "reconnecting");
    es = new EventSource(url);

    es.onopen = () => {
      attempt = 0;
      notify("open");
    };

    es.onmessage = (ev: MessageEvent) => {
      onEventTime?.(Date.now());
      let parsed: Envelope | { type?: string };
      try {
        parsed = JSON.parse(ev.data as string);
      } catch {
        return; // malformed frame — skip
      }
      if ((parsed as { type?: string }).type === STREAM_END) {
        ended = true;
        es?.close();
        es = null;
        notify("closed");
        return;
      }
      store.apply(parsed as Envelope);
    };

    es.onerror = () => {
      es?.close();
      es = null;
      if (destroyed || ended) return;
      notify("reconnecting");
      const delay = backoffMs(attempt);
      attempt += 1;
      timer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      es = null;
      notify("closed");
    },
  };
}
