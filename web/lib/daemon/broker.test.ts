// web/lib/daemon/broker.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { publish, subscribe, isDone, onDone, complete, _resetBroker } from "./broker";
import type { SSEEvent } from "@/lib/contract/events";

const ev = (phase: 1): SSEEvent => ({ type: "phase", phase, status: "active" });

beforeEach(() => _resetBroker());

describe("broker fan-out", () => {
  it("delivers published events to all subscribers", () => {
    const a: SSEEvent[] = [];
    const b: SSEEvent[] = [];
    subscribe("r1", (e) => a.push(e));
    subscribe("r1", (e) => b.push(e));

    publish("r1", ev(1));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it("unsubscribe stops further delivery", () => {
    const got: SSEEvent[] = [];
    const unsub = subscribe("r2", (e) => got.push(e));
    publish("r2", ev(1));
    unsub();
    publish("r2", ev(1));
    expect(got).toHaveLength(1);
  });

  it("isolates runs by id", () => {
    const got: SSEEvent[] = [];
    subscribe("r3", (e) => got.push(e));
    publish("other", ev(1));
    expect(got).toHaveLength(0);
  });

  it("complete sets done and fires onDone listeners once", () => {
    let fired = 0;
    onDone("r4", () => fired++);
    expect(isDone("r4")).toBe(false);
    complete("r4");
    expect(isDone("r4")).toBe(true);
    expect(fired).toBe(1);
  });

  it("onDone fires immediately when the run is already done", () => {
    complete("r5");
    let fired = 0;
    onDone("r5", () => fired++);
    expect(fired).toBe(1);
  });
});
