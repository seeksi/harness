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
// Per-run event ring: multi-hour live runs must not grow the event log unbounded. On
// each append we prune this run's oldest events beyond the cap (the client feed is
// already ring-buffered at TRACE_WINDOW; this bounds the durable store the same way).
const EVENTS_PER_RUN = Number(process.env.HARNESS_EVENTS_PER_RUN) || 5000;
// Default page size for eventsSince — a live reconnect replays in bounded pages, never
// one unbounded SELECT. High enough that existing full-replay callers are unaffected.
const EVENTS_PAGE_DEFAULT = 2000;

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
    CREATE TABLE IF NOT EXISTS audit (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      cmd      TEXT NOT NULL,
      argv     TEXT NOT NULL,
      outcome  TEXT NOT NULL,
      code     INTEGER,
      error    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);
  `);
}

// One append-only audit row per harness spawn attempt (threat model T7). NEVER stores
// stdout/stderr or an error message — only argv + outcome + ts + exit code + error CLASS.
export interface AuditRecord {
  ts: number;
  cmd: string;
  argv: string[];
  outcome: string;
  code?: number | null;
  error?: string;
}

export function appendAudit(rec: AuditRecord): void {
  const db = getDb();
  db.prepare("INSERT INTO audit (ts, cmd, argv, outcome, code, error) VALUES (?, ?, ?, ?, ?, ?)").run(
    rec.ts,
    rec.cmd,
    JSON.stringify(rec.argv),
    rec.outcome,
    rec.code ?? null,
    rec.error ?? null
  );
}

export function listAudit(limit = 100): AuditRecord[] {
  const db = getDb();
  const n = Math.max(1, Math.floor(limit) || 1);
  const rows = db
    .prepare("SELECT ts, cmd, argv, outcome, code, error FROM audit ORDER BY id DESC LIMIT ?")
    .all(n) as Array<{ ts: number; cmd: string; argv: string; outcome: string; code: number | null; error: string | null }>;
  return rows.map((r) => ({
    ts: r.ts,
    cmd: r.cmd,
    argv: JSON.parse(r.argv) as string[],
    outcome: r.outcome,
    code: r.code,
    error: r.error ?? undefined,
  }));
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

export function appendEvent(env: Envelope, cap = EVENTS_PER_RUN): void {
  const db = getDb();
  db.prepare("INSERT INTO events (run_id, ts, type, payload) VALUES (?, ?, ?, ?)").run(
    env.runId,
    env.ts,
    env.type,
    JSON.stringify(env)
  );
  // Per-run ring: drop this run's oldest events beyond the cap so a multi-hour run's
  // durable log stays bounded. Cheap (one COUNT + at most one bounded DELETE per append).
  const count = (db.prepare("SELECT COUNT(*) AS n FROM events WHERE run_id = ?").get(env.runId) as { n: number }).n;
  if (count > cap) {
    db.prepare(
      `DELETE FROM events WHERE run_id = ? AND seq NOT IN (
         SELECT seq FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?
       )`
    ).run(env.runId, env.runId, cap);
  }
}

// Gapless replay source: events for a run from a given seq onward, in order, capped at
// `limit` per page. Page again from the last returned seq for the next slice — a live
// reconnect never issues one unbounded SELECT.
export function eventsSince(
  runId: string,
  afterSeq = 0,
  limit = EVENTS_PAGE_DEFAULT
): Array<{ seq: number; env: Envelope }> {
  const db = getDb();
  const n = Math.max(1, Math.floor(limit) || 1);
  const rows = db
    .prepare("SELECT seq, payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .all(runId, afterSeq, n) as Array<{ seq: number; payload: string }>;
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

// Batched variant of listRecentRuns for many projects: ONE query for all project ids
// (grouped + capped per project in JS) instead of N queries — kills the /api/projects
// N+1. Returns a map keyed by projectId; a project with no runs is absent (caller defaults
// to []). Unknown/empty input → empty map (no query).
export function listRecentRunsForProjects(
  projectIds: string[],
  perProject = RUNS_PER_PROJECT
): Map<string, RunRow[]> {
  const out = new Map<string, RunRow[]>();
  const ids = [...new Set(projectIds)].filter((s) => typeof s === "string" && s.length > 0);
  if (ids.length === 0) return out;
  const cap = Math.min(Math.max(1, Math.floor(perProject) || 1), RUNS_PER_PROJECT);
  const db = getDb();
  const placeholders = ids.map(() => "?").join(", ");
  // Per-project windowing in SQL: ROW_NUMBER() partitions by project and the outer WHERE
  // keeps only the newest `cap` per project — so the DB returns at most cap*|ids| rows, not
  // every row for every project (the old "fetch all, cap in JS" was the N+1's cousin: an
  // unbounded scan). better-sqlite3 ships SQLite with window-function support.
  const rows = db
    .prepare(
      `SELECT id, project_id, brief, started_at, ended_at, outcome FROM (
         SELECT id, project_id, brief, started_at, ended_at, outcome,
                ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY started_at DESC, id DESC) AS rn
           FROM runs WHERE project_id IN (${placeholders})
       ) WHERE rn <= ?
       ORDER BY project_id ASC, started_at DESC`
    )
    .all(...ids, cap) as Array<{
    id: string;
    project_id: string;
    brief: string;
    started_at: number;
    ended_at: number | null;
    outcome: string | null;
  }>;
  for (const r of rows) {
    let bucket = out.get(r.project_id);
    if (!bucket) {
      bucket = [];
      out.set(r.project_id, bucket);
    }
    bucket.push({
      id: r.id,
      projectId: r.project_id,
      brief: r.brief,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      outcome: r.outcome,
    });
  }
  return out;
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
