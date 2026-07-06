// console/app/deck/api/diff/route.test.ts
// The client sends an OPAQUE discovered-project id (never a filesystem path) — the
// route resolves it server-side against a fresh discoverProjects() call
// (resolveProjectPath, see lib/gitDiff.ts). Regression coverage for the reviewed
// id/path contract mismatch: a valid, discovered project must not get rejected.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { GET } from "./route";
import { discoverProjects } from "@/lib/server/discovery";

describe("GET /deck/api/diff", () => {
  let rootsDir: string;
  let repoDir: string;
  let sha: string;
  let prevRoots: string | undefined;

  beforeAll(() => {
    rootsDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-diff-route-"));
    repoDir = path.join(rootsDir, "myrepo");
    fs.mkdirSync(path.join(repoDir, ".claude", "agents"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "f.txt"), "hello\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoDir });
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir }).toString().trim();

    prevRoots = process.env.HARNESS_PROJECT_ROOTS;
    process.env.HARNESS_PROJECT_ROOTS = rootsDir;
  });

  afterAll(() => {
    if (prevRoots === undefined) delete process.env.HARNESS_PROJECT_ROOTS;
    else process.env.HARNESS_PROJECT_ROOTS = prevRoots;
    fs.rmSync(rootsDir, { recursive: true, force: true });
  });

  it("resolves a discovered project's id (server-produced, never client-typed) to a working diff", async () => {
    const [project] = discoverProjects();
    expect(project).toBeDefined();

    const req = new Request(`http://localhost/deck/api/diff?project=${encodeURIComponent(project.id)}&sha=${sha}`);
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.diff).toContain("hello");
    expect(body.diff).toContain("f.txt");
  });

  it("rejects an id that isn't in the discovery registry, even if it's shaped like a real path", async () => {
    const req = new Request(`http://localhost/deck/api/diff?project=${encodeURIComponent(repoDir + "-not-registered")}&sha=${sha}`);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid commit-ish before resolving the project at all", async () => {
    const [project] = discoverProjects();
    const req = new Request(`http://localhost/deck/api/diff?project=${encodeURIComponent(project.id)}&sha=${encodeURIComponent("--upload-pack=x")}`);
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("400s when either param is missing", async () => {
    const res = await GET(new Request(`http://localhost/deck/api/diff?sha=${sha}`));
    expect(res.status).toBe(400);
  });
});
