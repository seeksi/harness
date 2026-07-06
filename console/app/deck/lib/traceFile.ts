// console/app/deck/lib/traceFile.ts
// Read-only access to `.claude/traces/*.jsonl` — a TRUST BOUNDARY: operator-supplied
// browser input (a session id) reaches the filesystem. Session ids are whitelisted to
// the exact shape trace-log.py mints (.claude/skills/eval-gate/trace-log.py: hook
// session_id, filename-safe) BEFORE they ever touch path.join, and the resolved REAL
// path must land exactly inside the traces dir — a symlink (the file or an ancestor
// dir) pointing elsewhere is rejected, same hardening as web/lib/sandbox/worktree.ts's
// relocateTrace. Never trust a session id past the regex. Node-only (fs).

import fs from "fs";
import path from "path";

// Matches the id shape trace-log.py writes (a hook session_id, filename-safe).
// Deliberately conservative: no ".", "/", or other path-meaningful characters, so
// "../../etc/passwd" or "a/b" can never even reach path.join.
export const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

// A trace is one JSONL line per tool call; refuse to parse a runaway file rather than
// hold GBs in memory (mirrors the size cap in web/lib/sandbox/worktree.ts).
const MAX_TRACE_BYTES = 10 * 1024 * 1024;

export function isValidSessionId(id: string): boolean {
  return SESSION_RE.test(id);
}

function tracesDir(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "traces");
}

// List available session ids. Filenames that don't themselves conform to the
// whitelist are silently skipped (defense in depth — never surface, let alone read,
// a stray/malicious file name).
export function listSessions(repoRoot: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(tracesDir(repoRoot));
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter(isValidSessionId)
    .sort();
}

export interface RawTraceLine {
  ts: number;
  tool: string;
  sig: string;
}

// Resolve + read `<repoRoot>/.claude/traces/<sessionId>.jsonl`. Throws on anything
// that looks like an escape attempt or a not-a-plain-file/oversized read; returns []
// for a session id that's well-formed but simply has no file yet (not an error —
// the operator may be looking at a run that hasn't produced a trace).
export function readTraceFile(repoRoot: string, sessionId: string): RawTraceLine[] {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`invalid session id (rejected before touching the filesystem): ${JSON.stringify(sessionId)}`);
  }
  const dir = tracesDir(repoRoot);
  const file = path.join(dir, `${sessionId}.jsonl`);
  if (!fs.existsSync(file)) return [];

  const realFile = fs.realpathSync(file);
  const realDir = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  const expected = path.join(realDir, `${sessionId}.jsonl`);
  if (realFile !== expected) {
    throw new Error("trace file resolves outside the traces directory (symlink?)");
  }

  const st = fs.statSync(realFile);
  if (!st.isFile()) throw new Error("trace path is not a regular file");
  if (st.size > MAX_TRACE_BYTES) throw new Error(`trace file too large (${st.size} bytes) — refusing to parse`);

  return parseTraceLines(fs.readFileSync(realFile, "utf8"));
}

// Exported separately so parsing (malformed-line tolerance) is unit-testable without
// touching the filesystem — the hook appends non-blockingly, so a partial last line
// mid-write is expected, not exceptional.
export function parseTraceLines(text: string): RawTraceLine[] {
  const lines: RawTraceLine[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue; // malformed/partial line — skip, never throw the whole file away
    }
    if (
      row &&
      typeof row === "object" &&
      typeof (row as Record<string, unknown>).ts === "number" &&
      typeof (row as Record<string, unknown>).tool === "string" &&
      typeof (row as Record<string, unknown>).sig === "string"
    ) {
      const r = row as { ts: number; tool: string; sig: string };
      lines.push({ ts: r.ts, tool: r.tool, sig: r.sig });
    }
  }
  return lines;
}
