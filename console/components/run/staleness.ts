// console/components/run/staleness.ts
// Pure stale-banner state machine for run focus (§5 freeze+badge), decoupled from
// React so the "open feed, silent run" transition is testable with fake timers and
// no DOM. Two independent staleness sources:
//
//   - feed: the SSE connection dropped and is retrying (status === "reconnecting").
//     A clean "closed" — STREAM_END or unmount — is a terminal, non-stale state:
//     the stream ended on purpose, it did not go silent. Same semantics as
//     FleetHome's ConnectionPill (reconnecting is the only feed-stale status).
//   - run: the run's OWN event stream went quiet past STALENESS_WINDOW_SEC while
//     still "running". Nothing will ever arrive to trigger a re-render for this
//     case on its own, so the caller must re-evaluate on a live clock tick.

import type { RunState } from "@/lib/contract/types";
import { STALENESS_WINDOW_SEC } from "@/lib/contract/types";
import { silenceSeconds } from "@/lib/contract/health";
import type { ConnectionStatus } from "@/lib/sse/client";

export type StaleReason = "reconnecting" | "no-events" | null;

export interface StaleBanner {
  stale: boolean;
  feedStale: boolean;
  reason: StaleReason;
}

// Only "reconnecting" freezes the feed. "closed" (clean STREAM_END or unmount) and
// "connecting"/"open" are never stale.
export function feedIsStale(status: ConnectionStatus): boolean {
  return status === "reconnecting";
}

export function computeStaleBanner(run: RunState, nowSec: number, status: ConnectionStatus): StaleBanner {
  const feedStale = feedIsStale(status);
  const runSilent = run.status === "running" && silenceSeconds(run, nowSec) > STALENESS_WINDOW_SEC;
  const reason: StaleReason = feedStale ? "reconnecting" : runSilent ? "no-events" : null;
  return { stale: feedStale || runSilent, feedStale, reason };
}

// Schedules a 1s clock tick so an open-but-silent run still crosses the staleness
// threshold and re-renders — no new SSE frame will ever arrive to trigger it.
// Returns the unsubscribe/cleanup function.
export function scheduleStaleTick(cb: () => void): () => void {
  const id = setInterval(cb, 1000);
  return () => clearInterval(id);
}
