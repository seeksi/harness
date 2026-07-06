// console/app/deck/lib/traceFile.ts
// Read-only access to `.claude/traces/*.jsonl` — a TRUST BOUNDARY: operator-supplied
// browser input (a session id) reaches the filesystem. Session ids are whitelisted to
// the exact shape trace-log.py mints (.claude/skills/eval-gate/trace-log.py: hook
// session_id, filename-safe) BEFORE they ever touch path.join, and the resolved REAL
// path must land exactly inside the traces dir, AND the traces dir's own real path
// must stay inside the repo root — a symlink at either hop (the file, the `.claude/
// traces` dir itself, or an ancestor of either) pointing elsewhere is rejected, same
// hardening as web/lib/sandbox/worktree.ts's relocateTrace. Never trust a session id
// past the regex. Node-only (fs).

import fs from "fs";
import path from "path";

// Matches the id shape trace-log.py writes (a hook session_id, filename-safe).
// Deliberately conservative: no ".", "/", or other path-meaningful characters, so
// "../../etc/passwd" or "a/b" can never even reach path.join.
export const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

// A trace is one JSONL line per tool call; refuse to parse a runaway file rather than
// hold GBs in memory (mirrors the size cap in web/lib/sandbox/worktree.ts). Exported
// for tests (deliberately not tunable at runtime).
export const MAX_TRACE_BYTES = 10 * 1024 * 1024;

// True iff `child`'s realpath is `root` itself or nested under it. Used to contain
// BOTH hops of the symlink chain: the traces dir under the repo root, and the trace
// file under the traces dir. Checking only the leaf (file-under-dir) is not enough —
// if the *directory* itself (`.claude/traces`) is a symlink pointing outside the repo,
// a file living inside that outside target would still satisfy "file resolves inside
// dir" while the dir itself escaped the repo entirely.
function isRealAncestorOrSelf(root: string, child: string): boolean {
  return child === root || child.startsWith(root + path.sep);
}

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

  // Second hop: the traces DIRECTORY itself (or an ancestor of it) may be a symlink
  // that resolves outside the repo — e.g. `.claude/traces -> /somewhere/else`. In that
  // case realDir/expected/realFile all agree with each other (they're all computed
  // from the same escaped location) and the check above passes anyway. Require the
  // realpathed traces dir to stay under the realpathed repo root.
  const realRepoRoot = fs.existsSync(repoRoot) ? fs.realpathSync(repoRoot) : path.resolve(repoRoot);
  if (!isRealAncestorOrSelf(realRepoRoot, realDir)) {
    throw new Error("traces directory resolves outside the repo root (symlink?)");
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
