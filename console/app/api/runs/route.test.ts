import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST } from "./route";
import { startRun } from "@/lib/server/daemon";

vi.mock("@/lib/server/daemon", () => {
  class SlotTakenError extends Error {}
  return { startRun: vi.fn(), currentSlot: vi.fn(() => null), SlotTakenError };
});
vi.mock("@/lib/server/discovery", () => ({
  discoverProjects: () => [{ id: "proj-1", name: "Proj" }],
}));

// A CSRF-valid same-origin POST (matches lib/server/csrf.ts).
function runsReq(body: unknown) {
  return new Request("http://localhost:3000/api/runs", {
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

const OLD_LIVE = process.env.HARNESS_LIVE;
beforeEach(() => {
  process.env.HARNESS_LIVE = "1";
  vi.mocked(startRun).mockClear();
});
afterEach(() => {
  if (OLD_LIVE === undefined) delete process.env.HARNESS_LIVE;
  else process.env.HARNESS_LIVE = OLD_LIVE;
});

const base = { projectId: "proj-1", brief: "do the thing" };

describe("POST /api/runs — lanes[] validation", () => {
  it("accepts 1..4 lane briefs, trims them, and passes laneBriefs to startRun", async () => {
    const res = await POST(runsReq({ ...base, lanes: ["  lane one  ", "lane two"] }));
    expect(res.status).toBe(201);
    expect(vi.mocked(startRun)).toHaveBeenCalledWith(
      expect.objectContaining({ laneBriefs: ["lane one", "lane two"] })
    );
  });

  it("caps the TRIMMED length: padding whitespace never triggers the oversize rejection", async () => {
    const padded = " ".repeat(4000) + "real task" + " ".repeat(4000); // raw >4000, trimmed well under
    const res = await POST(runsReq({ ...base, lanes: [padded] }));
    expect(res.status).toBe(201);
    expect(vi.mocked(startRun)).toHaveBeenCalledWith(expect.objectContaining({ laneBriefs: ["real task"] }));
  });

  it("absent lanes ⇒ laneBriefs undefined (single lane from brief)", async () => {
    const res = await POST(runsReq(base));
    expect(res.status).toBe(201);
    expect(vi.mocked(startRun)).toHaveBeenCalledWith(expect.objectContaining({ laneBriefs: undefined }));
  });

  it.each([
    ["not an array", { lanes: "one" }],
    ["empty array", { lanes: [] }],
    ["more than 4", { lanes: ["a", "b", "c", "d", "e"] }],
    ["non-string entry", { lanes: ["a", 7] }],
    ["blank entry", { lanes: ["a", "   "] }],
    ["oversized entry", { lanes: ["a", "x".repeat(4001)] }],
  ])("rejects lanes: %s with 422 and never starts the run", async (_name, extra) => {
    const res = await POST(runsReq({ ...base, ...extra }));
    expect(res.status).toBe(422);
    expect(vi.mocked(startRun)).not.toHaveBeenCalled();
  });
});

describe("POST /api/runs — decompose validation", () => {
  it("accepts decompose:true and passes it through to startRun", async () => {
    const res = await POST(runsReq({ ...base, decompose: true }));
    expect(res.status).toBe(201);
    expect(vi.mocked(startRun)).toHaveBeenCalledWith(expect.objectContaining({ decompose: true }));
  });

  it("absent decompose ⇒ startRun gets decompose:false", async () => {
    const res = await POST(runsReq(base));
    expect(res.status).toBe(201);
    expect(vi.mocked(startRun)).toHaveBeenCalledWith(expect.objectContaining({ decompose: false }));
  });

  it("rejects a non-boolean decompose with 422 and never starts the run", async () => {
    const res = await POST(runsReq({ ...base, decompose: "yes" }));
    expect(res.status).toBe(422);
    expect(vi.mocked(startRun)).not.toHaveBeenCalled();
  });

  it("rejects decompose:true + lanes together (mutually exclusive) with 422 and never starts the run", async () => {
    const res = await POST(runsReq({ ...base, decompose: true, lanes: ["a"] }));
    expect(res.status).toBe(422);
    expect(vi.mocked(startRun)).not.toHaveBeenCalled();
  });
});
