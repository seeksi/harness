// console/lib/contract/health.ts
// The EFFECTIVE health verdict per §6: combines the producer-reported verdict with
// client-side staleness and amber conditions. Pure + deterministic (nowSec injected)
// so the staleness rule is unit-testable without a clock.
//
//   stuck    = producer said stuck, OR an incomplete run went silent past the 60s
//              staleness window (no events while a phase is unfinished).
//   degraded = producer said degraded, OR the feed is stale-but-within-window, OR any
//              gate is raised, OR any lane crossed the soft context threshold.
//   healthy  = events flowing, no raised gates, no amber conditions.

import type { RunState, HealthVerdict } from "./types";
import { STALENESS_WINDOW_SEC, CONTEXT_SOFT } from "./types";
import { contextFill, hasRaisedGate } from "./selectors";

export interface HealthInput {
  run: RunState;
  nowSec: number;
  // The SSE connection dropped: feed is frozen. Forces at least "degraded".
  feedStale?: boolean;
}

export function deriveHealth({ run, nowSec, feedStale }: HealthInput): HealthVerdict {
  const runIncomplete = run.status === "running" && run.phases.some((p) => p.status !== "done");
  const silenceSec = nowSec - run.lastEventTs;

  if (run.reportedHealth === "stuck") return "stuck";
  if (runIncomplete && silenceSec > STALENESS_WINDOW_SEC) return "stuck";

  if (run.reportedHealth === "degraded") return "degraded";
  if (feedStale) return "degraded";
  if (hasRaisedGate(run)) return "degraded";
  if (contextFill(run) >= CONTEXT_SOFT) return "degraded";

  return "healthy";
}

// Seconds of silence — drives the "data as of hh:mm:ss" staleness badge copy.
export function silenceSeconds(run: RunState, nowSec: number): number {
  return Math.max(0, nowSec - run.lastEventTs);
}
