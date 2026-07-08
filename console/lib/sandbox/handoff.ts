// console/lib/sandbox/handoff.ts
// Context-guard handoff-respawn support for the daemon build phase (ported from
// web/lib/daemon/daemon.ts). A one-shot `claude -p` build agent cannot observe its own
// token count mid-run, so the in-run signal is the agent's JUDGMENT: the CONTEXT_GUARD_PROMPT
// tells a lane that judges it can't finish comfortably to write HANDOFF.md and STOP; the
// daemon then respawns a FRESH agent in the SAME worktree with that handoff inlined. This
// module owns the pure, testable pieces of that loop — the guard prompt, prompt composition,
// the inline cap, the respawn clamp — plus the real filesystem/git HandoffFs the daemon uses.
//
// TRACKED-FILE HAZARD (differs from web/): THIS repo TRACKS HANDOFF.md at the repo root, so
// every lane worktree already contains it at checkout. The respawn trigger is therefore NOT
// bare existence — read() returns content ONLY when `git status --porcelain -- HANDOFF.md`
// shows the agent actually wrote/modified it (tracked-and-unchanged ⇒ null).
//
// FAIL-CLOSED RULE (cross-review r1): whenever that porcelain status is NON-EMPTY, the
// worktree copy of HANDOFF.md is agent-controlled and MUST be neutralized before it can
// reach wt-commit — a readable regular file is archived out (read() → archive()/sweep()),
// and anything else (deleted, renamed, symlink, FIFO, unreadable) is neutralized inside
// read()/sweep() themselves: remove/move the node WITHOUT following it, then restore the
// HEAD baseline into BOTH the index and the worktree. If neutralization fails, we THROW —
// a polluted lane must fail, never merge.
//
// ponytail: no live mid-run token enforcement for sandboxed agents (the judgment prompt is the
// only in-run signal; the MEASURED usage ratio only exists at completion and is logged there).

import { execFileSync } from "child_process";
import { constants as fsConstants, fstatSync, mkdirSync, renameSync, lstatSync, realpathSync, rmSync, openSync, readSync, closeSync } from "fs";
import type { Stats } from "fs";
import path from "path";
import { worktreePathFor } from "./worktree";
import { isLane } from "@/lib/bridge/registry";

// Length-cap the brief before it becomes the agent prompt. This cap alone does NOT
// guarantee the COMPOSED lane prompt stays under agent-runner's MAX_PROMPT (100k chars)
// once a handoff is inlined — buildLanePrompt enforces the combined budget below.
const MAX_BRIEF = 90_000;

// Mirror of agent-runner.ts's MAX_PROMPT (source: console/lib/sandbox/agent-runner.ts,
// `const MAX_PROMPT = 100_000` — not exported there; keep in sync). buildLanePrompt
// budgets against it and asserts the composed prompt stays strictly under it, so a
// legitimate respawn can never turn into an AgentExecError lane failure.
const MAX_PROMPT = 100_000;
// Headroom under MAX_PROMPT for anything not counted explicitly (off-by-few joins etc.).
const PROMPT_SAFETY_MARGIN = 500;

/**
 * Compose the headless build agent's prompt from the run brief. The agent runs in DIRECT
 * mode with the FULL toolset (incl. Bash) inside the lane worktree, so the prompt tells it
 * to implement in-place and verify with the project's own tooling — and, crucially, to NOT
 * commit: the harness commits the lane afterwards (wt-commit), and an agent `git commit`
 * would leave nothing for wt-commit to stage → Gate B would misfire. The brief is opaque
 * task text (never provenance) and is length-capped here. (Lives here, alongside the other
 * prompt-composition helpers, mirroring buildDecomposePrompt in sandbox/decompose.ts.)
 */
export function buildAgentPrompt(brief: string): string {
  const task = (typeof brief === "string" ? brief : "").slice(0, MAX_BRIEF);
  return [
    "Implement the following task IN THIS WORKTREE (your current working directory).",
    "You have the FULL toolset, including Bash — use it to run the project's own",
    "tests, build, and lint to verify your work as you go.",
    "",
    "TASK:",
    task,
    "",
    "RULES:",
    "- Make all changes inside the current working directory only.",
    "- Verify your work by running the project's own tests/build before finishing.",
    "- DO NOT run `git commit` or `git add`. The harness commits your lane after you",
    "  finish; committing yourself will break the commit/verify step (wt-commit).",
    "Finish once the task is implemented and its tests/build pass.",
  ].join("\n");
}

// Context-management: a judgment-based handoff instruction appended to every lane prompt.
// Adapts web/'s CONTEXT_GUARD_PROMPT wording, kept consistent with buildAgentPrompt's own
// "do NOT git commit" rule (the agent writes HANDOFF.md in its cwd and stops — the harness
// owns version control).
export const CONTEXT_GUARD_PROMPT = `
## Context budget (mandatory)
You have a finite context window. If you judge you cannot FINISH this task
comfortably (roughly: you've done a lot of reading/editing and are still far from
done), STOP and hand off instead of degrading:
1. Write HANDOFF.md in your working directory with sections:
   Current state / Decisions / Files touched / Next steps / Dead ends.
2. Then stop immediately. Do NOT start new edits, and do NOT run \`git commit\` or
   \`git add\` after writing HANDOFF.md — the harness handles version control.
A fresh agent will be started with your HANDOFF.md. Prefer a clean handoff over a
rushed, broken finish.`;

// Upper bound when inlining the previous attempt's HANDOFF.md into the respawn prompt
// (head-preserving truncate). NOT independently "safe": MAX_BRIEF + this cap + wrapper
// text can exceed MAX_PROMPT, so buildLanePrompt shrinks the inlined handoff further to
// whatever budget actually remains after the base prompt and the guard.
export const HANDOFF_INLINE_CAP = 20_000;

const HANDOFF_HEADER = "\n\n## Handoff from the previous agent (continue from here)\n";

/**
 * The lane build agent's prompt, composing over buildAgentPrompt: the base build prompt,
 * then (on a respawn) the previous attempt's HANDOFF.md head-truncated to fit, then the
 * context-guard instruction. The inlined handoff gets min(HANDOFF_INLINE_CAP, remaining
 * MAX_PROMPT budget) so a maximal brief + maximal handoff still composes under
 * agent-runner's MAX_PROMPT (asserted). Pure — unit-tested without a worktree.
 */
export function buildLanePrompt(brief: string, handoff?: string): string {
  const base = buildAgentPrompt(brief);
  let inlined = "";
  if (handoff) {
    // Budget remaining for the handoff body once everything that must ride along is
    // accounted for: base prompt, handoff header + trailing newline, the "\n" separator,
    // the guard, and a safety margin.
    const remaining =
      MAX_PROMPT - PROMPT_SAFETY_MARGIN - base.length - HANDOFF_HEADER.length - CONTEXT_GUARD_PROMPT.length - 2;
    const budget = Math.max(0, Math.min(HANDOFF_INLINE_CAP, remaining));
    inlined = `${HANDOFF_HEADER}${handoff.slice(0, budget)}\n`;
  }
  const composed = `${base}${inlined}\n${CONTEXT_GUARD_PROMPT}`;
  if (composed.length >= MAX_PROMPT) {
    // Cannot happen with the budget above — assert so a drift in the mirrored constant
    // or wrapper text fails HERE (clear) instead of as an AgentExecError at spawn.
    throw new Error(`composed lane prompt too large (${composed.length} >= ${MAX_PROMPT} chars)`);
  }
  return composed;
}

/**
 * Max fresh-agent respawns per lane after a clean handoff (HANDOFF.md + exit 0), from
 * CONTEXT_MAX_HANDOFFS (default 2, clamp 0..5; 0 disables respawn). Read per call (not at
 * module load) so the operator/tests can vary it without a reload — mirrors laneConcurrency().
 * NOTE (differs from web/'s guard expression): a finite PARSED value is CLAMPED into 0..5
 * (so -1 ⇒ 0, 7 ⇒ 5); the env string is trimmed first, and unset / empty / whitespace /
 * non-numeric junk all fall back to the default 2 (Number("") is 0 — never let a blank
 * value accidentally DISABLE respawn).
 */
export function maxHandoffs(): number {
  const s = (process.env.CONTEXT_MAX_HANDOFFS ?? "").trim();
  if (s === "") return 2; // unset / blank → default
  const raw = Number(s);
  if (!Number.isFinite(raw)) return 2; // junk → default
  return Math.min(5, Math.max(0, Math.floor(raw))); // clamp 0..5 (negatives → 0)
}

/**
 * Handoff-file access for the respawn loop (injectable so the daemon's tests avoid real
 * worktrees + git). read() detects an agent-written HANDOFF.md; archive() moves it OUT of
 * the worktree; sweep() archives any leftover before the worker returns.
 */
export type HandoffFs = {
  /** The agent-written handoff content for `slug`, or null when the agent wrote none. */
  read(slug: string): string | null;
  /** Move this attempt's HANDOFF.md OUT of the worktree (throws ⇒ the lane fails). */
  archive(slug: string, attempt: number): void;
  /** Archive any leftover agent-written HANDOFF.md (read-then-archive); a no-op when none. */
  sweep(slug: string, attempt: number): void;
};

// Repo root = the cwd the daemon/harness runs from, derived ONCE like worktree.ts (fixed
// boundary, not per-call env). Archived handoffs land under <repoRoot>/data/handoffs — data/
// is gitignored at the repo root, so a moved handoff can never be committed on any branch.
const REPO_ROOT_ABS = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
const HANDOFF_ARCHIVE_DIR = path.join(REPO_ROOT_ABS, "data", "handoffs");

// Never load an oversized HANDOFF.md whole (memory exhaustion): past this size only the
// first HANDOFF_INLINE_CAP bytes are read — the prompt inlines at most that much anyway.
const MAX_HANDOFF_WHOLE_READ = 1024 * 1024; // 1 MiB

/** Lane-provenance gate for every HandoffFs entry point — same boundary rule as the other
 *  sandbox boundaries (worktree.ts containedWorktree / relocateTrace): reject unminted
 *  slugs BEFORE any path join. */
function assertLaneSlug(slug: string): void {
  if (!isLane(slug)) {
    throw new Error(`unminted lane slug (handoff provenance check failed): ${JSON.stringify(slug)}`);
  }
}

/** `git status --porcelain -- HANDOFF.md` for a worktree; "" when clean/absent. stderr is
 *  ignored — the caller distinguishes clean-vs-error via the return value / a thrown exec. */
function handoffStatus(worktree: string): string {
  return execFileSync("git", ["-C", worktree, "status", "--porcelain", "--", "HANDOFF.md"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Staged-RENAME targets of HANDOFF.md (cross-review r2): `git mv HANDOFF.md OTHER.md`
 * splits into `D HANDOFF.md` + `A OTHER.md` under a pathspec (pathspec filtering disables
 * rename pairing), so restoring HANDOFF.md alone would leave the target staged for
 * wt-commit. The FULL porcelain status pairs them as one `R` entry — but ONLY when git's
 * similarity detection fires (content close to HEAD's HANDOFF.md). A dissimilar rename is
 * emitted by git as a plain `A <other>` indistinguishable from any agent-created file:
 * that case is provably undetectable here and is ordinary lane content for review to
 * judge — the neutralization guarantee is BY PATH (plus detectable renames), by design.
 * Must be collected BEFORE restoreBaseline: restoring HANDOFF.md's index entry breaks the
 * rename pair and the target degrades to an untraceable `A`.
 * -z rename entry layout: `XY <target>\0<orig>\0` (target FIRST, orig in the next field).
 */
function handoffRenameTargets(worktree: string): string[] {
  // -c status.renames=true: an operator's `status.renames=false` (a common perf setting)
  // would silence the R pairing and let a detectable rename degrade to a plain `A`.
  const out = execFileSync("git", ["-C", worktree, "-c", "status.renames=true", "status", "--porcelain", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const fields = out.split("\0");
  const targets: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    if (entry[0] !== "R" && entry[0] !== "C") continue;
    const target = entry.slice(3);
    const orig = fields[i + 1] ?? "";
    i++; // consume the orig field of every rename/copy entry
    if (orig === "HANDOFF.md") targets.push(target);
  }
  return targets;
}

/** Restore HANDOFF.md to its HEAD baseline in BOTH the index AND the worktree. A plain
 *  `git checkout -- HANDOFF.md` restored from the INDEX — an agent that ran
 *  `git add HANDOFF.md` would leave staged agent content for wt-commit to commit.
 *  `git restore --source=HEAD --staged --worktree` returns both to HEAD and also handles
 *  an agent-controlled delete/rename/typechange. Throws on failure (fail closed). */
function restoreBaseline(worktree: string): void {
  execFileSync(
    "git",
    ["-C", worktree, "restore", "--source=HEAD", "--staged", "--worktree", "--", "HANDOFF.md"],
    { stdio: "ignore" }
  );
}

/**
 * Neutralize the worktree copy of HANDOFF.md so nothing agent-controlled can reach
 * wt-commit: a regular file is archived out under <repoRoot>/data/handoffs (rename — no
 * read permission needed), any other node (symlink/FIFO/dir) is REMOVED without being
 * followed (an archived symlink would stay live under the repo), and a tracked file's
 * HEAD baseline is then restored into both the index and the worktree. Detectable staged
 * RENAME targets of HANDOFF.md get the same treatment (archive/remove + drop from the
 * index) so handoff content can't ride into wt-commit under another name. Throws on any
 * failure — a lane whose HANDOFF.md cannot be neutralized must fail, never merge.
 */
function neutralizeHandoff(slug: string, label: string): void {
  const wt = worktreePathFor(slug);
  const src = path.join(wt, "HANDOFF.md");
  // Rename targets MUST be collected before restoreBaseline: restoring HANDOFF.md's index
  // entry breaks the rename pair and the target degrades to an untraceable plain `A`.
  const targets = handoffRenameTargets(wt);
  // An untracked HANDOFF.md ("??") has no baseline to restore — moving it out is enough.
  const tracked = !handoffStatus(wt).startsWith("??");
  let st: Stats | null = null;
  try {
    st = lstatSync(src);
  } catch {
    st = null; // deleted / renamed away — nothing at the path to move
  }
  if (st?.isFile()) {
    mkdirSync(HANDOFF_ARCHIVE_DIR, { recursive: true });
    renameSync(src, path.join(HANDOFF_ARCHIVE_DIR, `${slug}.HANDOFF.${label}.md`));
  } else if (st) {
    rmSync(src, { recursive: true, force: true }); // non-regular: remove, never archive
  }
  if (tracked) restoreBaseline(wt);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    // Target paths come from git status output but are AGENT-CHOSEN: contain them to the
    // worktree before any filesystem op (same boundary rule as worktree.ts
    // containedWorktree), and never echo the name into errors/logs — only harness fields.
    const abs = path.resolve(wt, t);
    if (!abs.startsWith(wt + path.sep)) {
      throw new Error(`handoff rename target #${i} escapes the worktree (lane ${slug})`);
    }
    // Lexical containment is not enough: an INTERMEDIATE component can be a symlink out of
    // the worktree — `git mv` refuses paths beyond a symlink, but a Bash-capable agent can
    // craft the index entry directly (`update-index --cacheinfo`; produces a real R pairing,
    // verified live), and lstat/rename/rm all FOLLOW intermediate symlinks. Re-check the
    // REAL parent; a missing parent is fine (index-only entry — lstat below finds nothing
    // and only the index cleanup runs).
    let realParent: string | null = null;
    try {
      realParent = realpathSync(path.dirname(abs));
    } catch {
      realParent = null;
    }
    if (realParent !== null) {
      const wtReal = realpathSync(wt);
      if (realParent !== wtReal && !realParent.startsWith(wtReal + path.sep)) {
        throw new Error(`handoff rename target #${i} has a symlink ancestor escaping the worktree (lane ${slug})`);
      }
    }
    try {
      let ts: Stats | null = null;
      try {
        ts = lstatSync(abs);
      } catch {
        ts = null;
      }
      if (ts?.isFile()) {
        mkdirSync(HANDOFF_ARCHIVE_DIR, { recursive: true });
        renameSync(abs, path.join(HANDOFF_ARCHIVE_DIR, `${slug}.HANDOFF.${label}.renamed-${i}.md`));
      } else if (ts) {
        rmSync(abs, { recursive: true, force: true }); // non-regular: remove, never archive
      }
      // Staged-new target: this exits 0 and removes it from the index (verified, git 2.53).
      // :(literal) pathspec magic — the agent-chosen name must never act as a wildcard (a
      // target literally named `*` would otherwise restore the WHOLE worktree to HEAD,
      // silently destroying the lane's build output; verified live).
      execFileSync(
        "git",
        ["-C", wt, "restore", "--source=HEAD", "--staged", "--worktree", "--", `:(literal)${t}`],
        { stdio: "ignore" }
      );
    } catch (err) {
      // Sanitized rethrow: FS/git error messages embed the agent-chosen path — surface
      // only harness-controlled fields. Fail closed: the lane still dies.
      const code = (err as NodeJS.ErrnoException | null)?.code;
      throw new Error(
        `handoff rename-target #${i} neutralization failed (lane ${slug}${code ? `, ${code}` : ""})`
      );
    }
  }
}

function readHandoff(slug: string): string | null {
  assertLaneSlug(slug);
  const wt = worktreePathFor(slug);
  let status: string;
  try {
    status = handoffStatus(wt);
  } catch {
    // git unavailable / not a worktree — fail SAFE (no respawn). In production HANDOFF.md is
    // tracked, so an untouched file stays clean and wt-commit never sees handoff pollution.
    return null;
  }
  if (status.trim() === "") return null; // tracked-and-unchanged (or absent) — no agent handoff

  // Porcelain NON-EMPTY ⇒ the agent touched HANDOFF.md. FAIL CLOSED from here: a readable
  // regular file is returned for the caller's archive()/sweep() to move out, and EVERY
  // other state is neutralized before this returns (a neutralization failure THROWS).
  const p = path.join(wt, "HANDOFF.md");
  let st: Stats | null = null;
  try {
    st = lstatSync(p);
  } catch {
    st = null; // deleted / renamed away
  }

  if (st && !st.isFile()) {
    // Symlink/FIFO/dir/other (confused deputy): NEVER read or follow it — remove the node
    // itself and restore the baseline. Lane slug only in the log, never file content.
    console.error(`[handoff] lane ${slug}: HANDOFF.md is not a regular file — refusing to read it; neutralizing`);
    neutralizeHandoff(slug, `nonregular-${Date.now()}`);
    return null;
  }

  if (st === null) {
    // Agent-controlled deletion/rename: restore the HEAD baseline into index + worktree
    // so wt-commit can never commit it. Throws on failure (fail closed).
    neutralizeHandoff(slug, `restored-${Date.now()}`);
    return null;
  }

  // Regular file per lstat — but open-by-fd with O_NOFOLLOW and fstat THE FD so the node
  // we read is provably the node we opened (no lstat→open swap window; a symlink swapped
  // in makes openSync throw ELOOP → unreadable path). O_NONBLOCK keeps a swapped-in FIFO
  // from hanging the open. Size-capped: an oversized handoff is read head-only, never
  // whole. Neutralization happens AFTER the try/finally so a neutralize throw is never
  // swallowed by the IO catch (fail closed).
  let text: string | null = null;
  let failure: "nonregular" | "unreadable" | null = null;
  try {
    const fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile()) {
        failure = "nonregular";
      } else {
        const cap = fst.size > MAX_HANDOFF_WHOLE_READ ? HANDOFF_INLINE_CAP : Number(fst.size);
        const buf = Buffer.alloc(cap);
        const n = readSync(fd, buf, 0, cap, 0);
        text = buf.subarray(0, n).toString("utf8");
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    failure = "unreadable";
  }
  if (failure !== null) {
    // Unreadable / swapped non-regular: neutralize NOW (rename needs no read permission)
    // so the agent copy can never reach wt-commit; nothing to inline ⇒ null.
    console.error(`[handoff] lane ${slug}: HANDOFF.md ${failure} — neutralizing it unread`);
    neutralizeHandoff(slug, `${failure}-${Date.now()}`);
    return null;
  }
  if (text === null || text.trim() === "") {
    // Empty/whitespace handoff: still agent-touched (porcelain dirty) so it MUST be
    // neutralized — bare-returning "" would leave the file dirty for wt-commit — and
    // returning null (not "") keeps the sweep/respawn path from a wasted respawn.
    neutralizeHandoff(slug, `empty-${Date.now()}`);
    return null;
  }
  return text;
}

function archiveHandoff(slug: string, attempt: number): void {
  assertLaneSlug(slug);
  neutralizeHandoff(slug, String(attempt));
}

export const defaultHandoffFs: HandoffFs = {
  read: readHandoff,
  archive: archiveHandoff,
  sweep(slug, attempt) {
    assertLaneSlug(slug);
    // read() itself neutralizes every dirty-but-unarchivable state (deleted/symlink/
    // unreadable), so after this pair the porcelain status is clean on EVERY path.
    if (readHandoff(slug) !== null) archiveHandoff(slug, attempt);
  },
};

// ponytail: archive uses renameSync (same-filesystem move — worktrees + repo root share one
// device here). skipped: cross-device (EXDEV) copy+unlink fallback; add if data/ is ever a
// separate mount (a rename throw currently fails the lane, which is the intended fail-closed).
