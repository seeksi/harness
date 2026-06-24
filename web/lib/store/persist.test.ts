// web/lib/store/persist.test.ts
// Unit tests for the SQLite persistence layer.

import { describe, it, expect, beforeEach } from "vitest";
import { initialRunState } from "@/lib/contract/types";
import {
  acquireSlot,
  releaseSlot,
  currentSlot,
  upsertSnapshot,
  getSnapshot,
  appendEvent,
  resetDb,
} from "./persist";

// Use in-memory DB for tests.
beforeEach(() => {
  // Close any existing DB and force a fresh :memory: connection.
  resetDb(":memory:");
});

describe("persist (SQLite in-memory)", () => {
  it("acquireSlot — returns true on first call", () => {
    expect(acquireSlot("run-1")).toBe(true);
  });

  it("acquireSlot — returns false if slot already taken", () => {
    acquireSlot("run-a");
    expect(acquireSlot("run-b")).toBe(false);
  });

  it("releaseSlot — frees the slot so another run can acquire", () => {
    acquireSlot("run-x");
    releaseSlot("run-x");
    expect(acquireSlot("run-y")).toBe(true);
  });

  it("currentSlot — returns the held run id or null", () => {
    expect(currentSlot()).toBeNull();
    acquireSlot("run-z");
    expect(currentSlot()).toBe("run-z");
  });

  it("upsertSnapshot + getSnapshot roundtrip", () => {
    const state = {
      ...initialRunState,
      task: { ...initialRunState.task, id: "run-r", brief: "hello world" },
    };
    acquireSlot("run-r");
    upsertSnapshot("run-r", state);
    const back = getSnapshot("run-r");
    expect(back?.task.brief).toBe("hello world");
  });

  it("getSnapshot — returns null for unknown run", () => {
    expect(getSnapshot("ghost")).toBeNull();
  });

  it("appendEvent — stores events without throwing", () => {
    acquireSlot("run-e");
    upsertSnapshot("run-e", initialRunState);
    const event = { type: "phase" as const, phase: 1 as const, status: "active" as const };
    expect(() => appendEvent("run-e", event)).not.toThrow();
  });
});
