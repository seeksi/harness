// SSE resume semantics: a connection with no cursor must receive frame id 0; a
// connection resuming from cursor N must start at N+1 (gapless, no duplicate). Covers
// the pure helpers, the live route handler, and the client's reconnect-cursor seam.
import { describe, it, expect } from "vitest";
import { resumeStartIndex, withLastEventId } from "./resume";
import { GET } from "@/app/api/fleet/stream/route";

// Read the first `count` frame ids off an SSE response, then cancel (the stream paces
// frames ~220ms apart, so we never drain the whole fixture).
async function collectFrameIds(res: Response, count: number): Promise<number[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ids: number[] = [];
  try {
    while (ids.length < count) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      ids = [...buf.matchAll(/id: (\d+)\n/g)].map((m) => Number(m[1]));
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return ids.slice(0, count);
}

describe("resumeStartIndex", () => {
  it("no cursor (null/undefined/empty) starts at frame 0", () => {
    expect(resumeStartIndex(null)).toBe(0);
    expect(resumeStartIndex(undefined)).toBe(0);
    expect(resumeStartIndex("")).toBe(0);
  });

  it("a valid non-negative integer cursor N resumes at N+1", () => {
    expect(resumeStartIndex("0")).toBe(1);
    expect(resumeStartIndex("3")).toBe(4);
    expect(resumeStartIndex("41")).toBe(42);
  });

  it("malformed / negative / fractional cursors fall back to 0 (never drop frame 0)", () => {
    expect(resumeStartIndex("abc")).toBe(0);
    expect(resumeStartIndex("-1")).toBe(0);
    expect(resumeStartIndex("3.5")).toBe(0);
    expect(resumeStartIndex(" ")).toBe(0);
  });
});

describe("withLastEventId", () => {
  it("no id leaves the url untouched", () => {
    expect(withLastEventId("/api/fleet/stream", null)).toBe("/api/fleet/stream");
    expect(withLastEventId("/api/fleet/stream", "")).toBe("/api/fleet/stream");
  });
  it("appends lastEventId, respecting an existing query string", () => {
    expect(withLastEventId("/api/fleet/stream", "3")).toBe("/api/fleet/stream?lastEventId=3");
    expect(withLastEventId("/api/fleet/stream?x=1", "3")).toBe("/api/fleet/stream?x=1&lastEventId=3");
  });
});

describe("GET /api/fleet/stream resume", () => {
  it("a request with no Last-Event-ID/cursor receives frame id 0 first", async () => {
    const res = await GET(new Request("http://localhost/api/fleet/stream"));
    expect(await collectFrameIds(res, 3)).toEqual([0, 1, 2]);
  });

  it("resumes at N+1 exactly once from a Last-Event-ID header (no dup, no gap)", async () => {
    const res = await GET(
      new Request("http://localhost/api/fleet/stream", { headers: { "Last-Event-ID": "3" } })
    );
    expect(await collectFrameIds(res, 3)).toEqual([4, 5, 6]);
  });

  it("accepts the client reconnect cursor via ?lastEventId= query param", async () => {
    const res = await GET(new Request("http://localhost/api/fleet/stream?lastEventId=3"));
    expect(await collectFrameIds(res, 3)).toEqual([4, 5, 6]);
  });
});

describe("client reconnect does not duplicate events", () => {
  it("resumes at N+1 using the id the client tracked — no replay of 0..N", async () => {
    // First connection: fresh, receives frames 0,1,2. Client records the last id it saw.
    const first = await GET(new Request("http://localhost/api/fleet/stream"));
    const seen = await collectFrameIds(first, 3);
    expect(seen).toEqual([0, 1, 2]);
    const lastEventId = String(seen[seen.length - 1]); // 2

    // Reconnect: client builds the resume URL from the id it tracked (not the browser's,
    // which recreating the EventSource would have discarded).
    const reconnectUrl = withLastEventId("http://localhost/api/fleet/stream", lastEventId);
    const second = await GET(new Request(reconnectUrl));
    const resumed = await collectFrameIds(second, 3);

    expect(resumed[0]).toBe(3); // resumes at N+1
    expect(resumed).toEqual([3, 4, 5]); // no duplicate of 0..2, no gap
  });
});
