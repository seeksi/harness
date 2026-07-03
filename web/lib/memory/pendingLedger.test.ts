// web/lib/memory/pendingLedger.test.ts
// Contract tests for the operator-side pending-ledger gate.
//
// Contract under test:
//   listPending()  -> only entries with operator_confirmed:false && !rejected
//   confirm(id)    -> flips operator_confirmed:true for that update_id; true if found
//   reject(id)     -> marks rejected:true; true if found; NEVER throws, tolerates
//                      memory-os being unreachable (it makes no CLI call at all —
//                      see the ponytail note in pendingLedger.ts)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

let ledgerFile: string;
let ledgerDir: string;

function writeLedger(entries: Record<string, unknown>[]): void {
  fs.writeFileSync(ledgerFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function readLedger(): Record<string, unknown>[] {
  return fs
    .readFileSync(ledgerFile, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function loadModule() {
  vi.resetModules();
  return import("./pendingLedger");
}

beforeEach(() => {
  ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-ledger-"));
  ledgerFile = path.join(ledgerDir, "memory-pending-provisionals.jsonl");
  vi.stubEnv("MEMORY_PENDING_PATH", ledgerFile);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(ledgerDir, { recursive: true, force: true });
});

describe("pendingLedger", () => {
  it("listPending() returns [] when the ledger file does not exist yet", async () => {
    const mod = await loadModule();
    expect(mod.listPending()).toEqual([]);
  });

  it("listPending() shows only unconfirmed, non-rejected entries", async () => {
    writeLedger([
      { ts: 1, slug: "s", recordType: "decision", update_id: "upd_1", record: {}, operator_confirmed: false },
      { ts: 2, slug: "s", recordType: "decision", update_id: "upd_2", record: {}, operator_confirmed: true },
      { ts: 3, slug: "s", recordType: "constraint", update_id: "upd_3", record: {}, operator_confirmed: false, rejected: true },
      { ts: 4, slug: "s", recordType: "constraint", update_id: "upd_4", record: {}, operator_confirmed: false },
    ]);
    const mod = await loadModule();
    const pending = mod.listPending();
    expect(pending.map((e) => e.update_id).sort()).toEqual(["upd_1", "upd_4"]);
  });

  it("confirm(id) flips operator_confirmed to true and persists it", async () => {
    writeLedger([
      { ts: 1, slug: "s", recordType: "decision", update_id: "upd_1", record: { topic: "x" }, operator_confirmed: false },
    ]);
    const mod = await loadModule();
    expect(mod.confirm("upd_1")).toBe(true);
    expect(mod.listPending()).toEqual([]);

    const onDisk = readLedger();
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].operator_confirmed).toBe(true);
    expect(onDisk[0].record).toEqual({ topic: "x" }); // rest of the entry untouched
  });

  it("confirm(id) returns false for an unknown update_id (no-op, no throw)", async () => {
    writeLedger([
      { ts: 1, slug: "s", recordType: "decision", update_id: "upd_1", record: {}, operator_confirmed: false },
    ]);
    const mod = await loadModule();
    expect(mod.confirm("upd_does_not_exist")).toBe(false);
    expect(readLedger()[0].operator_confirmed).toBe(false); // untouched
  });

  it("reject(id) marks rejected:true, removes it from listPending, and persists it", async () => {
    writeLedger([
      { ts: 1, slug: "s", recordType: "constraint", update_id: "upd_1", record: {}, operator_confirmed: false },
    ]);
    const mod = await loadModule();
    expect(mod.reject("upd_1")).toBe(true);
    expect(mod.listPending()).toEqual([]);
    expect(readLedger()[0].rejected).toBe(true);
  });

  it("reject(id) tolerates memory-os being completely unreachable (never throws)", async () => {
    // No MEMORY_OS_DIR / ENABLE_MEMORY_OS wired at all — reject makes no CLI call
    // (see ponytail note), so an absent/broken memory-os must never surface here.
    vi.stubEnv("ENABLE_MEMORY_OS", "1");
    vi.stubEnv("MEMORY_OS_DIR", "/nonexistent/conformance-void");
    writeLedger([
      { ts: 1, slug: "s", recordType: "constraint", update_id: "upd_1", record: {}, operator_confirmed: false },
    ]);
    const mod = await loadModule();
    expect(() => mod.reject("upd_1")).not.toThrow();
    expect(mod.reject("upd_1")).toBe(true);
  });

  it("reject(id) returns false for an unknown update_id", async () => {
    writeLedger([
      { ts: 1, slug: "s", recordType: "constraint", update_id: "upd_1", record: {}, operator_confirmed: false },
    ]);
    const mod = await loadModule();
    expect(mod.reject("nope")).toBe(false);
  });
});
