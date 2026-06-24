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

// Fires whose firedAt fall within this window are treated as one co-fire batch.
// The stagger applies WITHIN a batch; separate batches each start at offset 0 so a
// lone later burst is never delayed by earlier (retained) fires.
const CO_FIRE_WINDOW_S = 0.2;

/**
 * Group fires into co-fire batches by firedAt proximity; within each batch order
 * by severity desc (then firedAt) and assign peaks coFireStaggerMs apart, so the
 * highest-severity flare leads and simultaneous flares stay individually readable.
 */
export function staggerFires(events: AgentEvent[]): FireDescriptor[] {
  const byTime = [...events].sort((a, b) => a.firedAt - b.firedAt);
  const out: FireDescriptor[] = [];

  let i = 0;
  while (i < byTime.length) {
    const start = byTime[i].firedAt;
    const batch: AgentEvent[] = [];
    while (i < byTime.length && byTime[i].firedAt - start <= CO_FIRE_WINDOW_S) {
      batch.push(byTime[i]);
      i++;
    }
    batch
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.firedAt - b.firedAt)
      .forEach((e, idx) =>
        out.push({
          id: e.id,
          subtaskId: e.subtaskId,
          severity: e.severity,
          peakOffsetMs: idx * MOTION.coFireStaggerMs,
        })
      );
  }
  return out;
}
