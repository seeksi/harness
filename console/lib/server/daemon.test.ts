import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { startRun, planRun, currentSlot, _resetSlot, SlotTakenError } from "./daemon";
import { resetDb, eventsSince, listAudit, getSnapshot } from "./persist";
import { subscribe, _resetBroker } from "./broker";
import { _resetRegistry } from "@/lib/bridge/registry";
import type { Envelope } from "@/lib/contract/events";

const OLD_ENV = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = "test";
  resetDb(":memory:");
  _resetBroker();
  _resetRegistry();
  _resetSlot();
});
afterEach(() => {
  process.env.NODE_ENV = OLD_ENV;
  vi.restoreAllMocks();
});

// Fake harness child: emits JSON lines for `cmd`, then closes 0.
function fakeSpawn(byCmd: Record<string, string[]>) {
  return vi.fn((_script: string, args: string[], opts: Record<string, unknown>) => {
    expect(opts.shell).toBe(false);
    const lines = byCmd[args[0]] ?? [];
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean };
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stderr = Readable.from([]);
    child.pid = 999;
    child.kill = () => true;
    child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
    return child as never;
  });
}

// Wait until the async producer settles (slot released).
async function waitForSlotFree(timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (currentSlot() !== null) {
    if (Date.now() - t0 > timeoutMs) throw new Error("slot never released");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("planRun — provenance derived from the server runId, never the brief", () => {
  it("derives a shape-valid slug + plan file deterministically from runId", () => {
    const a = planRun("run-aaaa", "auto");
    const b = planRun("run-aaaa", "opus");
    expect(a.slug).toMatch(/^lane-[0-9a-f]{16}$/);
    expect(a.planFile).toMatch(/^plan-[0-9a-f]{16}\.jsonl$/);
    expect(a.slug).toBe(b.slug); // same runId → same provenance
    expect(a.model).toBe("sonnet");
    expect(b.model).toBe("opus");
  });
});

describe("startRun — live spawn pipeline: persist + broadcast + slot", () => {
  it("streams harness events through persist.appendEvent AND the broker, then releases the slot", async () => {
    const broadcast: Envelope[] = [];
    subscribe((item) => broadcast.push(item.env));

    const spawnFn = fakeSpawn({
      budget: [JSON.stringify({ type: "phase", phase: 1, status: "done" })],
      "integ-start": [],
      "wt-new": [JSON.stringify({ type: "subtask", id: "lane-x", status: "building", phase: 2 })],
      "wt-commit": [],
      "wt-verify": [JSON.stringify({ type: "gate", id: "B", status: "raised", severity: "high", summary: "empty lane" })],
      "integ-merge": [],
      "reset-base": [],
    });

    startRun(
      { runId: "run-live1", projectId: "proj", projectName: "vector", brief: "do the thing", routing: "sonnet" },
      { live: true, spawnFn: spawnFn as never, writePlan: () => {} }
    );
    await waitForSlotFree();

    // Persisted event log has the seed sync + the streamed deltas.
    const persisted = eventsSince("run-live1", 0).map((e) => e.env.type);
    expect(persisted[0]).toBe("sync");
    expect(persisted).toContain("phase");
    expect(persisted).toContain("gate");

    // Broadcast fan-out saw the same stream (SSE clients).
    expect(broadcast.some((e) => e.type === "sync")).toBe(true);
    expect(broadcast.some((e) => e.type === "gate")).toBe(true);

    // An audit row exists per spawned subcommand (budget/integ-start/wt-new/... + reset-base).
    const cmds = listAudit(50).map((a) => a.cmd);
    expect(cmds).toContain("budget");
    expect(cmds).toContain("wt-verify");
    expect(cmds).toContain("reset-base");

    // Snapshot persisted; slot free.
    expect(getSnapshot("run-live1")?.projectName).toBe("vector");
    expect(currentSlot()).toBeNull();
  });

  it("rejects a second concurrent run (single slot)", () => {
    // A spawn that never closes holds the slot for the assertion.
    const hang = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean };
      child.stdout = new Readable({ read() {} });
      child.stderr = new Readable({ read() {} });
      child.pid = 1;
      child.kill = () => true;
      return child as never;
    });
    startRun(
      { runId: "run-a", projectId: "proj", projectName: "v", brief: "x" },
      { live: true, spawnFn: hang as never, writePlan: () => {} }
    );
    expect(currentSlot()).toBe("run-a");
    expect(() =>
      startRun({ runId: "run-b", projectId: "proj", projectName: "v", brief: "y" }, { live: true, spawnFn: hang as never, writePlan: () => {} })
    ).toThrow(SlotTakenError);
    _resetSlot(); // release the hung run for teardown
  });

  it("non-live startRun only seeds (no harness spawn) — fixture path is untouched", async () => {
    const spawnFn = vi.fn();
    startRun({ runId: "run-fix", projectId: "proj", projectName: "v", brief: "x" }, { live: false, spawnFn: spawnFn as never });
    await waitForSlotFree();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(eventsSince("run-fix", 0).map((e) => e.env.type)).toEqual(["sync"]);
  });
});
