// web/lib/daemon/daemon.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import { startRun, SlotTakenError } from "./daemon";
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

  it("ignores caller-supplied plan/spawnFn in production (the seam is test-only)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const spawnFn = fakeSpawn(['{"type":"phase","phase":2,"status":"active"}']);
    try {
      await runToCompletion("run-prod", "b", {
        live: true,
        plan: [{ cmd: "integ-start" }],
        spawnFn,
      });
      // In production the injected plan/spawnFn are ignored → planRun runs → it throws
      // (not implemented) → run fails, and the fake spawn is never invoked.
      expect(spawnFn).not.toHaveBeenCalled();
      expect(getSnapshot("run-prod")?.task.state).toBe("failed");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a second concurrent run (single slot)", async () => {
    const spawnFn = fakeSpawn(['{"type":"phase","phase":2,"status":"active"}']);
    // First run holds the slot (acquired synchronously inside startRun).
    const first = runToCompletion("run-1", "a", { live: true, plan: [{ cmd: "integ-start" }], spawnFn });
    expect(() => startRun("run-2", "b", { live: true, plan: [], spawnFn })).toThrow(SlotTakenError);
    await first; // let the first run release the slot
  });
});
