// web/lib/daemon/harness-bridge.ts
// Stub: maps harness.sh subcommand stdout → SSEEvent[]
//
// ponytail: real implementation — each subcommand emits line-delimited JSON on
// stdout; this module spawns the subcommand via child_process.spawn, reads lines,
// and maps them to SSEEvents as follows:
//
//   budget <plan.jsonl>  → "gate" A event (exit 0 = clear, exit 1 = raised)
//   wt-new <slug>        → "phase" + "subtask" events (pending → building)
//   integ-start          → "phase" 5 active event
//   integ-merge <slug>   → "subtask" merged or "gate" C (conflict) event
//   trace <session>      → "gate" D event (LOOP/EXPLOSION/THRASH anomaly flags)
//   promote              → "phase" 6 done + "approval" approved event (preview only)
//
// Security: subcommand args are ALWAYS built from validated server-side enums
// (slug ∈ NOTES.md allowlist, session id validated to hex/alphanum) — never from
// raw client strings. The mapping lives entirely in this module; routes only call
// typed functions exported here.

export type HarnessSubcommand =
  | { cmd: "budget"; planPath: string }
  | { cmd: "wt-new"; slug: string }
  | { cmd: "integ-start" }
  | { cmd: "integ-merge"; slug: string }
  | { cmd: "trace"; session: string }
  | { cmd: "promote" };

// ponytail: add when real harness.sh spawning replaces the dry-run fixture.
// upgrade path: import { spawn } from "child_process"; build args from HarnessSubcommand;
// readline the stdout; parse JSON lines → SSEEvent[]; reject any unrecognized line.
export function buildArgs(_sub: HarnessSubcommand): string[] {
  throw new Error("harness-bridge: real spawn not implemented in this increment (dry-run only)");
}
