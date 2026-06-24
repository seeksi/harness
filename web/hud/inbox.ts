// web/hud/inbox.ts
// Pure derivation of the inbox rail — the SINGLE authoritative triage/action line
// (design package §attention-model). Each item must convey exactly four things:
// that it requires the operator, which subtask, the severity count, and a one-line
// what. Raised gates and awaiting approvals become items, severity-ordered.

import type { RunState, Gate, Severity } from "@/lib/contract/types";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

// Gate id → the pipeline concern it represents (for the action line's "what" word).
const GATE_WORD: Record<string, string> = {
  A: "budget",
  B: "review",
  C: "merge",
  D: "trajectory",
};

export interface InboxItem {
  id: string;
  kind: "gate" | "approval";
  severity: Severity;
  subtaskId?: string;
  /** severity count, e.g. "2 High" / "1 Critical". */
  count: string;
  /** one-line what. */
  summary: string;
  /** the four-fact action line. */
  line: string;
}

function gateCount(g: Gate): string {
  const c = g.counts;
  if (c?.critical) return `${c.critical} Critical`;
  if (c?.high) return `${c.high} High`;
  // fall back to the gate's own severity
  return `1 ${g.severity[0].toUpperCase()}${g.severity.slice(1)}`;
}

/** Derive the severity-ordered inbox items from the current run state. */
export function deriveInbox(state: RunState): InboxItem[] {
  const items: InboxItem[] = [];

  for (const g of state.gates) {
    if (g.status !== "raised") continue;
    const word = GATE_WORD[g.id] ?? "gate";
    const count = gateCount(g);
    const subtask = g.subtaskId ?? "—";
    items.push({
      id: `gate-${g.id}`,
      kind: "gate",
      severity: g.severity,
      subtaskId: g.subtaskId,
      count,
      summary: g.summary,
      line: `Gate ${g.id} · ${word} · ${subtask} · ${count}`,
    });
  }

  for (const p of state.phases) {
    if (p.approval?.state !== "awaiting") continue;
    items.push({
      id: `approval-${p.id}`,
      kind: "approval",
      severity: "info",
      count: "1 Awaiting",
      summary: `${p.approval.kind} awaiting your decision`,
      line: `Approval · ${p.approval.kind} · phase ${p.id} · awaiting`,
    });
  }

  return items.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}
