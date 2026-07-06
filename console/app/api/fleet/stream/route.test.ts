import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "./route";
import { publish, _resetBroker } from "@/lib/server/broker";
import { resetDb, upsertRun } from "@/lib/server/persist";
import { newRun } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";

const ev = (runId: string, n: number): Envelope => ({
  runId,
  projectId: "p1",
  agentId: "a",
  ts: n,
  type: "trace",
  payload: { tool: "T", sig: String(n) },
});

// Parse the `data:` JSON payloads out of an SSE byte buffer (ignores `:` comments + `id:` lines).
function dataFrames(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    try {
      out.push(JSON.parse(line.slice("data: ".length)));
    } catch {
      /* partial/split frame at the read boundary — skip */
    }
  }
  return out;
}

beforeEach(() => {
  _resetBroker();
  resetDb(":memory:");
  process.env.HARNESS_LIVE = "1";
});
afterEach(() => {
  delete process.env.HARNESS_LIVE;
});

describe("fleet SSE stream — stale-cursor reseed (gapless contract, evicted run)", () => {
  it("re-seeds a run whose events were fully evicted from the ring, not just runs still in it", async () => {
    const RING = Number(process.env.HARNESS_BROKER_RING) || 2000;
    // Two known runs in persistence. `evicted-run`'s events will be pushed entirely out of the
    // in-memory ring; `active-run` stays in it. The OLD reseed (ring-only) would skip the former.
    upsertRun(newRun("evicted-run", "p1", "Proj", "brief", 100));
    upsertRun(newRun("active-run", "p1", "Proj", "brief", 200));
    for (let i = 0; i < 5; i++) publish(ev("evicted-run", i)); // seq 1..5
    for (let i = 0; i < RING; i++) publish(ev("active-run", i)); // overflow → seq 1..5 evicted

    // Cursor 1 is below the ring floor → gap → the reseed path fires.
    const ctrl = new AbortController();
    const req = new Request("http://localhost/api/fleet/stream?lastEventId=1", { signal: ctrl.signal });
    const res = await GET(req);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (let i = 0; i < 500; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes("evicted-run")) break; // stop once we have what we're asserting on
      }
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    }

    const syncs = dataFrames(buf).filter(
      (f) => f.type === "sync" && (f.payload as { run?: { runId?: string } })?.run?.runId
    );
    const runIds = new Set(syncs.map((f) => (f.payload as { run: { runId: string } }).run.runId));
    // The evicted run is re-seeded from persistence even though no event of it remains in the ring.
    expect(runIds.has("evicted-run")).toBe(true);
    // The still-in-ring run is re-seeded too (regression: existing behavior preserved).
    expect(runIds.has("active-run")).toBe(true);
  });
});
