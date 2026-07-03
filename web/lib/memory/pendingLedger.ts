// web/lib/memory/pendingLedger.ts
// Operator-side gate over the pending-provisionals ledger written by
// proposeFromHarness.ts. That module ledgers approved decision/constraint
// records with operator_confirmed:false — memory-os has already persisted them,
// but they are not surfaced as committed HARNESS knowledge until an operator
// reviews them here. This module rewrites the same JSONL in place:
//   listPending() -> unconfirmed, non-rejected entries (the operator's inbox)
//   confirm(id)   -> flips operator_confirmed:true for that update_id
//   reject(id)    -> marks rejected:true
// Same data-dir idiom as proposeFromHarness.ts. Never throws (fail-open).

import fs from "fs";

export interface PendingEntry {
  ts: number;
  slug: string;
  recordType: string;
  update_id: string;
  saved_record_id?: string;
  record: Record<string, unknown>;
  operator_confirmed: boolean;
  rejected?: boolean;
}

const PENDING_FILE = () =>
  process.env.MEMORY_PENDING_PATH ?? "./data/memory-pending-provisionals.jsonl";

function logFailOpen(op: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[memory-os] pendingLedger ${op} failed open: ${msg}`);
}

function readAll(file: string): PendingEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as PendingEntry);
}

function writeAll(file: string, entries: PendingEntry[]): void {
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(file, entries.length ? body + "\n" : "");
}

/** Unconfirmed, non-rejected entries — the operator's inbox. [] on any read failure. */
export function listPending(): PendingEntry[] {
  try {
    return readAll(PENDING_FILE()).filter((e) => !e.operator_confirmed && !e.rejected);
  } catch (err) {
    logFailOpen("listPending", err);
    return [];
  }
}

/** Flip operator_confirmed=true for the entry keyed by update_id. false = not found or failed. */
export function confirm(id: string): boolean {
  const file = PENDING_FILE();
  try {
    const entries = readAll(file);
    const entry = entries.find((e) => e.update_id === id);
    if (!entry) return false;
    entry.operator_confirmed = true;
    writeAll(file, entries);
    return true;
  } catch (err) {
    logFailOpen(`confirm(${id})`, err);
    return false;
  }
}

/**
 * Mark an entry rejected. false = not found or failed.
 *
 * ponytail: the spec asks for a best-effort supersede of the memory-os record
 * via runMemCli, but `mem` (memory_layer/engine/cli.py) has no "supersede by
 * id" / "retract" subcommand — propose()'s supersession only fires internally
 * when a NEW proposal shares the same topic/constraint/name key as an existing
 * active record. Faking that here would mean submitting a second proposal just
 * to trigger it, leaving a duplicate active record behind instead of cleanly
 * retiring the rejected one. So reject is local-ledger-only for now; wire a
 * real runMemCli call if/when `mem` grows a dedicated supersede/retract
 * subcommand.
 */
export function reject(id: string): boolean {
  const file = PENDING_FILE();
  try {
    const entries = readAll(file);
    const entry = entries.find((e) => e.update_id === id);
    if (!entry) return false;
    entry.rejected = true;
    writeAll(file, entries);
    return true;
  } catch (err) {
    logFailOpen(`reject(${id})`, err);
    return false;
  }
}
