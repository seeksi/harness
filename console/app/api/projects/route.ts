// console/app/api/projects/route.ts
// GET /api/projects — the discovered project registry (named-roots scan) + each
// project's recent runs (retention-bounded). Node-only (fs + better-sqlite3).
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { discoverProjects } from "@/lib/server/discovery";
import { listRecentRuns } from "@/lib/server/persist";

export async function GET(): Promise<NextResponse> {
  try {
    const projects = discoverProjects();
    const withRuns = projects.map((p) => {
      let recentRuns: ReturnType<typeof listRecentRuns> = [];
      try {
        recentRuns = listRecentRuns(p.id);
      } catch {
        recentRuns = []; // DB not yet initialized / empty — fail open
      }
      return { ...p, recentRuns };
    });
    return NextResponse.json({ projects: withRuns });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "discovery failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
