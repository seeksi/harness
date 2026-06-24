// web/scene/agentFire.ts
// Pure co-fire stagger logic (design package §D rule): when multiple agent-fires
// land together, two simultaneous flares of different hues read as one event, so
// bursts are severity-ordered and offset 80–120ms apart to stay individually
// readable as spatial locators. The per-burst intensity envelope lives in motion.ts.

import type { AgentEvent, Severity } from "@/lib/contract/types";
import { MOTION } from "./motion";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s] ?? 0;
}

export interface FireDescriptor {
  id: string;
  subtaskId: string;
  severity: Severity;
  /** ms offset of this burst's peak from the group start (severity-ordered). */
  peakOffsetMs: number;
}

/**
 * Order co-fires by severity desc (then firedAt) and assign each a peak offset
 * coFireStaggerMs apart, so the highest-severity flare leads and co-fires stay
 * individually readable.
 */
export function staggerFires(events: AgentEvent[]): FireDescriptor[] {
  const sorted = [...events].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || a.firedAt - b.firedAt
  );
  return sorted.map((e, i) => ({
    id: e.id,
    subtaskId: e.subtaskId,
    severity: e.severity,
    peakOffsetMs: i * MOTION.coFireStaggerMs,
  }));
}
