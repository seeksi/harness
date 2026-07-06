// console/lib/sandbox/worktree.ts
// Worktree CONFINEMENT primitives for the safe agent sandbox. In drop mode the agent's
// filesystem jail is a dedicated low-priv OS account whose only writable area is the
// worktrees allow-dir; these functions pin/validate that boundary so a lane's cwd (and the
// trace it produces) can never be redirected outside the lane's own entry — lexically AND,
// when the path exists, via realpath so a symlink can't escape. They live in the sandbox
// because containment is part of the isolation guarantee, not the daemon's orchestration.

import path from "path";
import fs from "fs";
import crypto from "crypto";
import { isLane, isSession } from "@/lib/bridge/registry";
import { AgentExecError } from "@/lib/bridge/errors";

// Worktrees allow-dir, derived ONCE at module load (NOT configurable via env, so the
// containment boundary is fixed). Layout matches parallel-build/wt.sh:
// ../<repo>.worktrees/<slug>.
const WORKTREES_DIR_ABS = (() => {
  const repoRoot = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
  return path.resolve(repoRoot, "..", `${path.basename(repoRoot)}.worktrees`);
})();

/** The deterministic worktree path for a lane (matches wt.sh's ../<repo>.worktrees/<slug>). */
export function worktreePathFor(slug: string): string {
  return path.join(WORKTREES_DIR_ABS, slug);
}

// Repo root = the cwd harness.sh runs from (where `harness.sh trace` looks for the
// trace), derived ONCE like WORKTREES_DIR_ABS. Same fixed boundary, not per-call env.
const REPO_ROOT_ABS = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
// A session id becomes a filename component below — re-validate to the trace-session
// shape (defense in depth beneath isSession) so it can't contain path parts.
const SESSION_PATH_RE = /^[A-Za-z0-9_-]{1,64}$/;
// A trace is one JSONL line per tool call; anything past this is a runaway, not a
// trajectory to score — refuse rather than copy GBs into the repo (and block the daemon).
const MAX_TRACE_BYTES = 10 * 1024 * 1024;

/**
 * Relocate a lane's agent trace into the main repo so the trace gate can read it.
 * The eval-gate PostToolUse hook writes `.claude/traces/<session>.jsonl` relative to
 * the agent's cwd — i.e. INSIDE the lane worktree — but `harness.sh trace` runs from
 * the repo root and reads the repo-root copy. Copy worktree → repo root. Returns true
 * if a trace was found and copied; false if the agent produced none (made no tool
 * calls) — the daemon then skips the (now-empty) trace gate.
 *
 * Both slug and session are server provenance (minted) AND the session is re-checked
 * to the path-safe shape. The agent controls the worktree, so the source is hardened:
 * its REAL path must stay inside the lane worktree (a symlink can't redirect the copy
 * to a host file), it must be a regular file, and it must be under the size cap.
 */
export function relocateTrace(slug: string, sessionId: string): boolean {
  if (!isLane(slug)) {
    throw new AgentExecError(`unminted lane slug (provenance check failed): ${JSON.stringify(slug)}`);
  }
  if (!isSession(sessionId)) {
    throw new AgentExecError(`unminted session id (provenance check failed): ${JSON.stringify(sessionId)}`);
  }
  if (!SESSION_PATH_RE.test(sessionId)) {
    throw new AgentExecError(`invalid session id (cannot be a path): ${JSON.stringify(sessionId)}`);
  }
  const wtBase = worktreePathFor(slug);
  const src = path.join(wtBase, ".claude", "traces", `${sessionId}.jsonl`);
  if (!fs.existsSync(src)) return false;
  // Symlink hardening: resolve the REAL source and require it to be exactly the lane's
  // own trace file — a symlink (the file, .claude, or traces) pointing elsewhere is
  // rejected so the agent can't exfiltrate a host file into the repo via the copy.
  const realSrc = fs.realpathSync(src);
  const expected = path.join(fs.realpathSync(wtBase), ".claude", "traces", `${sessionId}.jsonl`);
  if (realSrc !== expected) {
    throw new AgentExecError(`trace resolves outside the lane worktree (symlink?): ${JSON.stringify(slug)}`);
  }
  const st = fs.statSync(realSrc);
  if (!st.isFile()) throw new AgentExecError("trace source is not a regular file");
  if (st.size > MAX_TRACE_BYTES) {
    throw new AgentExecError(`trace too large (${st.size} bytes) — runaway agent?`);
  }
  const destDir = path.join(REPO_ROOT_ABS, ".claude", "traces");
  fs.mkdirSync(destDir, { recursive: true });
  // DESTINATION containment (fail closed). The build agent runs Bash in DIRECT mode (as the
  // operator), so it CAN plant a symlink at the dest dir (or the dest file) to turn the
  // daemon's trace copy into an arbitrary write as the daemon user. Resolve the dest dir's
  // REAL path and require it to be EXACTLY <realpath(REPO_ROOT)>/.claude/traces — a symlinked
  // dir or any symlinked ancestor that escapes the repo is rejected.
  const expectedDestDir = path.join(fs.realpathSync(REPO_ROOT_ABS), ".claude", "traces");
  const realDestDir = fs.realpathSync(destDir);
  if (realDestDir !== expectedDestDir) {
    throw new AgentExecError("destination traces dir resolves outside the repo (symlink?)");
  }
  // Atomic, no-follow write (closes the check→copy TOCTOU). A path-based copyFileSync would
  // re-resolve the dest and could follow a symlink swapped in — by a DETACHED background
  // process the Bash/direct-mode agent may have left behind — between an lstat check and the
  // copy. Instead: read the already-validated source (realpath-resolved, regular file, size-
  // capped above), write it into a uniquely-named temp file in the REAL dest dir with 'wx'
  // (O_CREAT|O_EXCL — never follows a final-component symlink, fails if present), then
  // renameSync it over the dest. rename replaces a dest symlink ATOMICALLY without ever
  // writing through it, so there is no window in which a swapped-in link redirects the write.
  const data = fs.readFileSync(realSrc);
  const destFile = path.join(realDestDir, `${sessionId}.jsonl`);
  const tmp = path.join(realDestDir, `.${sessionId}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, destFile);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; the real error is the rename failure */
    }
    throw e;
  }
  return true;
  // ponytail: the dest-DIR is pinned by realpath, not a held dirfd — a full openat/O_NOFOLLOW
  // chain would also close a (far more exotic) dir-inode swap race. skipped: dirfd anchoring;
  // add if the threat model ever assumes a privileged concurrent writer in the repo root.
}

/**
 * Resolve + assert a worktree path is exactly the lane's entry under the allow-dir
 * (provenance: the slug must be minted; containment: the path can't escape — lexically
 * AND, when the path exists, via realpath so a symlink can't redirect it outside).
 * Exported so the containment guarantee is unit-tested.
 */
export function containedWorktree(slug: string, worktreePath: string): string {
  if (!isLane(slug)) {
    throw new AgentExecError(`unminted lane slug (provenance check failed): ${JSON.stringify(slug)}`);
  }
  if (typeof worktreePath !== "string") {
    throw new AgentExecError(`invalid worktree path: ${JSON.stringify(worktreePath)}`);
  }
  const abs = path.resolve(worktreePath);
  const expected = path.join(WORKTREES_DIR_ABS, slug);
  if (abs !== expected) {
    throw new AgentExecError(`worktree path escapes the lane allow-dir: ${JSON.stringify(worktreePath)}`);
  }
  // Symlink hardening: if it exists, the REAL path must still be the lane's real entry.
  if (fs.existsSync(abs)) {
    const realBase = fs.existsSync(WORKTREES_DIR_ABS) ? fs.realpathSync(WORKTREES_DIR_ABS) : WORKTREES_DIR_ABS;
    if (fs.realpathSync(abs) !== path.join(realBase, slug)) {
      throw new AgentExecError(`worktree resolves outside the allow-dir (symlink?): ${JSON.stringify(worktreePath)}`);
    }
  }
  return abs;
}
