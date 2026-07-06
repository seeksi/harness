// console/app/deck/api/diff/route.ts
// GET /deck/api/diff?project=<discovered-project-id>&sha=<commit-ish>
// Read-only `git show` for the per-worktree-commit diff viewer (§5/§6). Trust
// boundary: `project` must be one of the server's OWN discovered project roots
// (lib/server/discovery.ts) — never an arbitrary path — and `sha` must pass the
// flag-injection-safe commit-ish shape. See lib/gitDiff.ts for both gates.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { discoverProjects } from "@/lib/server/discovery";
import { isValidCommittish, isValidRepoRoot, gitShow } from "@/app/deck/lib/gitDiff";

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const project = url.searchParams.get("project");
  const sha = url.searchParams.get("sha");

  if (!project || !sha) {
    return NextResponse.json({ error: "project and sha are required" }, { status: 400 });
  }
  if (!isValidCommittish(sha)) {
    return NextResponse.json({ error: "invalid commit-ish" }, { status: 400 });
  }

  let allowed: string[];
  try {
    allowed = discoverProjects().map((p) => p.path);
  } catch {
    allowed = [];
  }
  if (!isValidRepoRoot(project, allowed)) {
    return NextResponse.json({ error: "project is not a discovered repo" }, { status: 400 });
  }

  try {
    const diff = await gitShow(project, sha);
    return NextResponse.json({ project, sha, diff });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "git show failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
