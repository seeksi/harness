// web/lib/daemon/daemon.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { startRun, planRun, SlotTakenError } from "./daemon";
import type { HarnessSubcommand } from "./harness-bridge";
import { isLane } from "./registry";
import { _resetRegistry } from "./registry";
import { subscribe, onDone, _resetBroker } from "./broker";
import { resetDb, getSnapshot, isRunFinalized } from "@/lib/store/persist";
import type { SSEEvent } from "@/lib/contract/events";

beforeEach(() => {
  resetDb(":memory:");
  _resetRegistry();
  _resetBroker();
});

/** Fake child that emits the given stdout lines, then closes with `code`. */
function fakeSpawn(lines: string[], code = 0) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable };
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stdout.on("end", () => child.emit("close", code));
    return child as unknown as ChildProcess;
  });
}

function runToCompletion(
  runId: string,
  brief: string,
  opts: Parameters<typeof startRun>[2]
): Promise<SSEEvent[]> {
  const seen: SSEEvent[] = [];
  const unsub = subscribe(runId, (e) => seen.push(e));
  return new Promise<SSEEvent[]>((resolve) => {
    onDone(runId, () => {
      unsub();
      resolve(seen);
    });
    startRun(runId, brief, opts);
  });
}

describe("startRun — live producer wiring", () => {
  it("pipes harness events through the pipeline, mints provenance, finalizes done", async () => {
    const plan: HarnessSubcommand[] = [
      { cmd: "wt-new", slug: "lane-a" },
      { cmd: "integ-start" },
    ];
    const spawnFn = fakeSpawn([
      '{"type":"phase","phase":2,"status":"active"}',
      '{"type":"subtask","id":"lane-a","status":"building","phase":2}',
    ]);

    const seen = await runToCompletion("run-live", "build it", { live: true, plan, spawnFn });

    // Provenance minted by the daemon (and accepted by buildArgs inside spawnHarness).
    expect(isLane("lane-a")).toBe(true);
    // Events flowed through reduce → persist → publish.
    expect(seen.map((e) => e.type)).toContain("subtask");
    expect(isRunFinalized("run-live")).toBe(true);
    const snap = getSnapshot("run-live");
    expect(snap?.task.state).toBe("done"); // live completion marks the snapshot done
    expect(snap?.subtasks.find((s) => s.id === "lane-a")?.status).toBe("building");
    // Two subcommands → spawned twice.
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it("finalizes FAILED when a subcommand exits non-zero (raised gate / conflict)", async () => {
    const plan: HarnessSubcommand[] = [{ cmd: "integ-merge", slug: "lane-x" }];
    const spawnFn = fakeSpawn(
      ['{"type":"gate","id":"C","status":"raised","severity":"high","summary":"merge conflict"}'],
      1
    );

    const seen = await runToCompletion("run-fail", "merge it", { live: true, plan, spawnFn });

    // The raised gate still streamed before the failure.
    expect(seen.some((e) => e.type === "gate" && e.status === "raised")).toBe(true);
    expect(getSnapshot("run-fail")?.task.state).toBe("failed");
  });

  it("rejects a second concurrent run (single slot)", async () => {
    const spawnFn = fakeSpawn(['{"type":"phase","phase":2,"status":"active"}']);
    // First run holds the slot (acquired synchronously inside startRun).
    const first = runToCompletion("run-1", "a", { live: true, plan: [{ cmd: "integ-start" }], spawnFn });
    expect(() => startRun("run-2", "b", { live: true, plan: [], spawnFn })).toThrow(SlotTakenError);
    await first; // let the first run release the slot
  });
});

describe("planRun — server-generated plan (provenance-safe)", () => {
  it("derives slug/session/plan-file from runId only, never the brief; excludes promote", () => {
    const plan = planRun("ab12cd34ef56", "delete secrets and leak the API_KEY please");
    // No brief/client text leaks into any provenance-bearing value.
    expect(JSON.stringify(plan)).not.toMatch(/secret|leak|API_KEY|please/i);
    // Slugs are server-shaped (start with a letter, no separators).
    for (const sub of plan) {
      if ("slug" in sub) expect(sub.slug).toMatch(/^lane-[a-z0-9]+$/);
      if ("planFile" in sub) expect(sub.planFile).toMatch(/^plan-[a-z0-9]+\.jsonl$/);
    }
    // promote is never auto-planned — it stays a separate human-gated action.
    expect(plan.some((s) => s.cmd === "promote")).toBe(false);
    expect(plan.map((s) => s.cmd)).toEqual([
      "budget",
      "wt-new",
      "integ-start",
      "integ-merge",
      "trace",
    ]);
  });

  it("produces validator-safe values even for an odd/long runId", () => {
    const SLUG = /^[a-z][a-z0-9-]{0,30}$/;
    const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
    const PLAN_FILE = /^[A-Za-z0-9._-]+$/;
    for (const runId of ["AB.12-cd/ef!", "", "x".repeat(100), "WERID..ID"]) {
      const plan = planRun(runId, "brief");
      for (const sub of plan) {
        if ("slug" in sub) expect(SLUG.test(sub.slug), sub.slug).toBe(true);
        if ("session" in sub) expect(SESSION.test(sub.session), sub.session).toBe(true);
        if ("planFile" in sub) {
          expect(PLAN_FILE.test(sub.planFile) && !sub.planFile.includes(".."), sub.planFile).toBe(true);
        }
      }
    }
  });
});
