// console/app/deck/lib/gitDiff.ts
// Read-only `git show` wrapper behind the per-worktree-commit diff viewer (§5/§6) — a
// TRUST BOUNDARY: operator-supplied input (project id + commit-ish) reaches a child
// process. The client NEVER sends a filesystem path — only an opaque discovered-
// project id (resolveProjectPath) — so the "path" the process actually runs in is
// always a string the server itself produced via discovery, never one echoed back
// from the request. Two independent gates, both required, and both re-checked INSIDE
// gitShow itself (not only by its caller) so the boundary can't be bypassed by a call
// site that forgets to gate upstream:
//   1. The repo must be one of the server's OWN discovered projects (never an
//      arbitrary filesystem path chosen by the request) — checked by real path so a
//      symlinked project dir can't be used to point elsewhere.
//   2. The commit-ish must match a narrow, flag-safe shape: it can never start with
//      "-" (git would otherwise parse it as an option, e.g. "--upload-pack=...") or
//      "/" (an absolute pathspec), and can never contain ".." range syntax we don't
//      need. execFile (no shell) already rules out shell metacharacter injection; this
//      regex guards git's OWN arg parser.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// Full/short sha or a plain ref/branch/tag name. No leading "-" (flag injection) and no
// leading "/" (an absolute-path-shaped pathspec, e.g. "/etc/passwd", would otherwise
// pass the character class below), no whitespace, no shell metacharacters (defense in
// depth even though execFile never invokes a shell), bounded length. ":" is excluded
// from the character class, which already rejects "HEAD:path"-shaped pathspecs.
const COMMITTISH_RE = /^(?![-/])[A-Za-z0-9._/-]{1,100}$/;

export function isValidCommittish(sha: string): boolean {
  return COMMITTISH_RE.test(sha) && !sha.includes("..");
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// `allowed` is the caller's already-discovered project root list (lib/server/discovery
// .ts) — the only filesystem paths this endpoint is permitted to run `git` inside.
export function isValidRepoRoot(repoRoot: string, allowed: string[]): boolean {
  const real = safeRealpath(repoRoot);
  if (!real) return false;
  const matches = allowed.some((a) => safeRealpath(a) === real);
  if (!matches) return false;
  return fs.existsSync(path.join(real, ".git"));
}

// Resolve a client-supplied, OPAQUE project id to one of the server's own discovered
// project paths. The client never gets to hand the server a filesystem path directly —
// only a key into a lookup the server itself built from discovery. Returns null for an
// unknown id or one whose discovered path doesn't independently pass isValidRepoRoot
// (defense in depth: discovery output is trusted, but re-checked anyway).
export function resolveProjectPath(projectId: string, discovered: Array<{ id: string; path: string }>): string | null {
  const match = discovered.find((p) => p.id === projectId);
  if (!match) return null;
  const allowedPaths = discovered.map((p) => p.path);
  return isValidRepoRoot(match.path, allowedPaths) ? match.path : null;
}

// `allowed` is re-checked HERE, not just by the caller — gitShow's trust boundary must
// be self-contained: any future call site that forgets to gate `repoRoot` upstream
// still can't make this function spawn `git` outside an allowed, discovered repo.
export function gitShow(repoRoot: string, committish: string, allowed: string[]): Promise<string> {
  if (!isValidRepoRoot(repoRoot, allowed)) {
    return Promise.reject(new Error(`repo root is not an allowed discovered project: ${JSON.stringify(repoRoot)}`));
  }
  if (!isValidCommittish(committish)) {
    return Promise.reject(new Error(`invalid commit-ish (rejected before spawning git): ${JSON.stringify(committish)}`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["show", "--no-color", committish],
      { cwd: repoRoot, maxBuffer: 5 * 1024 * 1024, timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(stdout);
      }
    );
  });
}
