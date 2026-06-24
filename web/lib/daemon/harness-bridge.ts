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

export type HarnessSubcommand =
  | { cmd: "budget"; planFile: string }
  | { cmd: "wt-new"; slug: string }
  | { cmd: "integ-start" }
  | { cmd: "integ-merge"; slug: string }
  | { cmd: "trace"; session: string }
  | { cmd: "promote" };

export class HarnessArgError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HarnessArgError";
  }
}

// Strict validators — anything outside these patterns is rejected outright.
const SLUG = /^[a-z][a-z0-9-]{0,30}$/; // worktree/lane slug: lowercase, no separators
const SESSION = /^[A-Za-z0-9_-]{1,64}$/; // trace session id: hex/alphanum
const PLAN_FILE = /^[A-Za-z0-9._-]+$/; // bare filename only — no path separators, no ..

function check(pattern: RegExp, value: string, what: string): string {
  if (typeof value !== "string" || !pattern.test(value) || value.includes("..")) {
    throw new HarnessArgError(`invalid ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Build the exact argv for harness.sh from a validated subcommand. Throws
 * HarnessArgError on any value that isn't a clean enum/pattern match. The result
 * is passed to spawn with shell:false, so no value is ever shell-interpreted.
 */
export function buildArgs(sub: HarnessSubcommand): string[] {
  switch (sub.cmd) {
    case "budget":
      return ["budget", check(PLAN_FILE, sub.planFile, "plan file")];
    case "wt-new":
      return ["wt-new", check(SLUG, sub.slug, "slug")];
    case "integ-start":
      return ["integ-start"];
    case "integ-merge":
      return ["integ-merge", check(SLUG, sub.slug, "slug")];
    case "trace":
      return ["trace", check(SESSION, sub.session, "session")];
    case "promote":
      return ["promote"];
    default: {
      // exhaustiveness guard
      const _never: never = sub;
      throw new HarnessArgError(`unknown subcommand: ${JSON.stringify(_never)}`);
    }
  }
}

// `hello` is intentionally excluded — the SSE stream route owns the resync
// snapshot; the harness producer only emits deltas.
const KNOWN_EVENT_TYPES = new Set([
  "phase",
  "subtask",
  "gate",
  "agentFire",
  "trace",
  "budget",
  "approval",
]);

/**
 * Parse one stdout line into an SSEEvent. Expects line-delimited JSON (the
 * harness.sh event contract); any non-JSON line or unknown `type` is ignored
 * (returns null) so human-readable output never leaks to the client and unknown
 * shapes can't be injected.
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
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { type?: unknown }).type !== "string" ||
    !KNOWN_EVENT_TYPES.has((parsed as { type: string }).type)
  ) {
    return null;
  }
  return parsed as SSEEvent;
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
