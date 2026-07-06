// console/lib/sandbox/agent-runner.ts
// The safe agent sandbox: the sole owner of the isolation primitives that launch a
// HEADLESS Claude Code build agent. This is the highest-risk capability in the system —
// an autonomous coder running tools — so every layer is defence in depth: server-built
// validated argv (never raw client strings), shell:false, an EXACT tool allowlist,
// --strict-mcp-config (zero MCP), a credential-free minimal env, worktree confinement, a
// default-OFF gate (ENABLE_AGENT_EXEC), a process-group timeout/kill, and an audit record
// carrying NO prompt/secret.
//
// DECIDED POSTURE (console / trusted-local workstation): the agent runs in DIRECT MODE as
// the operator (no OS-user drop) with the FULL toolset INCLUDING Bash, so it can run the
// project's own build/test/lint and iterate. This DEPARTS from web's no-Bash invariant on
// purpose (see DEFAULT_TOOLS). Drop mode (AGENT_USER set → sudo -u) remains fully intact
// for the VPS. Direct mode in production is refused UNLESS AGENT_ALLOW_DIRECT=1 is set
// (explicit, greppable opt-out) — see buildInvocation.
//
// Execution is REFUSED unless ENABLE_AGENT_EXEC=1.

import { spawn as nodeSpawn, type SpawnOptions as NodeSpawnOptions, type ChildProcess } from "child_process";
import path from "path";
import os from "os";
import { AgentExecError, HarnessTimeoutError } from "@/lib/bridge/errors";
import { appendAudit, type AuditRecord } from "@/lib/server/persist";
import { containedWorktree, worktreePathFor } from "./worktree";

export { AgentExecError };

/** Routed model tier for a sandboxed agent run. */
export type AgentModel = "haiku" | "sonnet" | "opus";

/** A server-built request to run the build agent in one lane's worktree. */
export interface AgentSpec {
  /** Lane slug — must be server-minted (registry.mintLane). */
  slug: string;
  /** Absolute worktree path; must be the lane's entry under the worktrees allow-dir. */
  worktreePath: string;
  /** The task prompt for the agent. Opaque text — NEVER audited or logged. */
  taskPrompt: string;
  /** Routed model tier; defaults to sonnet. */
  model?: AgentModel;
  /** Claude Code tool allowlist; defaults to the full DEFAULT_TOOLS set (includes Bash). */
  allowedTools?: string[];
  /**
   * The resolved per-lane OS user the agent runs as (laneUser(i)). Undefined ⇒ fall back
   * to AGENT_USER (the index-0 account) so single-lane is byte-identical. In drop mode the
   * build path runs the agent under this uid via `sudo -u`; its 0700 worktree is chowned to
   * the same user. Undefined + no AGENT_USER ⇒ direct mode (the console default).
   */
  user?: string;
}

/**
 * ACTUAL token/cost/context usage the agent reported in its --output-format json
 * result. Surfaced so the daemon can emit a `usage` envelope for the HUD. ALL fields
 * are best-effort: a failed/absent/parse-broken result yields null (no usage event).
 */
export interface AgentUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  costUsd: number;
}

/**
 * Parse the agent's result JSON for usage/cost/context. Robust by design: the agent
 * controls this stdout, and a failed run may emit no/partial/garbage JSON — so any
 * parse failure or missing shape returns null and the caller simply skips the usage
 * event (never throws). Prefers per-model `modelUsage` (carries contextWindow + the
 * precise per-model costUSD); falls back to the top-level `usage` + `total_cost_usd`.
 */
export function parseAgentUsage(raw: string): AgentUsage | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const r = obj as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const modelUsage = r.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    const entries = Object.entries(modelUsage as Record<string, unknown>);
    if (entries.length > 0) {
      // Single-model agent run: take the first (and typically only) model entry.
      const [model, muRaw] = entries[0];
      const mu = (muRaw ?? {}) as Record<string, unknown>;
      return {
        model,
        inputTokens: num(mu.inputTokens),
        outputTokens: num(mu.outputTokens),
        cacheReadTokens: num(mu.cacheReadInputTokens),
        cacheCreationTokens: num(mu.cacheCreationInputTokens),
        contextWindow: num(mu.contextWindow),
        costUsd: num(mu.costUSD ?? r.total_cost_usd),
      };
    }
  }

  // Fallback: top-level usage block (no contextWindow available there).
  const usage = r.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    return {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheReadTokens: num(u.cache_read_input_tokens),
      cacheCreationTokens: num(u.cache_creation_input_tokens),
      contextWindow: 0,
      costUsd: num(r.total_cost_usd),
    };
  }
  return null;
}

const ALLOWED_MODELS = new Set<AgentModel>(["haiku", "sonnet", "opus"]);
// EXACT allowlist — no free-form predicates. "Bash" IS deliberately included: the DECIDED
// POSTURE for the console (trusted-local, direct-mode) is a real headless Claude Code with
// the FULL toolset so it can run the project's own build/test/lint and iterate. This is a
// deliberate DEPARTURE from web's no-Bash invariant (web keeps Bash unreachable because it
// targets the untrusted VPS drop). The exact-allowlist validation still holds: anything
// OUTSIDE this set (e.g. "Bash(rm -rf /)", "Edit; …", MCP tools) is rejected, and
// --strict-mcp-config is always on. (Decision: feat/agent-exec-wire — direct-local Bash.)
export const DEFAULT_TOOLS = ["Read", "Edit", "Write", "Grep", "Glob", "Bash"];
const ALLOWED_TOOLS = new Set(DEFAULT_TOOLS);
const MAX_PROMPT = 100_000;
// A claude session id is later passed to `harness.sh trace` — STRICT shape so a
// child-controlled value can't forge the audit or smuggle anything downstream. This is
// matched against ONLY the top-level `session_id` of the parsed JSON result object (never
// regex-scanned over arbitrary embedded tool-output text — see parseSession in spawnAgent).
const SESSION_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
    // Isolate the agent from ALL inherited MCP connectors. With no --mcp-config passed,
    // --strict-mcp-config makes claude load ZERO MCP servers — ignoring the Max-plan
    // account-synced servers (Gmail/Drive/Calendar/…), global, and project .mcp.json.
    // The tool allowlist blocks CALLING mcp__* tools; this blocks CONNECTING at all.
    "--strict-mcp-config",
  ];
}

export interface SpawnAgentOptions {
  cwd?: string; // overridden by the validated worktree path; kept for parity
  spawnFn?: (cmd: string, args: string[], options: NodeSpawnOptions) => ChildProcess;
  timeoutMs?: number;
  killGraceMs?: number;
  /**
   * Resource caps the agent-exec wrapper enforces (cgroup/ulimit). Plumbed to the
   * child as SANDBOX_* env vars; the wrapper reads them, defaulting to its hardcoded
   * values when unset so current behavior is unchanged. See ResourceLimits.
   */
  resourceLimits?: ResourceLimits;
}

/**
 * Caps the sandbox CAN request even though the OS-level wrapper still ENFORCES them.
 * These are passed to deploy/tier3/agent-exec-wrapper.sh as env vars; the wrapper
 * applies them via cgroup (systemd-run) / ulimit. Any unset field falls back to the
 * wrapper's current hardcoded default, so the interface can tighten a limit without
 * changing today's behavior.
 */
export interface ResourceLimits {
  /** cgroup MemoryMax, e.g. "2G" → SANDBOX_MEM_MAX. */
  memoryMax?: string;
  /** cgroup TasksMax (process/thread cap) → SANDBOX_TASKS_MAX. */
  tasksMax?: number;
  /** cgroup CPUQuota, e.g. "200%" → SANDBOX_CPU_QUOTA. */
  cpuQuota?: string;
  /** ulimit -t CPU-seconds hard cap → SANDBOX_CPU_SECONDS. */
  cpuSeconds?: number;
  /** Wall-clock timeout (ms) — enforced IN-PROCESS by the spawn timeout, not the wrapper. */
  wallMs?: number;
}

// Should be an ABSOLUTE path in production (avoid PATH-based binary hijack); the
// minimal env below also pins PATH so the lookup is controlled.
const DEFAULT_AGENT_CLI = process.env.AGENT_CLI_PATH ?? "claude";
const DEFAULT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 1_800_000; // 30 min
const DEFAULT_KILL_GRACE_MS = 5_000;

// Privilege drop (threat model §6): when AGENT_USER is set, the agent is launched as
// that dedicated low-priv OS account via `sudo -u` instead of the daemon's own user, so
// a separate account whose only writable area is the worktrees dir is the real FS jail
// (cwd alone is NOT). Unset ⇒ DIRECT mode (daemon/operator user) — the console default on
// the trusted-local workstation; refused in production unless AGENT_ALLOW_DIRECT=1.
//
// BASE_AGENT_USER is the existing single account (index-0, backward-compatible with the
// live box). laneUser(i) derives the per-lane account from it: lane 0 → BASE, lane i>0 →
// `${BASE}-${i}` — so concurrent lanes run under DISTINCT uids and a sibling lane's uid
// can't touch another's 0700 worktree.
const AGENT_USER = process.env.AGENT_USER;
const BASE_AGENT_USER = AGENT_USER;
const SUDO_PATH = process.env.AGENT_SUDO_PATH ?? "/usr/bin/sudo";
const USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/; // POSIX-ish username, used in argv

/**
 * Validate a resolved lane username against the SAME guards buildInvocation enforces on
 * AGENT_USER: a plain POSIX-ish username, never root, never the daemon's own user (no
 * privilege drop otherwise). Throws AgentExecError (fail closed) — the result is used in
 * argv (sudo -u) and a chown target, so a bad value must never pass.
 */
function validateLaneUser(user: string): string {
  if (!USERNAME_RE.test(user)) {
    throw new AgentExecError(`invalid lane user (must be a plain username): ${JSON.stringify(user)}`);
  }
  if (user === "root") {
    throw new AgentExecError("lane user must not be root (a low-priv account is required)");
  }
  if (user === os.userInfo().username) {
    throw new AgentExecError(`lane user must differ from the daemon user (${user}) — no privilege drop otherwise`);
  }
  return user;
}

/**
 * SINGLE SOURCE OF TRUTH for the per-lane OS user. Lane index 0 → BASE_AGENT_USER (the
 * existing `agent` account, byte-identical to single-lane today); lane i>0 → `${BASE}-${i}`
 * (e.g. agent-1, agent-2…). Each distinct user owns its own 0700 worktree, so concurrent
 * lanes are isolated by uid. Returns undefined ONLY when AGENT_USER is unset (dev/test:
 * direct mode, no privilege drop). The resolved name is validated with the same not-root /
 * not-daemon-user / username-shape checks as AGENT_USER.
 */
export function laneUser(index: number): string | undefined {
  if (!BASE_AGENT_USER) return undefined; // direct mode (no AGENT_USER) — no per-lane user
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    throw new AgentExecError(`invalid lane index (must be a non-negative integer): ${JSON.stringify(index)}`);
  }
  const user = index === 0 ? BASE_AGENT_USER : `${BASE_AGENT_USER}-${index}`;
  return validateLaneUser(user);
}

// Sane upper bounds — these values are destined for `systemd-run -p MemoryMax=…` /
// ulimit in the future wrapper, so they are validated + clamped here (fail closed) so an
// unvalidated/injected/unbounded value can NEVER reach a shell-interpolated context.
const MEM_RE = /^\d+[KMGT]?$|^\d+%$/; // bytes-with-suffix OR a percentage
const CPU_QUOTA_RE = /^\d+%$/; // CPUQuota is always a percentage
const MAX_TASKS = 4096;
const MAX_CPU_SECONDS = 3600; // 1h hard CPU cap
const MAX_WALL_MS = 3_600_000; // 1h wall cap (also the spawn timeout ceiling)

/** A positive integer ≤ max, else throw (fail closed). */
function posInt(v: number, max: number, name: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0 || v > max) {
    throw new AgentExecError(`invalid ${name} (must be a positive integer ≤ ${max}): ${JSON.stringify(v)}`);
  }
  return v;
}

/**
 * Validate + canonicalize resource limits BEFORE they enter the child env. Every field is
 * shape-checked against a strict pattern / bound and REJECTED (AgentExecError) on anything
 * else — never passed onward unvalidated, because the wrapper will interpolate these into
 * `systemd-run -p MemoryMax=$SANDBOX_MEM_MAX …`. memoryMax: digits + optional KMGT or a
 * percentage; cpuQuota: a percentage; tasksMax/cpuSeconds/wallMs: positive integers clamped
 * to sane maxima (the host memory ceiling is enforced by the wrapper/cgroup, not here).
 */
export function validateLimits(limits: ResourceLimits): ResourceLimits {
  const out: ResourceLimits = {};
  if (limits.memoryMax !== undefined) {
    const m = String(limits.memoryMax);
    if (!MEM_RE.test(m)) throw new AgentExecError(`invalid memoryMax (digits + optional K/M/G/T or a %): ${JSON.stringify(limits.memoryMax)}`);
    out.memoryMax = m;
  }
  if (limits.cpuQuota !== undefined) {
    const q = String(limits.cpuQuota);
    if (!CPU_QUOTA_RE.test(q)) throw new AgentExecError(`invalid cpuQuota (must be a percentage like "200%"): ${JSON.stringify(limits.cpuQuota)}`);
    out.cpuQuota = q;
  }
  if (limits.tasksMax !== undefined) out.tasksMax = posInt(limits.tasksMax, MAX_TASKS, "tasksMax");
  if (limits.cpuSeconds !== undefined) out.cpuSeconds = posInt(limits.cpuSeconds, MAX_CPU_SECONDS, "cpuSeconds");
  if (limits.wallMs !== undefined) out.wallMs = posInt(limits.wallMs, MAX_WALL_MS, "wallMs");
  return out;
}

/**
 * Resource-limit env vars passed to the agent-exec wrapper. Validates first (fail closed),
 * then emits only the set fields; an absent field leaves the wrapper on its current
 * hardcoded default (no behavior change). wallMs is in-process only — not an env var.
 *
 * ponytail: the wrapper (deploy/tier3/agent-exec-wrapper.sh — the later provisioner chunk)
 * MUST read SANDBOX_MEM_MAX / SANDBOX_TASKS_MAX / SANDBOX_CPU_QUOTA / SANDBOX_CPU_SECONDS
 * and apply them via systemd-run/ulimit, defaulting to its current hardcoded caps when
 * unset. Until then these envs are inert (forward-compatible plumbing).
 * skipped: enforcement of these caps; add when the wrapper lands in the provisioner chunk.
 */
function resourceLimitEnv(limits?: ResourceLimits): Record<string, string> {
  const env: Record<string, string> = {};
  if (!limits) return env;
  const v = validateLimits(limits);
  if (v.memoryMax !== undefined) env.SANDBOX_MEM_MAX = v.memoryMax;
  if (v.tasksMax !== undefined) env.SANDBOX_TASKS_MAX = String(v.tasksMax);
  if (v.cpuQuota !== undefined) env.SANDBOX_CPU_QUOTA = v.cpuQuota;
  if (v.cpuSeconds !== undefined) env.SANDBOX_CPU_SECONDS = String(v.cpuSeconds);
  return env;
}

/**
 * Minimal env for the agent child — an explicit ALLOWLIST, never the server's full
 * process.env (which could carry tokens/secrets). No ANTHROPIC_API_KEY (Max-plan; the
 * agent authenticates via its own ~/.claude session under HOME). PATH is pinned. Any
 * SANDBOX_* resource-limit vars (consumed by the wrapper) are merged on top.
 */
function agentEnv(limits?: ResourceLimits): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    PATH: process.env.AGENT_PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.AGENT_HOME ?? process.env.HOME ?? "/home/agent",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...resourceLimitEnv(limits),
  };
  return env as NodeJS.ProcessEnv;
}

/**
 * Resolve the real (command, argv, spawn-env) for the agent.
 *
 * Direct mode (AGENT_USER unset): run `claude` as the daemon's/operator's own user. This
 * is the DECIDED POSTURE for the console (trusted-local workstation). It keeps the
 * operator's privileges, so in production it is REFUSED UNLESS AGENT_ALLOW_DIRECT=1 is set
 * (explicit, greppable opt-out) — an unguarded privilege-keep would be a dangerous misconfig
 * on a server. Outside production, direct mode is unchanged (dev/test).
 *
 * Drop mode (AGENT_USER set): `sudo -n -H -u <user> -- <abs-claude> …`. `-n` never
 * prompts (fail closed); argv0 is the claude binary itself (NOT an `env` wrapper) so the
 * sudoers grant can be scoped to exactly that binary; `-H` sets HOME from the agent
 * user's own passwd (its own ~/.claude Max-plan session); sudo's default env_reset drops
 * the daemon's environment, and the spawn env we pass is minimal. shell:false still holds.
 * The target must be a real, non-root account distinct from the daemon user, and the cli
 * an absolute trusted path. This path is FULLY INTACT for the VPS.
 *
 * Resource-limit SANDBOX_* vars are forwarded in BOTH modes: in drop mode sudo's
 * env_reset would strip arbitrary vars, so they're added back via `--preserve-env` for
 * exactly those keys (the wrapper, run as the agent user, reads them).
 *
 * `user` is the resolved per-lane account (laneUser(i)) the agent runs as. It DEFAULTS to
 * BASE_AGENT_USER (= AGENT_USER, the index-0 account) so a single-lane invocation is
 * byte-identical to before. Every existing validation still runs on it (username shape /
 * not-root / not-daemon-user), so a per-lane name is held to the same bar as AGENT_USER.
 */
export function buildInvocation(
  cli: string,
  claudeArgs: string[],
  limits?: ResourceLimits,
  user: string | undefined = AGENT_USER
): { cmd: string; argv: string[]; spawnEnv: NodeJS.ProcessEnv } {
  const limitEnv = resourceLimitEnv(limits);
  const limitKeys = Object.keys(limitEnv);
  if (!user) {
    // Direct mode ALWAYS requires an EXPLICIT opt-out (AGENT_ALLOW_DIRECT=1), regardless of
    // NODE_ENV — a daemon launched without NODE_ENV=production must NOT silently run
    // direct+Bash with no opt-out. The greppable flag is how an operator says "yes, run as
    // me on this trusted box". Without it, fail closed (a silent privilege-keep must never
    // happen). Drop mode (AGENT_USER set) is unaffected.
    if (process.env.AGENT_ALLOW_DIRECT !== "1") {
      throw new AgentExecError(
        "direct-mode agent-exec requires AGENT_ALLOW_DIRECT=1 (explicit, greppable opt-out): " +
          "set AGENT_USER for a privilege drop, or AGENT_ALLOW_DIRECT=1 to allow direct-local mode (threat model §6)"
      );
    }
    return { cmd: cli, argv: claudeArgs, spawnEnv: agentEnv(limits) };
  }
  if (!USERNAME_RE.test(user)) {
    throw new AgentExecError(`invalid agent user (must be a plain username): ${JSON.stringify(user)}`);
  }
  if (user === "root") {
    throw new AgentExecError("agent user must not be root (a low-priv account is required)");
  }
  const daemonUser = os.userInfo().username;
  if (user === daemonUser) {
    throw new AgentExecError(`agent user must differ from the daemon user (${daemonUser}) — no privilege drop otherwise`);
  }
  if (!path.isAbsolute(SUDO_PATH)) {
    throw new AgentExecError(`AGENT_SUDO_PATH must be an absolute path: ${JSON.stringify(SUDO_PATH)}`);
  }
  if (!path.isAbsolute(cli)) {
    throw new AgentExecError("AGENT_CLI_PATH must be an absolute path when AGENT_USER is set (no PATH-based hijack)");
  }
  // Preserve only the explicit SANDBOX_* keys across sudo's env_reset (none by default,
  // so the argv is byte-identical to before when no resourceLimits are passed).
  const preserve = limitKeys.length > 0 ? [`--preserve-env=${limitKeys.join(",")}`] : [];
  return {
    cmd: SUDO_PATH,
    argv: ["-n", "-H", ...preserve, "-u", user, "--", cli, ...claudeArgs],
    // The child's env is set by sudo (env_reset + -H); node only needs PATH to exist for
    // the (absolute) sudo invocation. The SANDBOX_* limit vars must exist in the spawn
    // env for --preserve-env to forward them. No daemon secret is forwarded.
    spawnEnv: { PATH: process.env.AGENT_PATH ?? "/usr/local/bin:/usr/bin:/bin", ...limitEnv } as unknown as NodeJS.ProcessEnv,
  };
}

/** The audit record the sandbox writes per run (and returns to the caller). */
export type SandboxAudit = AuditRecord;

/**
 * Spawn the headless agent for a lane. REFUSES unless ENABLE_AGENT_EXEC=1 (default
 * off). Runs in the validated worktree cwd with shell:false + its own process group;
 * a timeout SIGTERM→SIGKILLs the whole group and rejects HarnessTimeoutError; the
 * promise settles on `close` (slot held until the child truly exits). Parses the
 * final JSON for the Claude session id (so the daemon can run `harness.sh trace`),
 * and writes an audit record with argv summary + outcome + session — NEVER the
 * prompt or the session token. Resolves { code, sessionId, usage }.
 */
export function spawnAgent(
  spec: AgentSpec,
  opts: SpawnAgentOptions = {}
): Promise<{ code: number | null; sessionId: string | null; usage: AgentUsage | null }> {
  return new Promise((resolve, reject) => {
    const audit = (outcome: string, code: number | null, sessionId: string | null, fatal = false) => {
      try {
        appendAudit({
          ts: Math.floor(Date.now() / 1000),
          cmd: "agent",
          // Curated SAFE summary — never the prompt, never a token.
          argv: [`lane:${spec.slug}`, `model:${spec.model ?? "sonnet"}`, `session:${sessionId ?? "?"}`],
          outcome,
          code,
        });
      } catch (e) {
        // Settle-time audits are best-effort (the child already ran). But the mandatory
        // pre-spawn row (fatal=true) MUST persist: if it can't, we must NOT spawn — no
        // unaudited agent run (mirrors harness-bridge's fail-closed spawn audit, T7).
        if (fatal) throw e;
        // else best-effort; never break the run on a logging failure
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

    let inv: ReturnType<typeof buildInvocation>;
    try {
      // Drop to the lane's user via sudo if set (spec.user, defaulting to AGENT_USER for
      // single-lane). buildInvocation re-validates it with the same not-root/not-daemon checks.
      inv = buildInvocation(DEFAULT_AGENT_CLI, args, opts.resourceLimits, spec.user);
    } catch (e) {
      audit("invalid-args", null, null);
      reject(e);
      return;
    }
    // Mandatory pre-spawn audit (FAIL CLOSED): a durable row MUST exist before the child
    // runs — an agent can never spawn without its audit trail (threat model T7). Mirrors
    // harness-bridge's fatal "spawn" record. Session id is unknown pre-spawn (session:?).
    try {
      audit("spawn", null, null, true);
    } catch (e) {
      reject(e);
      return;
    }
    const spawnFn = opts.spawnFn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(inv.cmd, inv.argv, {
        cwd, // confine the agent to the lane worktree
        shell: false, // CRITICAL: never let a shell re-parse the argv/prompt
        detached: true, // own process group → timeout can kill the whole tree
        env: inv.spawnEnv, // minimal allowlist env — no secrets reach the agent
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
    // Extract the session id by parsing the accumulated stdout as the single
    // `--output-format json` RESULT OBJECT and reading ONLY its top-level `session_id`.
    // NEVER regex-scan arbitrary embedded text: a tool-output string containing a fake
    // `"session_id":"…"` must not be picked up. Defensive throughout (the child controls
    // stdout): a parse failure, missing/oversized value, or a value that fails the strict
    // trace-session shape all yield null — which, when the agent ran, fails the run closed
    // in the daemon (Gate D). The value is never minted/used until it passes SESSION_RE.
    const parseSession = (): string | null => {
      let obj: unknown;
      try {
        obj = JSON.parse(out);
      } catch {
        return null; // no/partial/garbage JSON → no session
      }
      if (!obj || typeof obj !== "object") return null;
      const r = obj as Record<string, unknown>;
      // Accept the id ONLY from claude's own result envelope: require type:"result" so a
      // bare {session_id} object (or any other shape) is rejected. Defense in depth — the
      // agent controls stdout, so containment (relocateTrace dest checks) is the real
      // boundary; this just narrows what a forged stdout can smuggle into the audit/trace.
      if (r.type !== "result") return null;
      const sid = r.session_id;
      if (typeof sid !== "string" || !SESSION_RE.test(sid)) return null;
      return sid;
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
          // Best-effort usage extraction from the same accumulated result JSON; a
          // parse failure / failed agent yields null and the daemon skips the event.
          resolve({ code, sessionId, usage: parseAgentUsage(out) });
        }
      })
    );
  });
}

// Concurrency: this is a low-level primitive with no internal single-flight guard —
// serialization is the daemon's single-slot responsibility (acquireSlot), exactly as
// for harness-bridge. Do not call spawnAgent / runAgentInSandbox outside that slot.
//
// ponytail: SIGKILL on the process group is assumed to reap the agent (close fires).
// skipped: stream-json progress forwarding to the broker — add when the daemon
// interleaves the agent into a live event stream; flat result is enough now.

/** Options for the single public sandbox entrypoint. */
export interface RunAgentInSandboxOptions {
  /** Task prompt for the agent. Opaque — never audited/logged. */
  prompt: string;
  /** Tool allowlist; defaults to DEFAULT_TOOLS. Validated against the exact allowlist. */
  allowedTools?: string[];
  /** OS-level resource caps requested for the wrapper (and the in-process wall timeout). */
  resourceLimits?: ResourceLimits;
  /** Routed model tier; defaults to sonnet. */
  model?: AgentModel;
  /**
   * Absolute lane worktree path — the agent's confined cwd. Must be the lane's entry
   * under the worktrees allow-dir (validated via containedWorktree against sessionId).
   */
  cwd: string;
  /**
   * The lane slug — server-minted provenance, used both as the worktree identity and the
   * audit `lane:` field. (Named sessionId in the interface contract; it is the lane slug
   * the daemon mints per lane.)
   */
  sessionId?: string;
  /**
   * The resolved per-lane OS user (laneUser(i)) the agent runs as. Undefined ⇒ AGENT_USER
   * (index-0), keeping single-lane byte-identical. Used for the `sudo -u` privilege drop.
   */
  user?: string;
  /** TEST seam: injectable spawn (real nodeSpawn in prod). */
  spawnFn?: SpawnAgentOptions["spawnFn"];
}

/** Result of one sandboxed agent run. */
export interface RunAgentInSandboxResult {
  exitCode: number | null;
  sessionId: string | null;
  usage: AgentUsage | null;
  /** The audit record written for this run — returned so a consumer can log/inspect it. */
  audit: SandboxAudit;
}

/**
 * THE public sandbox entrypoint. One clean call that runs a headless build agent under
 * every isolation guarantee: exact tool allowlist, --strict-mcp-config (zero MCP),
 * credential-free minimal env, optional privilege drop to AGENT_USER, worktree
 * confinement, default-OFF gate, and a process-group timeout. Returns the exit code,
 * the parsed session id, best-effort usage, and the audit record.
 *
 * `allowedTools` defaults to DEFAULT_TOOLS (the FULL set including Bash) and is validated
 * against the allowlist by buildAgentArgs (anything outside it is rejected). `resourceLimits`
 * is plumbed to the wrapper via SANDBOX_* env vars (and `wallMs`, if set, becomes the
 * in-process spawn timeout).
 */
export async function runAgentInSandbox(opts: RunAgentInSandboxOptions): Promise<RunAgentInSandboxResult> {
  const slug = opts.sessionId ?? "";
  const spec: AgentSpec = {
    slug,
    worktreePath: opts.cwd,
    taskPrompt: opts.prompt,
    model: opts.model,
    allowedTools: opts.allowedTools ?? DEFAULT_TOOLS,
    user: opts.user,
  };

  // spawnAgent owns the single audit sink (appendAudit) and the throw semantics on the
  // gate/timeout/error paths — preserved verbatim so the daemon's existing control flow
  // is unchanged. On success we return a self-contained copy of the SAME safe summary
  // (lane/model/session — never the prompt or token) so a consumer can log/inspect it.
  // Thread the FULL resourceLimits through: spawnAgent → buildInvocation sets the
  // SANDBOX_* env (+ --preserve-env in drop mode); wallMs also caps the in-process timeout.
  const result = await spawnAgent(spec, {
    spawnFn: opts.spawnFn,
    resourceLimits: opts.resourceLimits,
    timeoutMs: opts.resourceLimits?.wallMs,
  });
  const audit: SandboxAudit = {
    ts: Math.floor(Date.now() / 1000),
    cmd: "agent",
    argv: [`lane:${slug}`, `model:${opts.model ?? "sonnet"}`, `session:${result.sessionId ?? "?"}`],
    outcome: "exit",
    code: result.code,
  };
  return { exitCode: result.code, sessionId: result.sessionId, usage: result.usage, audit };
}

// Re-export the worktree confinement primitives so the sandbox is the single import
// surface for isolation (containment lives in ./worktree but is part of the guarantee).
export { worktreePathFor, containedWorktree } from "./worktree";
export { relocateTrace } from "./worktree";
