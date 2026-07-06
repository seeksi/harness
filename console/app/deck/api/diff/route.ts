// console/app/deck/api/diff/route.ts
// GET /deck/api/diff?project=<opaque discovered-project id>&sha=<commit-ish>
// Read-only `git show` for the per-worktree-commit diff viewer (§5/§6). `project` is
// an OPAQUE id from the discovery registry — never a filesystem path the client hands
// back — resolved server-side (resolveProjectPath) against a FRESH discoverProjects()
// call to one of the server's own discovered project roots. `sha` must pass the
// flag-injection-safe commit-ish shape. gitShow re-checks the allowlist itself, so this
// route's own check is defense in depth, not the only gate. See lib/gitDiff.ts.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { discoverProjects } from "@/lib/server/discovery";
import { isValidCommittish, resolveProjectPath, gitShow } from "@/app/deck/lib/gitDiff";

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

  let discovered: Array<{ id: string; path: string }>;
  try {
    discovered = discoverProjects();
  } catch {
    discovered = [];
  }
  const repoPath = resolveProjectPath(project, discovered);
  if (!repoPath) {
    return NextResponse.json({ error: "project is not a discovered repo" }, { status: 400 });
  }

  try {
    const diff = await gitShow(repoPath, sha, discovered.map((p) => p.path));
    return NextResponse.json({ project, sha, diff });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "git show failed";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
