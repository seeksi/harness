// web/app/api/runs/route.test.ts
// Integration tests for POST/GET /api/runs.
// Tests the handler functions directly (no HTTP server needed).

import { describe, it, expect, beforeEach, vi } from "vitest";

// Use in-memory DB.
process.env.HARNESS_DB_PATH = ":memory:";

// Mock the daemon so tests don't actually iterate the 50ms dry-run.
vi.mock("@/lib/daemon/daemon", () => {
  let slotHeld = false;
  async function* fakeEvents() {
    yield { type: "phase" as const, phase: 1 as const, status: "active" as const };
  }
  return {
    SlotTakenError: class SlotTakenError extends Error {
      constructor(msg: string) { super(msg); this.name = "SlotTakenError"; }
    },
    startRun: vi.fn(async (runId: string) => {
      if (slotHeld) {
        const { SlotTakenError } = await import("@/lib/daemon/daemon");
        throw new SlotTakenError("slot occupied");
      }
      slotHeld = true;
      return { runId, events: fakeEvents() };
    }),
    _resetSlot: () => { slotHeld = false; },
  };
});

// Mock persist so no disk I/O.
vi.mock("@/lib/store/persist", () => {
  let snapshots: Record<string, unknown> = {};
  let slot: string | null = null;
  return {
    acquireSlot: vi.fn((id: string) => { if (slot) return false; slot = id; return true; }),
    releaseSlot: vi.fn((id: string) => { if (slot === id) slot = null; }),
    currentSlot: vi.fn(() => slot),
    getSnapshot: vi.fn((id: string) => snapshots[id] ?? null),
    upsertSnapshot: vi.fn((id: string, s: unknown) => { snapshots[id] = s; }),
    appendEvent: vi.fn(),
    finalizeRun: vi.fn(),
    _reset: () => { snapshots = {}; slot = null; },
  };
});

function makeReq(method: string, body?: unknown): Request {
  return new Request("http://localhost:3000/api/runs", {
    method,
    headers: {
      "content-type": "application/json",
      "x-umbrella-request": "1",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/runs", () => {
  beforeEach(async () => {
    const daemon = await import("@/lib/daemon/daemon") as { _resetSlot?: () => void };
    daemon._resetSlot?.();
    const persist = await import("@/lib/store/persist") as { _reset?: () => void };
    persist._reset?.();
  });

  it("returns 201 with a run id on success", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", { brief: "test task" }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string };
    expect(typeof body.id).toBe("string");
    expect(body.id.length).toBeGreaterThan(0);
    // No credentials in body.
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret|password/i);
  });

  it("rejects missing brief with 422", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", {}) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(422);
  });

  it("rejects unknown fields with 422", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("POST", { brief: "ok", extra: "bad" }) as Parameters<typeof POST>[0]);
    expect(res.status).toBe(422);
  });

  it("rejects non-JSON with 400", async () => {
    const { POST } = await import("./route");
    const req = new Request("http://localhost:3000/api/runs", {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-umbrella-request": "1",
        origin: "http://localhost:3000",
        host: "localhost:3000",
      },
      body: "not json",
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(400);
  });

  it("rejects without CSRF header with 403", async () => {
    const { POST } = await import("./route");
    const req = new Request("http://localhost:3000/api/runs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        host: "localhost:3000",
      },
      body: JSON.stringify({ brief: "test" }),
    });
    const res = await POST(req as Parameters<typeof POST>[0]);
    expect(res.status).toBe(403);
  });
});
