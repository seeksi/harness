// web/lib/daemon/broker.ts
// Per-run in-process event broker. The daemon is the SINGLE producer; consumers
// are persistence (inside the daemon loop) and any number of SSE stream clients.
// This removes the previous double-driver where the stream route replayed the
// fixture independently of the daemon — now there is one event source, fanned out.
//
// Single Node server, single slot (one run at a time), so module-level state is
// the right scope. Completed channels keep a `done` flag so a client that connects
// after the run finished is told to stop (STREAM_END) instead of hanging.

import type { SSEEvent } from "@/lib/contract/events";

type Listener = (event: SSEEvent) => void;

interface RunChannel {
  listeners: Set<Listener>;
  doneListeners: Set<() => void>;
  done: boolean;
}

const channels = new Map<string, RunChannel>();

function channel(runId: string): RunChannel {
  let c = channels.get(runId);
  if (!c) {
    c = { listeners: new Set(), doneListeners: new Set(), done: false };
    channels.set(runId, c);
  }
  return c;
}

/** Producer: emit an event to all current subscribers of this run. */
export function publish(runId: string, event: SSEEvent): void {
  for (const listener of channel(runId).listeners) listener(event);
}

/** Consumer: receive future events for this run. Returns an unsubscribe fn. */
export function subscribe(runId: string, onEvent: Listener): () => void {
  const c = channel(runId);
  c.listeners.add(onEvent);
  return () => {
    c.listeners.delete(onEvent);
  };
}

/** True once the run has finished producing events. */
export function isDone(runId: string): boolean {
  return channels.get(runId)?.done ?? false;
}

/** Run a callback when the run completes (immediately if already done). */
export function onDone(runId: string, cb: () => void): () => void {
  const c = channel(runId);
  if (c.done) {
    cb();
    return () => {};
  }
  c.doneListeners.add(cb);
  return () => {
    c.doneListeners.delete(cb);
  };
}

/** Producer: mark the run finished and notify done-listeners. */
export function complete(runId: string): void {
  const c = channel(runId);
  c.done = true;
  for (const cb of c.doneListeners) cb();
  c.doneListeners.clear();
  c.listeners.clear();
  // ponytail: prune the channel after a grace period; add when runs are long-lived
  // or numerous. Single-operator/single-slot keeps the map tiny for now.
}

/** Test-only: drop all channels. */
export function _resetBroker(): void {
  channels.clear();
}
