// console/app/deck/lib/filters.ts
// Pure filter/search logic over the trace-forensics event list (§5/§6: "search across
// trace forensics; filters in deck: run, lane, agent, event type"). No React, no I/O —
// unit-testable in isolation from the store/SSE machinery.

import type { ToolCallEvent, DeckFilters } from "./types";
import type { FleetState } from "@/lib/contract/types";
import type { RawTraceLine } from "./traceFile";

// Fold the live/SSR fleet store into the flat forensics list. Every "trace" envelope
// already folded into RunState.trace becomes one ToolCallEvent (origin "store").
export function deriveStoreEvents(state: FleetState): ToolCallEvent[] {
  const out: ToolCallEvent[] = [];
  for (const runId of state.order) {
    const run = state.runs[runId];
    if (!run) continue;
    run.trace.forEach((tick, i) => {
      out.push({
        id: `store:${runId}:${i}`,
        ts: tick.ts,
        tool: tick.tool,
        sig: tick.sig,
        origin: "store",
        runId,
        projectId: run.projectId,
        agentId: tick.agentId,
        laneId: tick.laneId,
      });
    });
  }
  return out;
}

// Fold a loaded raw session file (.claude/traces/<sessionId>.jsonl) into the same flat
// forensics list as deriveStoreEvents, so its lines are searchable/filterable in the
// main trace explorer — the origin:"file" ToolCallEvent variant this constructs is the
// real hook data with no run/lane/agent linkage (see types.ts).
export function deriveFileEvents(sessionId: string, lines: RawTraceLine[]): ToolCallEvent[] {
  return lines.map((l, i) => ({
    id: `file:${sessionId}:${i}`,
    ts: l.ts,
    tool: l.tool,
    sig: l.sig,
    origin: "file",
    sessionId,
  }));
}

function haystack(ev: ToolCallEvent): string {
  return [ev.tool, ev.sig, ev.agentId, ev.laneId, ev.runId, ev.sessionId, ev.projectId]
    .filter((v): v is string => Boolean(v))
    .join(" ")
    .toLowerCase();
}

export function filterEvents(events: ToolCallEvent[], f: DeckFilters): ToolCallEvent[] {
  const q = f.q?.trim().toLowerCase();
  return events.filter((ev) => {
    if (f.runId && ev.runId !== f.runId) return false;
    if (f.laneId && ev.laneId !== f.laneId) return false;
    if (f.agentId && ev.agentId !== f.agentId) return false;
    if (f.tool && ev.tool !== f.tool) return false;
    if (q && !haystack(ev).includes(q)) return false;
    return true;
  });
}

// Distinct, sorted values present in an (already-narrowed) event set — the filter
// bar's dropdown options never offer a facet value that would yield zero results.
export function facetValues(events: ToolCallEvent[], key: "runId" | "laneId" | "agentId" | "tool"): string[] {
  const set = new Set<string>();
  for (const ev of events) {
    const v = ev[key];
    if (v) set.add(v);
  }
  return [...set].sort();
}

export function sortByTs(events: ToolCallEvent[], dir: "asc" | "desc" = "asc"): ToolCallEvent[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...events].sort((a, b) => sign * (a.ts - b.ts) || a.id.localeCompare(b.id));
}
