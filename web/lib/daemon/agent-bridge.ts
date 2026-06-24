// web/lib/daemon/agent-bridge.ts
// Secure bridge to spawn HEADLESS Claude Code as the build agent inside a lane's
// worktree. This is the highest-risk capability in the system — an autonomous coder
// running arbitrary tools — so it mirrors harness-bridge.ts: server-built validated
// argv (never raw client strings), shell:false, a default-OFF gate, a timeout that
// process-group-kills a runaway agent, and an audit record with NO prompt/secret.
//
// NOT wired into the daemon yet, and execution is REFUSED unless ENABLE_AGENT_EXEC=1.
// Enabling it requires the agent-exec threat model gate (dedicated low-priv user,
// worktree confinement, tool allowlist, egress firewall, Max-plan auth) — see
// docs/security/threat-model-agent-exec.md.

import { spawn as nodeSpawn, type SpawnOptions as NodeSpawnOptions, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { isLane, isSession } from "./registry";
import { AgentExecError, HarnessTimeoutError } from "./errors";
import { appendAudit } from "@/lib/store/persist";

export { AgentExecError };

/** A server-built request to run the build agent in one lane's worktree. */
export interface AgentSpec {
  /** Lane slug — must be server-minted (registry.mintLane). */
  slug: string;
  /** Absolute worktree path; must be the lane's entry under the worktrees allow-dir. */
  worktreePath: string;
  /** The task prompt for the agent. Opaque text — NEVER audited or logged. */
  taskPrompt: string;
  /** Routed model tier; defaults to sonnet. */
  model?: "haiku" | "sonnet" | "opus";
  /** Claude Code tool allowlist; conservative default (no unrestricted Bash). */
  allowedTools?: string[];
}

const ALLOWED_MODELS = new Set(["haiku", "sonnet", "opus"]);
// Exact allowlist — no free-form predicates, no Bash. A Bash command-allowlist is a
// gate-config decision (threat model G1/G9), deliberately not reachable here.
const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Grep", "Glob"];
const ALLOWED_TOOLS = new Set(DEFAULT_TOOLS);
const MAX_PROMPT = 100_000;
// A claude session id is later passed to `harness.sh trace` — validate to that shape
// so a child-controlled value can't forge the audit or smuggle anything downstream.
const SESSION_RE = /"session_id"\s*:\s*"([A-Za-z0-9_-]{1,64})"/;

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
  fs.copyFileSync(realSrc, path.join(destDir, `${sessionId}.jsonl`));
  return true;
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

/**
 * Build the exact `claude` headless argv from a validated spec. Throws AgentExecError
 * on anything that isn't server-minted / a clean enum. The prompt is passed as a
 * single argv element (-p) and never shell-interpreted (spawn shell:false).
 */
export function buildAgentArgs(spec: AgentSpec): string[] {
  containedWorktree(spec.slug, spec.worktreePath); // provenance + containment
  if (typeof spec.taskPrompt !== "string" || spec.taskPrompt.length === 0 || spec.taskPrompt.length > MAX_PROMPT) {
    throw new AgentExecError("invalid task prompt (empty or too large)");
  }
  const model = spec.model ?? "sonnet";
  if (!ALLOWED_MODELS.has(model)) {
    throw new AgentExecError(`invalid model: ${JSON.stringify(model)}`);
  }
  const tools = spec.allowedTools ?? DEFAULT_TOOLS;
  for (const t of tools) {
    if (typeof t !== "string" || !ALLOWED_TOOLS.has(t)) {
      throw new AgentExecError(`tool not in allowlist: ${JSON.stringify(t)}`);
    }
  }
  return [
    "-p",
    spec.taskPrompt,
    "--output-format",
    "json",
    "--model",
    model,
    "--allowedTools",
    tools.join(","),
  ];
}

export interface SpawnAgentOptions {
  cwd?: string; // overridden by the validated worktree path; kept for parity
  spawnFn?: (cmd: string, args: string[], options: NodeSpawnOptions) => ChildProcess;
  timeoutMs?: number;
  killGraceMs?: number;
}

// Should be an ABSOLUTE path in production (avoid PATH-based binary hijack); the
// minimal env below also pins PATH so the lookup is controlled.
const DEFAULT_AGENT_CLI = process.env.AGENT_CLI_PATH ?? "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 1_800_000; // 30 min
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Minimal env for the agent child — an explicit ALLOWLIST, never the server's full
 * process.env (which could carry tokens/secrets). No ANTHROPIC_API_KEY (Max-plan; the
 * agent authenticates via its own ~/.claude session under HOME). PATH is pinned.
 */
function agentEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    PATH: process.env.AGENT_PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.AGENT_HOME ?? process.env.HOME ?? "/home/agent",
    LANG: process.env.LANG ?? "C.UTF-8",
  };
  return env as NodeJS.ProcessEnv;
}

/**
 * Spawn the headless agent for a lane. REFUSES unless ENABLE_AGENT_EXEC=1 (default
 * off). Runs in the validated worktree cwd with shell:false + its own process group;
 * a timeout SIGTERM→SIGKILLs the whole group and rejects HarnessTimeoutError; the
 * promise settles on `close` (slot held until the child truly exits). Parses the
 * final JSON for the Claude session id (so the daemon can run `harness.sh trace`),
 * and writes an audit record with argv summary + outcome + session — NEVER the
 * prompt or the session token. Resolves { code, sessionId }.
 */
export function spawnAgent(
  spec: AgentSpec,
  opts: SpawnAgentOptions = {}
): Promise<{ code: number | null; sessionId: string | null }> {
  return new Promise((resolve, reject) => {
    const audit = (outcome: string, code: number | null, sessionId: string | null) => {
      try {
        appendAudit({
          ts: Math.floor(Date.now() / 1000),
          cmd: "agent",
          // Curated SAFE summary — never the prompt, never a token.
          argv: [`lane:${spec.slug}`, `model:${spec.model ?? "sonnet"}`, `session:${sessionId ?? "?"}`],
          outcome,
          code,
        });
      } catch {
        // audit is best-effort; never break the run on a logging failure
      }
    };

    // Default-off gate: refuse to spawn unless explicitly enabled.
    if (process.env.ENABLE_AGENT_EXEC !== "1") {
      audit("refused", null, null);
      reject(new AgentExecError("agent execution is disabled (ENABLE_AGENT_EXEC not set)"));
      return;
    }

    let args: string[];
    let cwd: string;
    try {
      args = buildAgentArgs(spec); // validates BEFORE spawning
      cwd = containedWorktree(spec.slug, spec.worktreePath);
    } catch (e) {
      audit("invalid-args", null, null);
      reject(e);
      return;
    }

    const cli = DEFAULT_AGENT_CLI;
    const spawnFn = opts.spawnFn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(cli, args, {
        cwd, // confine the agent to the lane worktree
        shell: false, // CRITICAL: never let a shell re-parse the argv/prompt
        detached: true, // own process group → timeout can kill the whole tree
        env: agentEnv(), // minimal allowlist env — no secrets reach the agent
      });
    } catch (e) {
      audit("error", null, null);
      reject(e);
      return;
    }
    if (!child.stdout) {
      audit("error", null, null);
      reject(new Error("agent spawn produced no stdout"));
      return;
    }
    child.stderr?.resume(); // drain so a chatty agent can't deadlock on a full pipe

    // Accumulate stdout (the claude --output-format json result object) to extract
    // the session id at close. Bounded so a runaway agent can't grow it unbounded.
    let out = "";
    const MAX_OUT = 1_000_000;
    child.stdout.on("data", (c: Buffer) => {
      if (out.length < MAX_OUT) out += c.toString();
    });
    // Extract + validate the session id by pattern (resilient to large/streamed JSON
    // and child-controlled junk): only an id of the trace-session shape is accepted.
    const parseSession = (): string | null => {
      const m = out.match(SESSION_RE);
      return m ? m[1] : null;
    };

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
      killTimer = setTimeout(() => killTree("SIGKILL"), opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      killTimer.unref?.();
      // no settle here — wait for close so the slot is held until the agent is gone.
    }, timeoutMs);
    deadline.unref?.();

    child.on("error", (e) =>
      finish(() => {
        audit("error", null, parseSession());
        reject(e);
      })
    );
    child.on("close", (code) =>
      finish(() => {
        const sessionId = parseSession();
        if (timedOut) {
          audit("timeout", code, sessionId);
          reject(new HarnessTimeoutError(`agent for '${spec.slug}' timed out after ${timeoutMs}ms`));
        } else {
          audit("exit", code, sessionId);
          resolve({ code, sessionId });
        }
      })
    );
  });
}

// Concurrency: this is a low-level primitive with no internal single-flight guard —
// serialization is the daemon's single-slot responsibility (acquireSlot), exactly as
// for harness-bridge. Do not call spawnAgent outside that slot.
//
// ponytail: SIGKILL on the process group is assumed to reap the agent (close fires).
// skipped: stream-json progress forwarding to the broker — add when the daemon
// interleaves spawnAgent into runLive (next increment); flat result is enough now.
