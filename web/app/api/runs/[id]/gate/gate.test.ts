// web/app/api/runs/[id]/gate/gate.test.ts
// Tests: unknown gateId → 422; unknown run → 404.

import { describe, it, expect, vi } from "vitest";

process.env.HARNESS_DB_PATH = ":memory:";

const minSnapshot = {
  task: { id: "run-1", brief: "test", phase: 1, state: "running" },
  subtasks: [], phases: [], gates: [], agentEvents: [], trace: [],
  budget: { ceilingUsd: 0, estimatedUsd: 0 },
  ui: { openDetail: { kind: null, id: null } },
};

vi.mock("@/lib/store/persist", () => ({
  getSnapshot: vi.fn((id: string) => (id === "run-1" ? minSnapshot : null)),
}));

function makeReq(runId: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/runs/${runId}/gate`, {
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

describe("POST /api/runs/[id]/gate", () => {
  it("404 for unknown run", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("ghost", { gateId: "A", status: "resolved" }) as Parameters<typeof POST>[0], makeParams("ghost"));
    expect(res.status).toBe(404);
  });

  it("422 for unknown gateId (E is not valid)", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("run-1", { gateId: "E", status: "resolved" }) as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(422);
  });

  it("422 for invalid status", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("run-1", { gateId: "A", status: "exploded" }) as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(422);
  });

  it("200 for valid gateId and status", async () => {
    const { POST } = await import("./route");
    const res = await POST(makeReq("run-1", { gateId: "D", status: "resolved" }) as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
    // No credentials.
    expect(JSON.stringify(body)).not.toMatch(/key|token|secret|password/i);
  });

  it("403 without CSRF header", async () => {
    const { POST } = await import("./route");
    const req = new Request("http://localhost:3000/api/runs/run-1/gate", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000" },
      body: JSON.stringify({ gateId: "A", status: "resolved" }),
    });
    const res = await POST(req as Parameters<typeof POST>[0], makeParams("run-1"));
    expect(res.status).toBe(403);
  });
});
