// console/app/deck/lib/gitDiff.ts
// Read-only `git show` wrapper behind the per-worktree-commit diff viewer (§5/§6) — a
// TRUST BOUNDARY: operator-supplied input (repo + commit-ish) reaches a child process.
// Two independent gates, both required:
//   1. The repo must be one of the server's OWN discovered projects (never an
//      arbitrary filesystem path chosen by the request) — checked by real path so a
//      symlinked project dir can't be used to point elsewhere.
//   2. The commit-ish must match a narrow, flag-safe shape: it can never start with
//      "-" (git would otherwise parse it as an option, e.g. "--upload-pack=...") and
//      can never contain "..2" range syntax we don't need. execFile (no shell) already
//      rules out shell metacharacter injection; this regex guards git's OWN arg parser.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// Full/short sha or a plain ref/branch/tag name. No leading "-" (flag injection), no
// whitespace, no shell metacharacters (defense in depth even though execFile never
// invokes a shell), bounded length.
const COMMITTISH_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;

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

export function gitShow(repoRoot: string, committish: string): Promise<string> {
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
