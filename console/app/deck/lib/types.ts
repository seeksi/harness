// console/app/deck/lib/types.ts
// Shared shapes for the observability deck's forensics floor. A ToolCallEvent is the
// UNIT of the trace explorer — one tool call, from one of two origins:
//   "store" — folded from RunState.trace (has run/lane/agent context, no raw args).
//   "file"  — a raw line from .claude/traces/<session>.jsonl (real hook output, but
//             no run/lane linkage — the hook only ever recorded {ts, tool, sig}).
// Neither origin carries full args/outputs/duration today (see NOTES.tracehook.md —
// the trace line format is frozen). The detail pane must say so, never fabricate it.

export interface ToolCallEvent {
  id: string; // stable: `${origin}:${runId|sessionId}:${index}`
  ts: number; // epoch-seconds
  tool: string; // event type / tool name (Read, Edit, Bash, Grep, Write, ...)
  sig: string; // stable signature of the call's input (hash or literal, origin-dependent)
  origin: "store" | "file";
  runId?: string;
  projectId?: string;
  agentId?: string;
  laneId?: string;
  sessionId?: string; // only for origin "file"
}

export interface DeckFilters {
  q?: string; // free-text search across tool/sig/agent/lane/run/session
  runId?: string;
  laneId?: string;
  agentId?: string;
  tool?: string; // "event type" per §5/§6
}
