// web/lib/memory/s7Account.ts
// S7 (run accounting) write-point helper. Translates one harness run's outcomes
// into proposeFromHarness calls against the single `harness` memory-os project.
// Lane identity travels as lane_id/subtask_slug fields on each record — never
// one memory-os project per lane. Inherits all proposeFromHarness guarantees
// (secret prefilter, ENABLE_MEMORY_OS gate, fail-open queueing, never throws).

import { proposeFromHarness, type ProposeResult } from "./proposeFromHarness";

const SLUG = "harness";

export interface S7Accounting {
  laneId: string;
  /** Actual spend for the run (USD). */
  costActual?: number;
  /** Route-cost estimate context; taskShape keys the cost_actual topic. */
  estimates?: { taskShape?: string; estimatedUsd?: number };
  /** Cross-review BLOCK verdicts worth remembering as decisions. */
  reviewBlocks?: Array<{ pattern: string; severity?: string; subtaskSlug?: string }>;
  /** Eval-gate capability scores, recorded as task records. */
  capabilityScores?: Array<{ name: string; score: number; subtaskSlug?: string }>;
  traceSummary?: string;
}

/**
 * Issue the S7 memory writes for one run. Returns each propose outcome (in the
 * order issued) so the caller can log/queue-inspect; failures are already handled
 * downstream (queued/rejected statuses), so callers need not branch on them.
 */
export async function accountS7(a: S7Accounting): Promise<ProposeResult[]> {
  const results: ProposeResult[] = [];

  // Cost actuals: decision keyed on topic "cost_actual:<task-shape>" so a newer
  // actual for the same shape supersedes the old one (engine supersedes by topic).
  if (a.costActual !== undefined) {
    const shape = a.estimates?.taskShape ?? "unknown";
    results.push(
      await proposeFromHarness(SLUG, "decision", {
        topic: `cost_actual:${shape}`,
        decision:
          `actual $${a.costActual.toFixed(4)}` +
          (a.estimates?.estimatedUsd !== undefined ? ` vs estimated $${a.estimates.estimatedUsd.toFixed(4)}` : "") +
          ` for task shape '${shape}'`,
        impact: "low",
        confidence: "high",
        source: "agent_inferred",
        lane_id: a.laneId,
        ...(a.traceSummary ? { trace_summary: a.traceSummary } : {}),
      })
    );
  }

  // Review BLOCK patterns: decisions so recurring block causes become retrievable
  // context for future routing/review (human-gated via 'provisional').
  for (const b of a.reviewBlocks ?? []) {
    results.push(
      await proposeFromHarness(SLUG, "decision", {
        topic: `review_block:${b.pattern}`,
        decision: `cross-review BLOCK on pattern '${b.pattern}'` + (b.severity ? ` (severity ${b.severity})` : ""),
        impact: "medium",
        confidence: "medium",
        source: "agent_inferred",
        lane_id: a.laneId,
        ...(b.subtaskSlug ? { subtask_slug: b.subtaskSlug } : {}),
      })
    );
  }

  // Capability scores: task records (safe_autonomous in memory-os => 'committed').
  for (const c of a.capabilityScores ?? []) {
    results.push(
      await proposeFromHarness(SLUG, "task", {
        summary: `capability score '${c.name}': ${c.score}`,
        status: "done", // engine's default 'active' is not in the task enum
        lane_id: a.laneId,
        ...(c.subtaskSlug ? { subtask_slug: c.subtaskSlug } : {}),
      })
    );
  }

  return results;
}
