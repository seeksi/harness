// web/lib/daemon/harness-bridge.ts
// Secure bridge from harness.sh subcommands → SSEEvents. The security-critical
// core is buildArgs: it maps a typed, server-constructed HarnessSubcommand to a
// fixed argv built ONLY from validated enums/patterns — NEVER raw client strings
// as paths, branches, slugs, or shell fragments (harness.sh interpolates $2
// unsanitized). spawnHarness runs with shell:false so the argv is never
// re-parsed by a shell.
//
// NOT wired into the daemon's default path: the dry-run fixture remains the
// producer. Enabling real execution needs (a) harness.sh emitting line-delimited
// JSON events (parseHarnessLine consumes that contract; human text is ignored),
// and (b) the locked threat model — promote stays preview-only until it passes.

import { spawn as nodeSpawn, type SpawnOptions as NodeSpawnOptions, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import path from "path";
import type { SSEEvent } from "@/lib/contract/events";
import { isLane, isSession, isPlanFile } from "./registry";
import { HarnessArgError, HarnessTimeoutError } from "./errors";
import { appendAudit } from "@/lib/store/persist";

export type HarnessSubcommand =
  | { cmd: "budget"; planFile: string }
  | { cmd: "wt-new"; slug: string }
  | { cmd: "wt-commit"; slug: string }
  | { cmd: "wt-verify"; slug: string }
  | { cmd: "integ-start" }
  | { cmd: "integ-merge"; slug: string }
  | { cmd: "trace"; session: string }
  | { cmd: "promote" };

// Re-exported for callers/tests that import them from the bridge; defined in
// errors.ts to keep registry.ts ↔ harness-bridge.ts free of a circular dependency.
export { HarnessArgError, HarnessTimeoutError };

// Provenance gate (threat model T1): a slug/session/plan-file reaches harness.sh
// ONLY if the server minted it (registry.ts), never because a client string happens
// to match a pattern. This is the primary control; the mint-time regex is defense
// in depth. NO buildArgs argument is a raw client string.
function requireLane(slug: string): string {
  if (typeof slug !== "string" || !isLane(slug)) {
    throw new HarnessArgError(`unminted lane slug (provenance check failed): ${JSON.stringify(slug)}`);
  }
  return slug;
}
function requireSession(id: string): string {
  if (typeof id !== "string" || !isSession(id)) {
    throw new HarnessArgError(`unminted session id (provenance check failed): ${JSON.stringify(id)}`);
  }
  return id;
}
function requirePlanFile(name: string): string {
  if (typeof name !== "string" || !isPlanFile(name)) {
    throw new HarnessArgError(`unminted plan file (provenance check failed): ${JSON.stringify(name)}`);
  }
  return name;
}

// Fixed allow-dir for plan files, resolved ONCE at module load (not per call) so the
// containment boundary can't shift with a later process.chdir / env mutation. Set via
// HARNESS_PLAN_DIR (default "data/plans") under HARNESS_REPO || cwd. Plan files are
// written here by the server (route-cost step).
const PLAN_DIR_ABS = path.resolve(
  process.env.HARNESS_REPO ?? process.cwd(),
  process.env.HARNESS_PLAN_DIR ?? "data/plans"
);

/**
 * Resolve a plan-file NAME to an absolute path inside the fixed allow-dir and assert
 * it cannot escape (threat model T5). This is an independent second layer beneath
 * provenance + the bare-filename regex: even if a name with separators ever reached
 * here, it would be rejected rather than read from outside the allow-dir. Pure path
 * math — no filesystem access. Exported so the containment guarantee is unit-tested
 * directly (provenance blocks malicious input upstream, so buildArgs can't reach it).
 */
export function containedPlanFile(name: string): string {
  const fullAbs = path.resolve(PLAN_DIR_ABS, name);
  if (fullAbs !== PLAN_DIR_ABS && !fullAbs.startsWith(PLAN_DIR_ABS + path.sep)) {
    throw new HarnessArgError(`plan file escapes allow-dir: ${JSON.stringify(name)}`);
  }
  return fullAbs;
}

/**
 * Build the exact argv for harness.sh from a validated subcommand. Throws
 * HarnessArgError on any value that isn't server-minted. The result is passed to
 * spawn with shell:false, so no value is ever shell-interpreted.
 */
export function buildArgs(sub: HarnessSubcommand): string[] {
  switch (sub.cmd) {
    case "budget":
      // provenance (minted) → then resolve+contain under the allow-dir (T5).
      return ["budget", containedPlanFile(requirePlanFile(sub.planFile))];
    case "wt-new":
      return ["wt-new", requireLane(sub.slug)];
    case "wt-commit":
      return ["wt-commit", requireLane(sub.slug)];
    case "wt-verify":
      return ["wt-verify", requireLane(sub.slug)];
    case "integ-start":
      return ["integ-start"];
    case "integ-merge":
      return ["integ-merge", requireLane(sub.slug)];
    case "trace":
      return ["trace", requireSession(sub.session)];
    case "promote":
      return ["promote"];
    default: {
      // exhaustiveness guard
      const _never: never = sub;
      throw new HarnessArgError(`unknown subcommand: ${JSON.stringify(_never)}`);
    }
  }
}

// Per-event-type schemas (threat model §7 / T4). Each event type has a fixed set
// of allowed fields with a primitive/enum validator; parseHarnessLine copies ONLY
// these fields into the result. Consequences:
//   - a future/extra field (e.g. a smuggled credential) is dropped, never forwarded;
//   - a missing required field or wrong enum drops the whole event;
//   - `hello` has no schema, so it can never arrive on the wire — the SSE stream
//     route owns the resync snapshot; the harness producer only emits deltas.
type Check = (v: unknown) => boolean;
interface FieldSpec {
  required: boolean;
  check: Check;
  /** optional projection so nested objects are also reduced to known fields. */
  project?: (v: unknown) => unknown;
}

const isStr: Check = (v) => typeof v === "string";
const isNum: Check = (v) => typeof v === "number" && Number.isFinite(v);
const isBool: Check = (v) => typeof v === "boolean";
const oneOf =
  (...allowed: unknown[]): Check =>
  (v) =>
    allowed.includes(v);
const PHASE_ID: Check = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 6;
const SEVERITY = oneOf("info", "low", "medium", "high", "critical");
const isCounts: Check = (v) =>
  typeof v === "object" &&
  v !== null &&
  isNum((v as Record<string, unknown>).high) &&
  isNum((v as Record<string, unknown>).critical);

const SCHEMAS: Record<string, Record<string, FieldSpec>> = {
  phase: {
    phase: { required: true, check: PHASE_ID },
    status: { required: true, check: oneOf("idle", "active", "done", "blocked") },
  },
  subtask: {
    id: { required: true, check: isStr },
    status: { required: true, check: oneOf("pending", "building", "reviewed", "merged", "blocked") },
    phase: { required: false, check: PHASE_ID },
    model: { required: false, check: oneOf("haiku", "sonnet", "opus") },
  },
  gate: {
    id: { required: true, check: oneOf("A", "B", "C", "D") },
    status: { required: true, check: oneOf("clear", "raised", "resolved") },
    severity: { required: true, check: SEVERITY },
    subtaskId: { required: false, check: isStr },
    counts: {
      required: false,
      check: isCounts,
      project: (v) => ({
        high: (v as Record<string, unknown>).high,
        critical: (v as Record<string, unknown>).critical,
      }),
    },
    summary: { required: true, check: isStr },
    traceReady: { required: false, check: isBool },
  },
  agentFire: {
    id: { required: true, check: isStr },
    subtaskId: { required: true, check: isStr },
    kind: { required: true, check: oneOf("route", "review", "gate", "merge", "promote") },
    severity: { required: true, check: SEVERITY },
    firedAt: { required: true, check: isNum },
  },
  trace: {
    ts: { required: true, check: isNum },
    tool: { required: true, check: isStr },
    sig: { required: true, check: isStr },
    subtaskId: { required: false, check: isStr },
  },
  budget: {
    ceilingUsd: { required: true, check: isNum },
    estimatedUsd: { required: true, check: isNum },
    spentUsd: { required: false, check: isNum },
    overBy: { required: false, check: isNum },
  },
  approval: {
    phase: { required: true, check: PHASE_ID },
    kind: { required: true, check: oneOf("decompose-split", "promote-to-main") },
    state: { required: true, check: oneOf("awaiting", "approved", "rejected") },
  },
};

/**
 * Parse one stdout line into an SSEEvent. Expects line-delimited JSON (the
 * harness.sh event contract); any non-JSON line, unknown `type`, missing/invalid
 * required field, or bad enum is ignored (returns null). Only whitelisted fields
 * are copied through, so human output never leaks and no extra field can ride along.
 */
export function parseHarnessLine(line: string): SSEEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.type !== "string") return null;
  // Own-property check: a bare `SCHEMAS[obj.type]` would resolve inherited keys
  // ("constructor", "toString", "__proto__"), letting them bypass the type
  // whitelist. hasOwnProperty restricts lookup to the declared event types.
  if (!Object.prototype.hasOwnProperty.call(SCHEMAS, obj.type)) return null;
  const schema = SCHEMAS[obj.type]; // unknown type (incl. hello) already dropped

  const clean: Record<string, unknown> = { type: obj.type };
  for (const [key, spec] of Object.entries(schema)) {
    const val = obj[key];
    if (val === undefined) {
      if (spec.required) return null; // missing required field → drop event
      continue; // optional absent → omit
    }
    if (!spec.check(val)) return null; // wrong type/enum → drop event
    clean[key] = spec.project ? spec.project(val) : val;
  }
  // Fields on obj that aren't in the schema are simply never copied.
  return clean as SSEEvent;
}

export interface SpawnHarnessOptions {
  scriptPath?: string;
  cwd?: string;
  /** Injectable for tests; defaults to child_process.spawn. */
  spawnFn?: (cmd: string, args: string[], options: NodeSpawnOptions) => ChildProcess;
  /** Wall-clock deadline; on expiry the child is killed and the promise rejects (T6). */
  timeoutMs?: number;
  /** Grace after SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /**
   * Additional audit observer (T7). The persisted append-only SQLite audit is ALWAYS
   * written regardless — this hook can't replace it (so a caller can't disable the
   * mandatory record); it only observes (tests, extra sinks). Best-effort.
   */
  onAudit?: (record: HarnessAuditRecord) => void;
}

/** One audit record per spawn attempt (threat model T7) — argv + outcome + ts, no secrets. */
export interface HarnessAuditRecord {
  ts: number; // epoch seconds
  cmd: HarnessSubcommand["cmd"];
  argv: string[]; // exact argv passed to harness.sh ([] if never built)
  outcome: "exit" | "timeout" | "error" | "refused" | "invalid-args";
  code?: number | null; // exit code when outcome === "exit"
  /** error CLASS name only (+ safe errno) — never the message, which can embed the rejected value. */
  error?: string;
}

const DEFAULT_SCRIPT = process.env.HARNESS_SCRIPT_PATH ?? "../.claude/skills/harness/harness.sh";
// All harness.sh subcommands are short git/python ops — a longer run means a hung
// child, which must not hold the single slot forever (threat model T6). Override
// via HARNESS_TIMEOUT_MS or opts.timeoutMs for an unusually slow host.
const DEFAULT_TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS) || 600_000; // 10 min
const DEFAULT_KILL_GRACE_MS = 5_000;

/**
 * Spawn a harness.sh subcommand and stream its structured stdout to onEvent.
 * shell:false + validated argv = no shell interpretation of any value. Raw output
 * is never forwarded — only events that pass parseHarnessLine. Resolves with the
 * exit code, or rejects with HarnessTimeoutError if the child exceeds its deadline
 * (after SIGTERM → SIGKILL), so a hung child always releases the caller's slot.
 */
export function spawnHarness(
  sub: HarnessSubcommand,
  onEvent: (event: SSEEvent) => void,
  opts: SpawnHarnessOptions = {}
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    // Audit (T7): the persisted append-only log is ALWAYS written (mandatory,
    // best-effort so a logging failure never changes control flow); onAudit is an
    // additional observer only. argv/outcome only — never stdout.
    const audit = (r: Omit<HarnessAuditRecord, "ts">) => {
      const record: HarnessAuditRecord = { ts: Math.floor(Date.now() / 1000), ...r };
      try {
        appendAudit(record);
      } catch {
        // mandatory audit is best-effort; never break the run on a logging failure
      }
      try {
        opts.onAudit?.(record);
      } catch {
        // observer is best-effort too
      }
    };
    // CRITICAL: log the error CLASS only — never the message. HarnessArgError embeds
    // the rejected value in its message, which could be sensitive; the audit must
    // never carry it. A safe errno code (E*) is allowed for forensic context.
    const errLabel = (e: unknown): string => {
      if (!(e instanceof Error)) return "Error";
      const code = (e as NodeJS.ErrnoException).code;
      return code && /^E[A-Z]+$/.test(code) ? `${e.name}:${code}` : e.name;
    };

    // promote stays preview-only until a threat model passes: refuse to spawn it
    // unless the default-off flag is explicitly enabled (defense in depth alongside
    // the approve route's own gate).
    if (sub.cmd === "promote" && process.env.ENABLE_PROMOTE_TO_MAIN !== "1") {
      audit({ cmd: sub.cmd, argv: [sub.cmd], outcome: "refused" });
      reject(new HarnessArgError("promote is disabled (ENABLE_PROMOTE_TO_MAIN not set)"));
      return;
    }
    let args: string[];
    try {
      args = buildArgs(sub); // validates BEFORE spawning; bad input → reject, never spawn
    } catch (e) {
      audit({ cmd: sub.cmd, argv: [], outcome: "invalid-args", error: errLabel(e) });
      reject(e);
      return;
    }
    const script = opts.scriptPath ?? DEFAULT_SCRIPT;
    const spawnFn = opts.spawnFn ?? nodeSpawn;
    let child: ChildProcess;
    try {
      child = spawnFn(script, args, {
        cwd: opts.cwd ?? process.env.HARNESS_REPO ?? process.cwd(),
        shell: false, // CRITICAL: never let a shell re-parse the argv
        // Own process group so a timeout can kill the whole tree (harness.sh spawns
        // git/python children); without this only the shell PID dies and children leak.
        detached: true,
      });
    } catch (e) {
      // A synchronous spawn throw (bad options, etc.) must still be audited.
      audit({ cmd: sub.cmd, argv: args, outcome: "error", error: errLabel(e) });
      reject(e);
      return;
    }
    if (!child.stdout) {
      audit({ cmd: sub.cmd, argv: args, outcome: "error", error: "no stdout" });
      reject(new Error("harness spawn produced no stdout"));
      return;
    }
    // Drain stderr so a verbose child can't fill the pipe buffer and deadlock.
    // Not forwarded to the client (may contain noise); bounded by discarding.
    child.stderr?.resume();
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const event = parseHarnessLine(line);
      if (event) onEvent(event);
    });

    // Kill the whole process group (negative pid) so children spawned by harness.sh
    // die too; fall back to the single child if there's no pid (e.g. test fakes).
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // already gone
      }
    };

    // Single-settle guard. The deadline does NOT settle the promise itself — it only
    // kills the child; the promise settles on `close` (the child actually exited).
    // This keeps the caller's slot held until the process is truly gone, so a timed-out
    // run can never overlap the next one (which would race on the git repo).
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      rl.close();
      action();
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM"); // graceful first
      killTimer = setTimeout(() => killTree("SIGKILL"), opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
      killTimer.unref?.();
      // intentionally no settle here — wait for `close` below.
    }, timeoutMs);
    deadline.unref?.();

    child.on("error", (e) =>
      finish(() => {
        audit({ cmd: sub.cmd, argv: args, outcome: "error", error: errLabel(e) });
        reject(e);
      })
    );
    child.on("close", (code) =>
      finish(() => {
        if (timedOut) {
          audit({ cmd: sub.cmd, argv: args, outcome: "timeout" });
          reject(new HarnessTimeoutError(`harness '${sub.cmd}' timed out after ${timeoutMs}ms`));
        } else {
          audit({ cmd: sub.cmd, argv: args, outcome: "exit", code });
          resolve({ code });
        }
      })
    );
  });
}

// ponytail: SIGKILL on the process group is assumed to reap the child (close fires).
// A truly unkillable child (D-state / uninterruptible kernel I/O) would leave the
// promise pending — accepted: holding the slot beats overlapping a live git mutation.
// skipped: cross-platform group kill (Windows uses taskkill /T), add if ever non-Linux.
