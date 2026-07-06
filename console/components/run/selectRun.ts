// console/components/run/selectRun.ts
// Route-param wiring: resolve the run for the /run/[id] route out of FleetState.
// Pure + framework-agnostic so it's testable without a DOM: the page passes
// whatever Next hands it for the dynamic segment (a string; a catch-all would be
// an array — handled defensively even though [id] never sends one today).

import type { FleetState, RunState } from "@/lib/contract/types";

export interface RunLookup {
  runId: string;
  run: RunState | undefined;
  notFound: boolean;
}

export function lookupRun(state: FleetState, idParam: string | string[] | undefined): RunLookup {
  const runId = Array.isArray(idParam) ? (idParam[0] ?? "") : (idParam ?? "");
  const run = runId ? state.runs[runId] : undefined;
  return { runId, run, notFound: !run };
}
