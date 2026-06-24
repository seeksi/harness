// web/hud/a11y/announce.ts — Lane C sole writer.
// Announcement copy patterns for aria-live regions.
// Every status change must pair with a persistent non-color text badge (WCAG 1.4.1).
// The `polite`/`assertive` split is decided here; callers never override it.

import type { PhaseId, GateId, Severity, SubtaskStatus } from "@/lib/contract/types";

// Badge labels for status — persistent text, never colour-only (WCAG 1.4.1).
export const STATUS_BADGE: Record<SubtaskStatus, string> = {
  pending: "[PENDING]",
  building: "[BUILDING]",
  reviewed: "[REVIEWED]",
  merged: "[MERGED]",
  blocked: "[BLOCKED]",
};

export const PHASE_LABELS: Record<PhaseId, string> = {
  1: "Decompose",
  2: "Build",
  3: "Route-cost",
  4: "Cross-review",
  5: "Merge",
  6: "Eval + Promote",
};

/**
 * Urgency tier — drives the aria-live politeness choice.
 * Only `severity: "critical"` gate escalations are assertive (WCAG contrast/interrupt rule).
 * Everything else is polite (does not interrupt the user's current focus).
 */
export type Urgency = "polite" | "assertive";

export function gateUrgency(severity: Severity): Urgency {
  return severity === "critical" ? "assertive" : "polite";
}

// ── Copy patterns ─────────────────────────────────────────────────────────────

export function announcePhaseChange(phase: PhaseId, status: "idle" | "active" | "done" | "blocked"): string {
  const label = PHASE_LABELS[phase];
  switch (status) {
    case "active":  return `Phase ${phase} ${label}: started.`;
    case "done":    return `Phase ${phase} ${label}: complete.`;
    case "blocked": return `Phase ${phase} ${label}: BLOCKED — action required.`;
    default:        return `Phase ${phase} ${label}: idle.`;
  }
}

export function announceGateRaised(gateId: GateId, severity: Severity, summary: string): string {
  const tier = severity.toUpperCase();
  return `Gate ${gateId} raised — ${tier}: ${summary}`;
}

export function announceGateResolved(gateId: GateId): string {
  return `Gate ${gateId} resolved — clear.`;
}

// Automated verify path: a lane's commit is confirmed (e.g. Gate B "clear").
// Carries the event summary so the operator is told *what* cleared (the commit).
export function announceGateCleared(gateId: GateId, summary: string): string {
  return `Gate ${gateId} clear — ${summary}`;
}

export function announceSubtaskStatus(id: string, status: SubtaskStatus): string {
  return `Subtask ${id}: ${STATUS_BADGE[status]}`;
}
