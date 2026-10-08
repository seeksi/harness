// console/lib/sandbox/review.ts
// Gate B, daemon path: the independent Codex cross-review of a lane, recorded as the same
// artifact `/review-record` writes (mods/review-gate) and `harness.sh integ-merge` requires.
// Independence is the point (cross-review skill rule 1): Codex gets ONLY the lane's diff and
// its one-line brief — never the build agent's output, reasoning, or this daemon's view.
// NOT an MCP/memory boundary change (rule 5): nothing here reaches the build agent; the
// review runs daemon-side after the lane is committed, with the operator's own codex login.
import { execFile as nodeExecFile, type ExecFileException, type ExecFileOptions } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export type ReviewVerdict = "PASS" | "BLOCK" | "ERROR";

export interface ReviewResult {
  verdict: ReviewVerdict;
  /** feat/<slug> HEAD the verdict is about (undefined only when it could not be resolved). */
  sha?: string;
  /** One line for the gate event: the reviewer's risk line, or why no verdict was reached. */
  summary: string;
}

/** The daemon's seam: the real reviewLane in prod, a stub under the test seam. */
export type ReviewLaneFn = (input: ReviewLaneInput, deps?: ReviewDeps) => Promise<ReviewResult>;

export interface ReviewLaneInput {
  slug: string;
  /** The lane's one-line spec — the ONLY context Codex gets beside the diff. */
  brief: string;
  /** Base branch the lane diverged from (default HARNESS_BASE || main). */
  base?: string;
  /** Target repo root (default HARNESS_REPO || cwd). */
  repoRoot?: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecFn = (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBuffer: number }) => Promise<ExecResult>;

export interface ReviewDeps {
  /** Injectable process runner (tests). Default: child_process.execFile, shell:false. */
  exec?: ExecFn;
  /** Where the verdict artifact goes (default HARNESS_REVIEWS_DIR || ~/.gantry/reviews). */
  reviewsDir?: string;
  /** codex binary (default AGENT_CODEX_PATH || "codex"). */
  codexPath?: string;
  /** Codex wall-clock budget (default 10 min). */
  timeoutMs?: number;
  /** Optional model override passed as `-m`. */
  model?: string;
}

// The reviewer's whole job — verbatim from .claude/skills/cross-review/SKILL.md step 2.
export const REVIEWER_INSTRUCTIONS = [
  "You are an independent code reviewer from a different provider than the author.",
  "You are given a diff and the spec it must satisfy — nothing else. Review across",
  "four lenses and report findings only; do not rewrite the code.",
  "  SECURITY: injection, authz/authn gaps, secrets, unsafe deserialization, SSRF.",
  "  PERFORMANCE: N+1 queries, unbounded loops/memory, missing indexes, sync-in-hot-path.",
  "  TESTING: untested branches, missing edge/error cases, assertions that prove nothing.",
  "  ARCHITECTURE: spec mismatch, leaky boundaries, duplicated logic, footguns for callers.",
  "For each finding output: SEVERITY (Critical/High/Medium/Low) | LENS | file:line |",
  "one-line problem | one-line fix. End with ONE line, exactly `VERDICT: PASS` or",
  "`VERDICT: BLOCK` — BLOCK if any finding is High or Critical, PASS otherwise.",
  "Be terse. Flag spec violations as at least High. Do not praise.",
].join("\n");

// A diff past this is not reviewed (the reviewer's context, and argv, are finite): ERROR,
// never a silent PASS. ponytail: chunk-and-merge reviews when a real lane hits it.
export const MAX_DIFF_CHARS = 400_000;

const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    const options: ExecFileOptions = { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, timeout: opts.timeoutMs, maxBuffer: opts.maxBuffer, shell: false };
    nodeExecFile(cmd, args, options, (err: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      // A nonzero exit carries a numeric code; a spawn failure/timeout a string code (ENOENT…) → 1.
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

// The verdict is the LAST `VERDICT:` line; a reviewer that never says one yields ERROR.
export function parseVerdict(text: string): { verdict: ReviewVerdict; summary: string } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\**VERDICT:?\**\s*:?\s*(PASS|BLOCK)\b/i.exec(lines[i] ?? "");
    if (m) {
      const verdict = (m[1] ?? "").toUpperCase() as "PASS" | "BLOCK";
      // The findings above the verdict, compressed to one line for the gate summary.
      const findings = lines.slice(0, i).filter((l) => /^(Critical|High|Medium|Low)\b/i.test(l));
      const summary = verdict === "PASS"
        ? `cross-review PASS (${findings.length} non-blocking finding${findings.length === 1 ? "" : "s"})`
        : `cross-review BLOCK: ${findings.find((l) => /^(Critical|High)\b/i.test(l)) ?? findings[0] ?? "see reviewer output"}`;
      return { verdict, summary: summary.slice(0, 500) };
    }
  }
  return { verdict: "ERROR", summary: "reviewer produced no VERDICT line" };
}

/**
 * Review feat/<slug> against its base: resolve the lane HEAD, take the diff, run Codex in a
 * fresh read-only session with ONLY the brief + diff, parse the verdict, and record it under
 * reviewsDir/<sha>.json so integ-merge (and the review-gate mod) honour it. FAILS CLOSED:
 * any error → ERROR with no artifact, which integ-merge then refuses.
 */
export async function reviewLane(input: ReviewLaneInput, deps: ReviewDeps = {}): Promise<ReviewResult> {
  const exec = deps.exec ?? defaultExec;
  const repoRoot = path.resolve(input.repoRoot ?? process.env.HARNESS_REPO ?? process.cwd());
  const base = input.base ?? process.env.HARNESS_BASE ?? "main";
  const ref = `feat/${input.slug}`;
  const reviewsDir = deps.reviewsDir ?? process.env.HARNESS_REVIEWS_DIR ?? path.join(os.homedir(), ".gantry", "reviews");
  const codexPath = deps.codexPath ?? process.env.AGENT_CODEX_PATH ?? "codex";
  const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
  // Codex needs its own login (~/.codex) and PATH; nothing else from the server leaks.
  const env: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "LANG", "TZ"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  const git = (args: string[]) => exec("git", args, { cwd: repoRoot, env, timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 });

  const head = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (head.code !== 0) return { verdict: "ERROR", summary: `cannot resolve ${ref}` };
  const sha = head.stdout.trim();

  const diff = await git(["diff", `${base}...${ref}`]);
  if (diff.code !== 0) return { verdict: "ERROR", sha, summary: `git diff ${base}...${ref} failed: ${diff.stderr.trim().slice(0, 200)}` };
  if (diff.stdout.trim() === "") return { verdict: "ERROR", sha, summary: `${ref} has an empty diff against ${base}` };
  if (diff.stdout.length > MAX_DIFF_CHARS) return { verdict: "ERROR", sha, summary: `diff too large to review (${diff.stdout.length} chars > ${MAX_DIFF_CHARS})` };

  const prompt = `${REVIEWER_INSTRUCTIONS}\n\nSPEC:\n${input.brief}\n\nDIFF:\n${diff.stdout}`;
  const last = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gantry-review-")), "last.md");
  const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-C", repoRoot, "-o", last];
  if (deps.model) args.push("-m", deps.model);
  args.push(prompt);
  const run = await exec(codexPath, args, { cwd: repoRoot, env, timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  let text = "";
  try { text = fs.readFileSync(last, "utf8"); } catch { /* fall through to stdout */ }
  if (text.trim() === "") text = run.stdout;
  try { fs.rmSync(path.dirname(last), { recursive: true, force: true }); } catch { /* best-effort */ }
  if (run.code !== 0 && text.trim() === "") {
    return { verdict: "ERROR", sha, summary: `codex exited ${run.code}: ${run.stderr.trim().slice(0, 200) || "no output"}` };
  }
  const { verdict, summary } = parseVerdict(text);
  if (verdict === "ERROR") return { verdict, sha, summary };

  // The artifact integ-merge and the review-gate mod read; written for BLOCK too (a record),
  // but only PASS with a matching head unlocks a merge.
  fs.mkdirSync(reviewsDir, { recursive: true });
  const rec = { verdict, head: sha, ref, at: new Date().toISOString(), reviewer: "codex-daemon", summary };
  fs.writeFileSync(path.join(reviewsDir, `${sha}.json`), JSON.stringify(rec) + "\n");
  return { verdict, sha, summary };
}
