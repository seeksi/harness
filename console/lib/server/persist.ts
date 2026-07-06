// console/lib/server/persist.ts
// SQLite persistence (better-sqlite3, WAL). Node-only — import behind
// `runtime = "nodejs"` routes only. Stores a run snapshot + an append-only event
// log per run, and enforces 20-runs-per-project retention (older runs + their
// events pruned automatically on write).

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { RunState } from "@/lib/contract/types";
import type { Envelope } from "@/lib/contract/events";

const DB_PATH = process.env.HARNESS_DB_PATH ?? "./data/console.db";
const RUNS_PER_PROJECT = 20;

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const abs = DB_PATH === ":memory:" ? DB_PATH : path.resolve(DB_PATH);
  if (abs !== ":memory:") fs.mkdirSync(path.dirname(abs), { recursive: true });
  _db = new Database(abs);
  _db.pragma("journal_mode = WAL");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      brief       TEXT NOT NULL DEFAULT '',
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      outcome     TEXT,
      snapshot    TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);
    CREATE TABLE IF NOT EXISTS events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id  TEXT NOT NULL,
      ts      INTEGER NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
  `);
}

export function upsertRun(state: RunState): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, project_id, brief, started_at, snapshot)
       VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       brief = excluded.brief, snapshot = excluded.snapshot`
  ).run(state.runId, state.projectId, state.brief, state.startedAt, JSON.stringify(state));
  pruneProject(state.projectId);
}

export function finalizeRun(runId: string, outcome: "done" | "failed", endedAt: number): void {
  const db = getDb();
  db.prepare("UPDATE runs SET ended_at = ?, outcome = ? WHERE id = ?").run(endedAt, outcome, runId);
}

export function appendEvent(env: Envelope): void {
  const db = getDb();
  db.prepare("INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)").run(
    env.runId,
    env.ts,
    env.type,
    JSON.stringify(env)
  );
}

// Gapless replay source: every event for a run from a given seq onward, in order.
export function eventsSince(runId: string, afterSeq = 0): Array<{ seq: number; env: Envelope }> {
  const db = getDb();
  const rows = db
    .prepare("SELECT seq, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC")
    .all(runId, afterSeq) as Array<{ seq: number; payload: string }>;
  return rows.map((r) => ({ seq: r.seq, env: JSON.parse(r.payload) as Envelope }));
}

export function getSnapshot(runId: string): RunState | null {
  const db = getDb();
  const row = db.prepare("SELECT snapshot FROM runs WHERE id = ?").get(runId) as { snapshot: string } | undefined;
  return row ? (JSON.parse(row.snapshot) as RunState) : null;
}

export interface RunRow {
  id: string;
  projectId: string;
  brief: string;
  startedAt: number;
  endedAt: number | null;
  outcome: string | null;
}

export function listRecentRuns(projectId: string, limit = RUNS_PER_PROJECT): RunRow[] {
  const db = getDb();
  const n = Math.min(Math.max(1, Math.floor(limit) || 1), RUNS_PER_PROJECT);
  const rows = db
    .prepare(
      "SELECT id, project_id, brief, started_at, ended_at, outcome FROM runs WHERE project_id = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(projectId, n) as Array<{
    id: string;
    project_id: string;
    brief: string;
    started_at: number;
    ended_at: number | null;
    outcome: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    brief: r.brief,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome: r.outcome,
  }));
}

// Retention: keep the newest RUNS_PER_PROJECT runs per project; prune the rest and
// their events. Returns the number of runs pruned.
export function pruneProject(projectId: string, keep = RUNS_PER_PROJECT): number {
  const db = getDb();
  const stale = db
    .prepare(
      `SELECT id FROM runs WHERE project_id = ?
         ORDER BY started_at DESC LIMIT -1 OFFSET ?`
    )
    .all(projectId, keep) as Array<{ id: string }>;
  if (stale.length === 0) return 0;
  const delEvents = db.prepare("DELETE FROM events WHERE run_id = ?");
  const delRun = db.prepare("DELETE FROM runs WHERE id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) {
      delEvents.run(id);
      delRun.run(id);
    }
  });
  tx(stale.map((r) => r.id));
  return stale.length;
}

// Test-only: close + reset the singleton, optionally repointing the DB path.
export function resetDb(overridePath?: string): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  if (overridePath !== undefined) {
    process.env.HARNESS_DB_PATH = overridePath;
    const abs = overridePath === ":memory:" ? overridePath : path.resolve(overridePath);
    if (abs !== ":memory:") fs.mkdirSync(path.dirname(abs), { recursive: true });
    _db = new Database(abs);
    _db.pragma("journal_mode = WAL");
    initSchema(_db);
  }
}
