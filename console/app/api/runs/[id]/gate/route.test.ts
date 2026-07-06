import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST } from "./route";
import { resetDb, upsertRun } from "@/lib/server/persist";
import { _resetBroker } from "@/lib/server/broker";
import { newRun } from "@/lib/contract/types";

// A CSRF-valid same-origin POST (matches lib/server/csrf.ts).
function gateReq(body: unknown) {
  return new Request("http://localhost:3000/api/runs/r1/gate", {
    method: "POST",
    headers: {
      "x-harness-request": "1",
      "sec-fetch-site": "same-origin",
      origin: "http://localhost:3000",
      host: "localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }) as never;
}
const params = Promise.resolve({ id: "r1" });

const OLD = { live: process.env.HARNESS_LIVE, promote: process.env.ENABLE_PROMOTE_TO_MAIN };
beforeEach(() => {
  resetDb(":memory:");
  _resetBroker();
});
afterEach(() => {
  if (OLD.live === undefined) delete process.env.HARNESS_LIVE;
  else process.env.HARNESS_LIVE = OLD.live;
  if (OLD.promote === undefined) delete process.env.ENABLE_PROMOTE_TO_MAIN;
  else process.env.ENABLE_PROMOTE_TO_MAIN = OLD.promote;
});

describe("gate route gating (finding 5)", () => {
  it("503 when HARNESS_LIVE is unset — fixture mode stays read-only", async () => {
    delete process.env.HARNESS_LIVE;
    const res = await POST(gateReq({ gateId: "A", status: "approved" }), { params });
    expect(res.status).toBe(503);
  });

  it("403 on a Gate D approval unless ENABLE_PROMOTE_TO_MAIN=1 (double-gate invariant)", async () => {
    process.env.HARNESS_LIVE = "1";
    delete process.env.ENABLE_PROMOTE_TO_MAIN;
    upsertRun(newRun("r1", "p1", "P1", "b", 100));
    const res = await POST(gateReq({ gateId: "D", status: "approved" }), { params });
    expect(res.status).toBe(403);
  });

  it("allows a Gate D approval when ENABLE_PROMOTE_TO_MAIN=1", async () => {
    process.env.HARNESS_LIVE = "1";
    process.env.ENABLE_PROMOTE_TO_MAIN = "1";
    upsertRun(newRun("r1", "p1", "P1", "b", 100));
    const res = await POST(gateReq({ gateId: "D", status: "approved" }), { params });
    expect(res.status).toBe(200);
  });

  it("non-promote gate (D reject / A approve) is unaffected by the promote flag", async () => {
    process.env.HARNESS_LIVE = "1";
    delete process.env.ENABLE_PROMOTE_TO_MAIN;
    upsertRun(newRun("r1", "p1", "P1", "b", 100));
    expect((await POST(gateReq({ gateId: "D", status: "rejected" }), { params })).status).toBe(200);
    expect((await POST(gateReq({ gateId: "A", status: "approved" }), { params })).status).toBe(200);
  });
});
