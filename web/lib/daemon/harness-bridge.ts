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
import type { SSEEvent } from "@/lib/contract/events";
import { isLane, isSession, isPlanFile } from "./registry";
import { HarnessArgError } from "./errors";

export type HarnessSubcommand =
  | { cmd: "budget"; planFile: string }
  | { cmd: "wt-new"; slug: string }
  | { cmd: "integ-start" }
  | { cmd: "integ-merge"; slug: string }
  | { cmd: "trace"; session: string }
  | { cmd: "promote" };

// Re-exported for callers/tests that import it from the bridge; defined in errors.ts
// to keep registry.ts ↔ harness-bridge.ts free of a circular dependency.
export { HarnessArgError };

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

/**
 * Build the exact argv for harness.sh from a validated subcommand. Throws
 * HarnessArgError on any value that isn't server-minted. The result is passed to
 * spawn with shell:false, so no value is ever shell-interpreted.
 */
export function buildArgs(sub: HarnessSubcommand): string[] {
  switch (sub.cmd) {
    case "budget":
      return ["budget", requirePlanFile(sub.planFile)];
    case "wt-new":
      return ["wt-new", requireLane(sub.slug)];
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
}

const DEFAULT_SCRIPT = process.env.HARNESS_SCRIPT_PATH ?? "../.claude/skills/harness/harness.sh";

/**
 * Spawn a harness.sh subcommand and stream its structured stdout to onEvent.
 * shell:false + validated argv = no shell interpretation of any value. Raw output
 * is never forwarded — only events that pass parseHarnessLine. Resolves with the
 * exit code.
 */
export function spawnHarness(
  sub: HarnessSubcommand,
  onEvent: (event: SSEEvent) => void,
  opts: SpawnHarnessOptions = {}
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    // promote stays preview-only until a threat model passes: refuse to spawn it
    // unless the default-off flag is explicitly enabled (defense in depth alongside
    // the approve route's own gate).
    if (sub.cmd === "promote" && process.env.ENABLE_PROMOTE_TO_MAIN !== "1") {
      reject(new HarnessArgError("promote is disabled (ENABLE_PROMOTE_TO_MAIN not set)"));
      return;
    }
    let args: string[];
    try {
      args = buildArgs(sub); // validates BEFORE spawning; bad input → reject, never spawn
    } catch (e) {
      reject(e);
      return;
    }
    const script = opts.scriptPath ?? DEFAULT_SCRIPT;
    const spawnFn = opts.spawnFn ?? nodeSpawn;
    const child = spawnFn(script, args, {
      cwd: opts.cwd ?? process.env.HARNESS_REPO ?? process.cwd(),
      shell: false, // CRITICAL: never let a shell re-parse the argv
    });
    if (!child.stdout) {
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
    child.on("error", reject);
    child.on("close", (code) => {
      rl.close();
      resolve({ code });
    });
  });
}
