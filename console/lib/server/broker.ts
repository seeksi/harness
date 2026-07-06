// console/lib/server/broker.ts
// In-process fleet event broker. The live daemon is the SINGLE producer; consumers are
// persistence (inside the daemon ingest) and any number of fleet SSE stream clients.
// One fleet-wide channel (the console shows all runs on one stream), unlike web's
// per-run broker. Each published envelope gets a monotonic `seq`; a bounded ring buffer
// lets a late joiner / reconnect replay from a cursor (?lastEventId=seq) gaplessly.
//
// Single Node server, single operator → module-level state is the right scope.

import type { Envelope } from "@/lib/contract/events";

export interface SeqEnvelope {
  seq: number;
  env: Envelope;
}

type Listener = (item: SeqEnvelope) => void;

const RING_CAP = Number(process.env.HARNESS_BROKER_RING) || 2000;

let seq = 0;
const ring: SeqEnvelope[] = [];
const listeners = new Set<Listener>();

/** Producer: assign a seq, buffer, and fan out to all current subscribers. */
export function publish(env: Envelope): SeqEnvelope {
  const item: SeqEnvelope = { seq: ++seq, env };
  ring.push(item);
  if (ring.length > RING_CAP) ring.shift();
  for (const l of listeners) l(item);
  return item;
}

/** Consumer: receive future envelopes. Returns an unsubscribe fn. */
export function subscribe(onEvent: Listener): () => void {
  listeners.add(onEvent);
  return () => {
    listeners.delete(onEvent);
  };
}

/** Buffered envelopes with seq > afterSeq (reconnect replay). */
export function since(afterSeq: number): SeqEnvelope[] {
  return ring.filter((i) => i.seq > afterSeq);
}

/** The highest seq published so far. */
export function currentSeq(): number {
  return seq;
}

/** Test-only: drop the ring + listeners + seq counter. */
export function _resetBroker(): void {
  seq = 0;
  ring.length = 0;
  listeners.clear();
}
