// SSE client tests.
// Verifies: apply() called per message, no React setState/subscriber calls,
// reconnect triggers a second hello that replaces state (via the test-double flush).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeTestStore } from "./testStore";
import { createSseClient } from "../client";
import { dryRun } from "@/lib/contract/fixture";
import { initialRunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";

// ── EventSource mock ──────────────────────────────────────────────────────────

type ESListener = (ev: { data: string }) => void;
type ErrorListener = () => void;

interface FakeES {
  url: string;
  onopen: (() => void) | null;
  onmessage: ESListener | null;
  onerror: ErrorListener | null;
  close: () => void;
  // test helpers
  _emit(event: SSEEvent): void;
  _error(): void;
}

let instances: FakeES[] = [];

function makeFakeEventSource(url: string): FakeES {
  const es: FakeES = {
    url,
    onopen: null,
    onmessage: null,
    onerror: null,
    close: vi.fn(),
    _emit(event: SSEEvent) {
      this.onmessage?.({ data: JSON.stringify(event) });
    },
    _error() {
      this.onerror?.();
    },
  };
  instances.push(es);
  return es;
}

beforeEach(() => {
  instances = [];
  vi.stubGlobal("EventSource", makeFakeEventSource);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SSE client — apply() called, no React notify", () => {
  it("calls store.apply() for each received event and NEVER calls store.subscribe/notify directly", () => {
    const store = makeTestStore();
    // Spy on subscribe to ensure client never calls it.
    const subscribeSpy = vi.spyOn(store, "subscribe");

    const client = createSseClient({ runId: "test-run", store, baseUrl: "" });
    const es = instances[0];
    expect(es).toBeDefined();

    const helloEvent = dryRun[0]; // { type: "hello", run: ... }
    es._emit(helloEvent);

    expect(store._applied).toHaveLength(1);
    expect(store._applied[0]).toEqual(helloEvent);
    // subscribe must never have been called by the client.
    expect(subscribeSpy).not.toHaveBeenCalled();
    // notifyCount must be 0 — only flush() increments it.
    expect(store._notifyCount).toBe(0);

    client.destroy();
  });

  it("calls store.apply() for every SSE message, including non-hello events", () => {
    const store = makeTestStore();
    const client = createSseClient({ runId: "r2", store, baseUrl: "" });
    const es = instances[0];

    // Send the first 5 events from the dry run
    for (const ev of dryRun.slice(0, 5)) {
      es._emit(ev);
    }

    expect(store._applied).toHaveLength(5);
    // Still no subscriber notification — flush() hasn't been called.
    expect(store._notifyCount).toBe(0);

    client.destroy();
  });

  it("does not call flush() — that is the rAF loop's job", () => {
    const store = makeTestStore();
    const flushSpy = vi.spyOn(store, "flush");
    const client = createSseClient({ runId: "r3", store, baseUrl: "" });
    const es = instances[0];

    es._emit(dryRun[0]);

    expect(flushSpy).not.toHaveBeenCalled();
    client.destroy();
  });
});

describe("SSE client — reconnect + hello resync", () => {
  it("opens a second EventSource after error and applies a second hello wholesale", () => {
    const store = makeTestStore();

    // First hello with a non-empty task
    const hello1: SSEEvent = {
      type: "hello",
      run: {
        ...initialRunState,
        task: { id: "run-1", brief: "First run", phase: 1, state: "running" },
      },
    };
    // Second hello (post-reconnect) resets to a different snapshot
    const hello2: SSEEvent = {
      type: "hello",
      run: {
        ...initialRunState,
        task: { id: "run-2", brief: "Reconnected run", phase: 1, state: "running" },
      },
    };

    const client = createSseClient({ runId: "r4", store, baseUrl: "" });
    const es1 = instances[0];

    // Emit hello1, then simulate disconnect
    es1._emit(hello1);
    store.flush(); // flush to commit hello1
    expect(store._state.task.id).toBe("run-1");

    // Simulate connection error → triggers reconnect after delay
    es1._error();
    // Advance timer past backoff
    vi.advanceTimersByTime(2000);

    // A second EventSource should have been created
    expect(instances.length).toBe(2);
    const es2 = instances[1];

    // Reconnect: server sends hello2 (wholesale replace)
    es2._emit(hello2);
    store.flush(); // flush to commit hello2
    expect(store._state.task.id).toBe("run-2");

    // Stale pre-disconnect gates should be gone (hello replaces, not merges)
    expect(store._state.gates).toHaveLength(0);

    client.destroy();
  });

  it("status callback is called on connect, reconnect, and close", () => {
    const statuses: string[] = [];
    const client = createSseClient({
      runId: "r5",
      store: makeTestStore(),
      baseUrl: "",
      onStatusChange: (s) => statuses.push(s),
    });
    expect(statuses).toContain("connecting");

    const es = instances[0];
    es.onopen?.();
    expect(statuses).toContain("open");

    es._error();
    expect(statuses).toContain("reconnecting");

    client.destroy();
    expect(statuses).toContain("closed");
  });
});

describe("SSE client — malformed frame handling", () => {
  it("ignores non-JSON frames without crashing", () => {
    const store = makeTestStore();
    const client = createSseClient({ runId: "r6", store, baseUrl: "" });
    const es = instances[0];

    // Manually fire a bad message
    es.onmessage?.({ data: "not json {{" });
    expect(store._applied).toHaveLength(0);

    client.destroy();
  });
});
