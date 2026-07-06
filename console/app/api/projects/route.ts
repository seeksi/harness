// console/app/api/projects/route.ts
// GET /api/projects — the discovered project registry (named-roots scan) + each project's
// recent runs (retention-bounded). Node-only (fs + better-sqlite3). Recent runs are fetched
// in ONE batched query (listRecentRunsForProjects) rather than one-per-project — no N+1.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { discoverProjects } from "@/lib/server/discovery";
import { listRecentRunsForProjects, type RunRow } from "@/lib/server/persist";

export async function GET(): Promise<NextResponse> {
  try {
    const projects = discoverProjects();
    let runsByProject = new Map<string, RunRow[]>();
    try {
      runsByProject = listRecentRunsForProjects(projects.map((p) => p.id));
    } catch {
      runsByProject = new Map(); // DB not yet initialized / empty — fail open
    }
    const withRuns = projects.map((p) => ({ ...p, recentRuns: runsByProject.get(p.id) ?? [] }));
    return NextResponse.json({ projects: withRuns });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "discovery failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
