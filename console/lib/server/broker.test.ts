import { describe, it, expect, beforeEach } from "vitest";
import { publish, attachReplay, oldestSeq, hasGap, _resetBroker } from "./broker";
import type { Envelope } from "@/lib/contract/events";

const ev = (n: number): Envelope => ({
  runId: "r1",
  projectId: "p1",
  agentId: "a",
  ts: n,
  type: "trace",
  payload: { tool: "T", sig: String(n) },
});

beforeEach(() => _resetBroker());

describe("attachReplay — gapless atomic subscribe-first replay (SSE contract 4a)", () => {
  it("delivers an event published DURING replay — no lost frame in the replay↔live window", () => {
    publish(ev(1));
    publish(ev(2)); // seq 1,2 in the ring
    const got: number[] = [];
    let raced = false;
    attachReplay(0, (item) => {
      got.push(item.seq);
      // Race: publish a live event on the first replayed frame. Because subscribe happened
      // FIRST it is buffered and flushed after replay — never dropped.
      if (!raced) {
        raced = true;
        publish(ev(3));
      }
    });
    expect(got).toEqual([1, 2, 3]); // 3 delivered exactly once, in order
  });

  it("dedupes so a mid-replay overlap yields no duplicate frame", () => {
    publish(ev(1));
    const got: number[] = [];
    attachReplay(0, (item) => got.push(item.seq));
    publish(ev(2)); // live after attach
    expect(got).toEqual([1, 2]);
  });
});

describe("oldestSeq / hasGap — ring-floor overflow detection (SSE contract 4b)", () => {
  it("reports the ring floor; a cursor inside the ring (or fresh) is no gap", () => {
    for (let i = 0; i < 10; i++) publish(ev(i));
    expect(oldestSeq()).toBe(1);
    expect(hasGap(3)).toBe(false);
    expect(hasGap(0)).toBe(false); // fresh connect
  });

  it("detects a gap when the cursor is older than the evicted floor, and re-seeds + replays the whole ring", () => {
    const RING = Number(process.env.HARNESS_BROKER_RING) || 2000;
    for (let i = 0; i < RING + 100; i++) publish(ev(i)); // overflow: first 100 evicted
    const floor = oldestSeq();
    expect(floor).toBe(101);
    expect(hasGap(5, floor)).toBe(true);

    let gapFired = 0;
    const got: number[] = [];
    attachReplay(5, (item) => got.push(item.seq), { onGap: () => (gapFired += 1) });

    expect(gapFired).toBe(1); // re-seed hook invoked (instead of a silent gap)
    expect(got[0]).toBe(floor); // whole retained ring replayed, from the floor
    expect(got.length).toBe(RING);
  });
});
