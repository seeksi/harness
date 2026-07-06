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

/** The oldest seq still retained in the ring (the replay floor); 0 when empty. */
export function oldestSeq(): number {
  return ring.length > 0 ? ring[0].seq : 0;
}

/**
 * True when a reconnect at `cursor` can NOT be replayed gaplessly: the next event the
 * client expects (cursor+1) has already been evicted from the ring (cursor+1 < floor).
 * cursor 0 (fresh connect) is never a gap. floor 0 (empty ring) is never a gap.
 */
export function hasGap(cursor: number, floor = oldestSeq()): boolean {
  return cursor > 0 && floor > 0 && cursor + 1 < floor;
}

/**
 * Attach a live consumer with a GAPLESS, atomic replay (threat model — SSE gapless
 * contract). Ordering is the whole point:
 *   1. subscribe FIRST, buffering live events (so an event published mid-replay is never
 *      lost in the window between "compute replay" and "subscribe");
 *   2. if the client's cursor is older than the ring floor, invoke onGap() (the caller
 *      re-seeds a fresh snapshot) and replay the WHOLE retained ring — never a silent gap;
 *   3. replay the retained tail, then flush the buffered live events, all deduped by seq
 *      so the mid-replay overlap yields no duplicate frame.
 * Returns the unsubscribe fn.
 */
export function attachReplay(
  cursor: number,
  emit: (item: SeqEnvelope) => void,
  opts: { onGap?: () => void } = {}
): () => void {
  const seen = new Set<number>();
  const send = (item: SeqEnvelope) => {
    if (seen.has(item.seq)) return; // dedupe the replay/live overlap
    seen.add(item.seq);
    emit(item);
  };

  // 1. Subscribe first; buffer until the replay has drained.
  let buffering = true;
  const buffered: SeqEnvelope[] = [];
  const unsub = subscribe((item) => {
    if (buffering) buffered.push(item);
    else send(item);
  });

  // 2. Gap detection + re-seed hook.
  const floor = oldestSeq();
  const gap = hasGap(cursor, floor);
  if (gap) opts.onGap?.();
  const replayFrom = gap ? floor - 1 : cursor; // gap → replay the whole retained ring

  // 3. Replay retained tail, then flush the mid-replay buffer in seq order (deduped).
  for (const item of since(replayFrom)) send(item);
  buffering = false;
  buffered.sort((a, b) => a.seq - b.seq);
  for (const item of buffered) send(item);
  buffered.length = 0;

  return unsub;
}

/** Test-only: drop the ring + listeners + seq counter. */
export function _resetBroker(): void {
  seq = 0;
  ring.length = 0;
  listeners.clear();
}
