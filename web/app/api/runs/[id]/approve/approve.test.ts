// web/app/api/runs/[id]/approve/approve.test.ts
// Tests: approve mismatched kind → 422; unknown run → 404; no credential in response.

import { describe, it, expect, vi } from "vitest";

process.env.HARNESS_DB_PATH = ":memory:";

// Snapshot fixture: run is in phase 1.
const phase1Snapshot = {
  task: { id: "run-1", brief: "test", phase: 1, state: "running" },
  subtasks: [],
  phases: [
    { id: 1, label: "decompose", status: "active" },
    { id: 2, label: "build", status: "idle" },
    { id: 3, label: "route-cost", status: "idle" },
    { id: 4, label: "cross-review", status: "idle" },
    { id: 5, label: "merge", status: "idle" },
    { id: 6, label: "eval+promote", status: "idle" },
  ],
  gates: [],
  agentEvents: [],
  trace: [],
  budget: { ceilingUsd: 0, estimatedUsd: 0 },
  ui: { openDetail: { kind: null, id: null } },
};

vi.mock("@/lib/store/persist", () => ({
  getSnapshot: vi.fn((id: string) => {
    if (id === "run-1") return phase1Snapshot;
    return null;
  }),
}));

function makeReq(runId: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/runs/${runId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-umbrella-request": "1",
      origin: "http://localhost:3000",
      host: "localhost:3000",
    },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/runs/[id]/approve", () => {
  it("404 for unknown run", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("ghost-run", { kind: "decompose-split" }) as Parameters<typeof POST>[0], makeParams("ghost-run"));
    expect(res.status).toBe(404);
  });

  it("422 when kind mismatches current phase (promote-to-main while in phase 1)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("run-1", { kind: "promote-to-main" }) as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(422);
  });

  it("200 when kind matches phase (decompose-split in phase 1)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("run-1", { kind: "decompose-split" }) as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    // No credentials.
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret|password/i);
  });

  it("422 for invalid kind", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("run-1", { kind: "destroy-everything" }) as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(422);
  });

  it("403 without CSRF header", async () => {
    const { POST } = await import("./route");
    const req = new Request("http://localhost:3000/api/runs/run-1/approve", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000" },
      body: JSON.stringify({ kind: "decompose-split" }),
    });
    const res = await POST(req as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(403);
  });
});
