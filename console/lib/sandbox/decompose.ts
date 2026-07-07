// console/lib/sandbox/decompose.ts
// The LLM DECOMPOSE step: turn ONE run brief into 1..4 disjoint, independently-buildable
// lane briefs, produced by a READ-ONLY headless Claude agent that runs BEFORE planRun and
// feeds the existing multi-lane machinery. It is a sibling of agent-runner's build agent and
// shares its isolation primitives (buildInvocation + ensureAgentHome, the ENABLE_AGENT_EXEC
// gate, the credential-free minimal env, the process-group timeout, the fail-closed pre-spawn
// audit). Three DELIBERATE departures make it strictly SAFER than the build agent:
//   - a READ-ONLY toolset (Read,Grep,Glob) — NEVER Bash/Edit/Write, so it can never mutate the
//     repo it is exploring;
//   - it runs at the REPO ROOT (not a lane worktree) because there are no lanes yet — inventing
//     them is the whole point of this step (so NO containedWorktree confinement applies);
//   - its output is PARSED + VALIDATED fail-closed (1..4 lanes, disjoint owns, no absolute /
//     escaping paths) BEFORE a single downstream side effect (planRun / worktrees) happens.
//
// Execution is REFUSED unless ENABLE_AGENT_EXEC=1 (same default-off gate as the build agent).

import { spawn as nodeSpawn, type SpawnOptions as NodeSpawnOptions, type ChildProcess } from "child_process";
import path from "path";
import { HarnessTimeoutError } from "@/lib/bridge/errors";
import { appendAudit } from "@/lib/server/persist";
import { buildInvocation, type AgentModel } from "./agent-runner";
import { ensureAgentHome } from "./agent-home";

/** Fail-closed error for the decompose step (bad gate, spawn, or an invalid/parse-broken
 *  agent output). NEVER carries the brief or a secret. */
export class DecomposeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DecomposeError";
  }
}

// READ-ONLY toolset — the decompose agent only EXPLORES. Bash/Edit/Write are intentionally
// absent: this agent must never mutate the repo it is reading. --strict-mcp-config still pins
// it to ZERO MCP servers, exactly like the build agent.
const READONLY_TOOLS = ["Read", "Grep", "Glob"];
const ALLOWED_MODELS = new Set<AgentModel>(["haiku", "sonnet", "opus"]);
const MAX_LANES = 4; // matches the daemon's LANE_CONCURRENCY clamp / planRun's 1..4 invariant
// Each composed lane brief is capped to the same ceiling as the route's per-brief cap so a
// decomposed brief could never exceed what an explicit lane brief may carry downstream.
const MAX_LANE_BRIEF = 4000;
// Fail-closed owns bounds (the owns list is agent-controlled). Cap the COUNT per lane so the
// pairwise disjointness check stays bounded (≤ MAX_LANES × MAX_OWNS_PER_LANE paths → the O(n²)
// loop can never be driven into an event-loop stall), and cap each PATH's length so a lane can
// never smuggle a megabyte of "path" past the composed-brief cap. A lane whose owns block plus a
// minimum task budget (MIN_TASK_BUDGET) cannot fit under MAX_LANE_BRIEF is rejected outright —
// the owns list is load-bearing (it scopes the build) and must never be silently truncated.
const MAX_OWNS_PER_LANE = 32;
const MAX_OWN_PATH_LEN = 256;
const MIN_TASK_BUDGET = 200;

const DEFAULT_AGENT_CLI = process.env.AGENT_CLI_PATH ?? "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.DECOMPOSE_TIMEOUT_MS) || 600_000; // 10 min
const DEFAULT_KILL_GRACE_MS = 5_000;
const MAX_OUT = 1_000_000; // bounded stdout so a runaway agent can't grow it unbounded

/**
 * Compose the READ-ONLY decompose agent's prompt. It explores the repo and must reply with
 * ONLY the lanes JSON (no prose, no fences). The brief is opaque task text (never provenance)
 * and is length-capped well under agent-runner's MAX_PROMPT.
 */
export function buildDecomposePrompt(brief: string): string {
  const task = (typeof brief === "string" ? brief : "").slice(0, 90_000);
  return [
    "You are the DECOMPOSE step of a build harness. Explore THIS repository READ-ONLY —",
    "you have ONLY Read, Grep, and Glob (no Bash, no Edit, no Write) — then split the task",
    "below into 1 to 4 lanes that can each be built AND tested INDEPENDENTLY, in parallel.",
    "",
    "TASK:",
    task,
    "",
    "RULES:",
    "- Each lane owns a DISJOINT set of files: no two lanes may name the same path, and no",
    "  lane's path may be an ancestor directory of another lane's path (a/b overlaps a/b/c).",
    '- `owns` paths are RELATIVE to the repo root (e.g. "console/lib/foo.ts"): never absolute,',
    '  never containing "..".',
    "- Each lane's `brief` states exactly what THAT lane must build and how to verify it.",
    "- Prefer FEWER lanes; only split where the work is genuinely file-disjoint.",
    "",
    "OUTPUT: reply with ONLY this JSON object — no prose, no markdown fences:",
    '{"lanes":[{"brief":"<what this lane builds + how to verify>","owns":["rel/path", "..."]}]}',
  ].join("\n");
}

/** Strip an optional ```lang … ``` markdown fence the model may add despite instructions. */
function stripFences(s: string): string {
  const t = s.trim();
  const m = t.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}

/** Validate ONE `owns` entry and return its path segments. Fail-closed: reject a non-string,
 *  empty, over-long, absolute, drive-letter/UNC/backslash, or ".."-containing path (the entry
 *  scopes a build lane, so a bad value must never pass). Rejects BOTH POSIX and Windows absolute
 *  forms: path.isAbsolute (POSIX), path.win32.isAbsolute ("\\host", "C:\\"), a bare drive-letter
 *  prefix ("C:foo"), and any backslash at all (never a legal separator in a repo-relative path).
 *  Error messages carry NO agent-controlled content — lane index + rule name only, so a
 *  planted value can never echo into daemon logs (cross-review ruling, r2). */
function pathSegments(p: unknown, laneIdx: number): string[] {
  const reject = (rule: string) =>
    new DecomposeError(`lane ${laneIdx}: owns path rejected (${rule})`);
  if (typeof p !== "string" || p.trim() === "") {
    throw reject("empty-or-non-string");
  }
  if (p.length > MAX_OWN_PATH_LEN) {
    throw reject("path-too-long");
  }
  if (p.includes("\\")) {
    throw reject("backslash");
  }
  if (path.isAbsolute(p) || path.win32.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
    throw reject("absolute-or-drive-letter");
  }
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0 || segs.includes("..")) {
    throw reject("empty-or-dotdot");
  }
  return segs;
}

/** True when `a` is `b` or an ancestor directory of `b`, compared SEGMENT-wise (so "a/b" is a
 *  prefix of "a/b/c" but NOT of "a/bc"). */
function isPrefixOrEqual(a: string[], b: string[]): boolean {
  if (a.length > b.length) return false;
  return a.every((seg, i) => seg === b[i]);
}

const OWNS_HEADER = "OWNS — modify ONLY these paths:\n";
const OWNS_SEP = "\n\n";

/** The composed-brief character budget left for the task text once this lane's owns block is
 *  accounted for. May be negative/small for a pathologically large owns list — the caller
 *  rejects any lane where this is below MIN_TASK_BUDGET (the owns list is never trimmed). */
function taskBudgetFor(owns: string[]): number {
  const ownsBlock = OWNS_HEADER + owns.map((p) => `- ${p}`).join("\n");
  return MAX_LANE_BRIEF - OWNS_SEP.length - ownsBlock.length;
}

/** Compose a lane brief = the lane's task text + its OWNS list. Capped at MAX_LANE_BRIEF by
 *  truncating ONLY the task part; the owns list is load-bearing (it scopes the build) and is
 *  never trimmed (the caller has already asserted the owns block leaves ≥ MIN_TASK_BUDGET). */
function composeLaneBrief(laneBrief: string, owns: string[]): string {
  const ownsBlock = OWNS_HEADER + owns.map((p) => `- ${p}`).join("\n");
  const budget = taskBudgetFor(owns);
  const task = budget > 0 ? laneBrief.trim().slice(0, budget) : "";
  return `${task}${OWNS_SEP}${ownsBlock}`;
}

/**
 * Parse the decompose agent's stdout into validated, composed lane briefs — fail-closed at
 * every step (the agent controls this stdout). Reads claude's `--output-format json` result
 * envelope (top-level type:"result", string `result`), strips fences, parses the inner
 * {"lanes":[…]} object, then enforces: 1..MAX_LANES lanes; each lane a non-empty `brief` +
 * a non-empty `owns` array of RELATIVE paths (no absolute / ".." / empty); and ALL owns
 * paths pairwise DISJOINT including prefix containment. Any violation throws DecomposeError.
 * Exported for unit testing without spawning claude.
 */
export function parseLaneBriefs(rawStdout: string): string[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawStdout);
  } catch {
    throw new DecomposeError("decompose agent produced no parseable JSON result");
  }
  if (!envelope || typeof envelope !== "object") {
    throw new DecomposeError("decompose result is not an object");
  }
  const env = envelope as Record<string, unknown>;
  if (env.type !== "result" || typeof env.result !== "string") {
    throw new DecomposeError('decompose result envelope missing type:"result" / string result');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(env.result));
  } catch {
    throw new DecomposeError("decompose agent output was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new DecomposeError("decompose output is not an object");
  }
  const lanes = (parsed as Record<string, unknown>).lanes;
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > MAX_LANES) {
    throw new DecomposeError(
      `decompose must yield 1..${MAX_LANES} lanes (got ${Array.isArray(lanes) ? lanes.length : typeof lanes})`
    );
  }

  const allOwns: string[][] = []; // every owns path (as segments) for the global disjointness check
  const composed: string[] = [];
  for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
    const laneRaw = lanes[laneIdx];
    if (!laneRaw || typeof laneRaw !== "object") {
      throw new DecomposeError(`lane ${laneIdx}: must be an object`);
    }
    const lane = laneRaw as Record<string, unknown>;
    if (typeof lane.brief !== "string" || lane.brief.trim() === "") {
      throw new DecomposeError(`lane ${laneIdx}: brief must be a non-empty string`);
    }
    if (!Array.isArray(lane.owns) || lane.owns.length === 0) {
      throw new DecomposeError(`lane ${laneIdx}: must own a non-empty array of paths`);
    }
    // Cap the owns COUNT before the per-path loop so the pairwise disjointness check below
    // stays bounded (fail-closed against an unbounded owns list → O(n²) event-loop stall).
    if (lane.owns.length > MAX_OWNS_PER_LANE) {
      throw new DecomposeError(`lane ${laneIdx}: too many owns paths (max ${MAX_OWNS_PER_LANE}, got ${lane.owns.length})`);
    }
    const laneOwns: string[] = [];
    for (const p of lane.owns) {
      const segs = pathSegments(p, laneIdx);
      allOwns.push(segs);
      laneOwns.push(segs.join("/"));
    }
    // Reject BEFORE composing: if the owns block alone leaves less than a minimum task budget
    // under the cap, the composed brief would either breach MAX_LANE_BRIEF or drop the (load-
    // bearing) task text. Fail closed rather than emit a degenerate lane.
    if (taskBudgetFor(laneOwns) < MIN_TASK_BUDGET) {
      throw new DecomposeError(
        `lane ${laneIdx}: owns block too large — leaves < ${MIN_TASK_BUDGET} chars for the task under the ${MAX_LANE_BRIEF}-char cap`
      );
    }
    composed.push(composeLaneBrief(lane.brief, laneOwns));
  }

  // Pairwise disjoint INCLUDING prefix containment (checked across ALL lanes' owns at once,
  // so it also catches a lane that redundantly lists both a dir and a file beneath it).
  for (let i = 0; i < allOwns.length; i++) {
    for (let j = i + 1; j < allOwns.length; j++) {
      if (isPrefixOrEqual(allOwns[i], allOwns[j]) || isPrefixOrEqual(allOwns[j], allOwns[i])) {
        throw new DecomposeError(
          `overlapping owns paths (must be file-disjoint): entries ${i} and ${j}`
        );
      }
    }
  }
  return composed;
}

export interface DecomposeOptions {
  /** The single run brief to split. Opaque task text — never audited/logged. */
  brief: string;
  /** Decompose slug (server-derived, `decomp-<sha16(runId)>`) — used for the per-run isolated
   *  HOME and the audit `slug:` field. */
  slug: string;
  /** Routed model tier for the decompose agent. */
  model: AgentModel;
  /** TEST seam: injectable spawn (real nodeSpawn in prod). */
  spawnFn?: (cmd: string, args: string[], options: NodeSpawnOptions) => ChildProcess;
  /** Wall-clock timeout (ms). Defaults to DECOMPOSE_TIMEOUT_MS or 10 min. */
  timeoutMs?: number;
}

/**
 * Run the READ-ONLY decompose agent and return the validated lane briefs. REFUSES unless
 * ENABLE_AGENT_EXEC=1. Runs at the repo root (path.resolve(HARNESS_REPO ?? cwd)) with
 * shell:false + its own process group; a timeout SIGTERM→SIGKILLs the whole group and rejects
 * HarnessTimeoutError; a nonzero exit or an unparseable/invalid output rejects DecomposeError.
 * A durable pre-spawn audit row (carrying NO brief) is mandatory — if it can't be written the
 * agent never spawns (mirrors spawnAgent's fail-closed T7 posture).
 */
export function decomposeBrief(opts: DecomposeOptions): Promise<{ laneBriefs: string[] }> {
  return new Promise((resolve, reject) => {
    const { brief, slug, model } = opts;
    const audit = (outcome: string, code: number | null, fatal = false) => {
      try {
        appendAudit({
          ts: Math.floor(Date.now() / 1000),
          cmd: "decompose",
          // Curated SAFE summary — never the brief.
          argv: [`slug:${slug}`, `model:${model ?? "sonnet"}`],
          outcome,
          code,
        });
      } catch (e) {
        // Settle-time audits are best-effort; the mandatory pre-spawn row (fatal) must persist
        // or we must NOT spawn — no unaudited decompose run.
        if (fatal) throw e;
      }
    };

    // Default-off gate — identical posture to the build agent.
    if (process.env.ENABLE_AGENT_EXEC !== "1") {
      audit("refused", null);
      reject(new DecomposeError("agent execution is disabled (ENABLE_AGENT_EXEC not set)"));
      return;
    }
    if (!ALLOWED_MODELS.has(model)) {
      audit("invalid-args", null);
      reject(new DecomposeError(`invalid model: ${JSON.stringify(model)}`));
      return;
    }
    if (typeof brief !== "string" || brief.trim() === "") {
      audit("invalid-args", null);
      reject(new DecomposeError("decompose brief must be a non-empty string"));
      return;
    }

    const args = [
      "-p",
      buildDecomposePrompt(brief),
      "--output-format",
      "json",
      "--model",
      model,
      "--allowedTools",
      READONLY_TOOLS.join(","),
      // Zero MCP (see agent-runner) and no interactive approver for the headless agent.
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
    ];
    // cwd = repo root (resolve the SAME way worktree.ts derives its roots). The agent explores
    // the whole repo read-only — there is no lane worktree yet to confine it to.
    const cwd = path.resolve(process.env.HARNESS_REPO ?? process.cwd());

    // ISOLATED HOME (direct mode): provision a fresh per-slug home unless a drop-mode user
    // (AGENT_USER, sudo -H owns HOME) or an explicit AGENT_HOME override is in effect — the
    // exact same rule spawnAgent applies. A set-but-EMPTY AGENT_HOME is a typo, refused loudly.
    const user = process.env.AGENT_USER;
    let isolatedHome: string | undefined;
    try {
      if (!user) {
        if (process.env.AGENT_HOME === "") {
          throw new DecomposeError('AGENT_HOME must be a non-empty path (or unset for the isolated-home default): ""');
        }
        if (process.env.AGENT_HOME === undefined) {
          isolatedHome = ensureAgentHome(slug);
        }
      }
    } catch (e) {
      try {
        audit("error", null, true);
      } catch (auditErr) {
        const both = new DecomposeError(
          `decompose home provisioning failed (${e instanceof Error ? e.message : String(e)}) ` +
            `AND its audit row could not be written: ${auditErr instanceof Error ? auditErr.message : String(auditErr)}`
        );
        both.cause = e;
        reject(both);
        return;
      }
      reject(e);
      return;
    }

    let inv: ReturnType<typeof buildInvocation>;
    try {
      inv = buildInvocation(DEFAULT_AGENT_CLI, args, undefined, user, isolatedHome);
    } catch (e) {
      audit("invalid-args", null);
      reject(e);
      return;
    }

    // Mandatory fail-closed pre-spawn audit (T7): a durable row MUST exist before the child runs.
    try {
      audit("spawn", null, true);
    } catch (e) {
      reject(e);
      return;
    }

    const spawnFn = opts.spawnFn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(inv.cmd, inv.argv, {
        cwd,
        shell: false, // CRITICAL: never let a shell re-parse the argv/prompt
        detached: true, // own process group → the timeout can kill the whole tree
        env: inv.spawnEnv, // minimal allowlist env — no secrets reach the agent
      });
    } catch (e) {
      audit("error", null);
      reject(e);
      return;
    }
    if (!child.stdout) {
      audit("error", null);
      reject(new DecomposeError("decompose spawn produced no stdout"));
      return;
    }
    child.stderr?.resume(); // drain so a chatty agent can't deadlock on a full pipe

    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < MAX_OUT) out += c.toString();
    });

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      action();
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), DEFAULT_KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    deadline.unref?.();

    child.on("error", (e) =>
      finish(() => {
        audit("error", null);
        reject(e);
      })
    );
    child.on("close", (code) =>
      finish(() => {
        if (timedOut) {
          audit("timeout", code);
          reject(new HarnessTimeoutError(`decompose agent '${slug}' timed out after ${timeoutMs}ms`));
          return;
        }
        if (code !== 0) {
          audit("exit", code);
          reject(new DecomposeError(`decompose agent exited nonzero (code ${code})`));
          return;
        }
        try {
          const laneBriefs = parseLaneBriefs(out);
          audit("exit", code);
          resolve({ laneBriefs });
        } catch (e) {
          audit("invalid-output", code);
          reject(e);
        }
      })
    );
  });
}

// ponytail: composeLaneBrief truncates ONLY the task text to hold the 4000-char cap; a lane whose
// owns block alone leaves < MIN_TASK_BUDGET is now REJECTED (fail closed) rather than emitting an
// over-cap or task-less brief. skipped: splitting an over-large lane into sub-lanes; add when a
// real decomposition legitimately needs >~3800 chars of paths in one lane (never seen in practice).
