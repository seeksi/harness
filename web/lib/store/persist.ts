// web/lib/store/persist.ts
// SQLite persistence via better-sqlite3 (WAL). Node-only; import only behind
// `export const runtime = "nodejs"` routes.
//
// Tables:
//   runs    — snapshot per run (upserted)
//   events  — append-only event log (seq AUTOINCREMENT)
//   slot    — single-row mutex for the single-slot lock

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { RunState } from "@/lib/contract/types";
import type { SSEEvent } from "@/lib/contract/events";

const DB_PATH = process.env.HARNESS_DB_PATH ?? "./data/umbrella.db";

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const absPath = path.resolve(DB_PATH);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  _db = new Database(absPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      brief       TEXT NOT NULL DEFAULT '',
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      outcome     TEXT,
      spent_usd   REAL,
      snapshot    TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slot (
      id      INTEGER PRIMARY KEY,
      run_id  TEXT
    );

    -- Ensure the single slot row exists
    INSERT OR IGNORE INTO slot (id, run_id) VALUES (1, NULL);
  `);
}

export function appendEvent(runId: string, event: SSEEvent): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)"
  ).run(runId, Math.floor(Date.now() / 1000), event.type, JSON.stringify(event));
}

export function upsertSnapshot(runId: string, state: RunState): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO runs (id, brief, started_at, snapshot)
      VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      brief    = excluded.brief,
      snapshot = excluded.snapshot,
      spent_usd = COALESCE(excluded.spent_usd, runs.spent_usd)
  `).run(runId, state.task.brief, Math.floor(Date.now() / 1000), JSON.stringify(state));
}

export function finalizeRun(
  runId: string,
  outcome: "done" | "failed",
  spentUsd?: number
): void {
  const db = getDb();
  db.prepare(
    "UPDATE runs SET ended_at = ?, outcome = ?, spent_usd = ? WHERE id = ?"
  ).run(Math.floor(Date.now() / 1000), outcome, spentUsd ?? null, runId);
}

/** Atomically claim the slot. Returns true if acquired, false if already taken. */
export function acquireSlot(runId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE slot SET run_id = ? WHERE id = 1 AND run_id IS NULL")
    .run(runId);
  return result.changes > 0;
}

/** Release the slot (call after run completes or errors). */
export function releaseSlot(runId: string): void {
  const db = getDb();
  db.prepare("UPDATE slot SET run_id = NULL WHERE id = 1 AND run_id = ?").run(runId);
}

/** Returns the currently-held run id, or null if slot is free. */
export function currentSlot(): string | null {
  const db = getDb();
  const row = db.prepare("SELECT run_id FROM slot WHERE id = 1").get() as
    | { run_id: string | null }
    | undefined;
  return row?.run_id ?? null;
}

/** True once a run has a terminal outcome persisted (ended_at set). */
export function isRunFinalized(runId: string): boolean {
  const db = getDb();
  const row = db.prepare("SELECT ended_at FROM runs WHERE id = ?").get(runId) as
    | { ended_at: number | null }
    | undefined;
  return row?.ended_at != null;
}

/** Returns the latest snapshot for a run, or null if unknown. */
export function getSnapshot(runId: string): RunState | null {
  const db = getDb();
  const row = db.prepare("SELECT snapshot FROM runs WHERE id = ?").get(runId) as
    | { snapshot: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.snapshot) as RunState;
}

/** Close and reset the DB singleton (test use only). Optionally override the path. */
export function resetDb(overridePath?: string): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  if (overridePath !== undefined) {
    // Open and init the new DB immediately so the singleton is ready.
    const absPath = overridePath === ":memory:" ? overridePath : path.resolve(overridePath);
    if (absPath !== ":memory:") {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
    }
    _db = new Database(absPath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    initSchema(_db);
  }
}

// ponytail: event-log pagination / streaming query; add when the log is used for replay or audit UI.
