// console/lib/routes.ts
// Pure route-building helpers — the single place that assembles a run's focus
// path, so navigation targets (router.push, <a href>) never hand-assemble the
// URL inline.

/** The run-focus deep link for a run (§4/§5): /run/[id]. */
export function runRoute(runId: string): string {
  return `/run/${encodeURIComponent(runId)}`;
}
