import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { GET } from "./route";
import { resetDb } from "@/lib/server/persist";

let root: string;
const OLD_ROOTS = process.env.HARNESS_PROJECT_ROOTS;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "proj-route-"));
  const repo = path.join(root, "alpha");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const agentsDir = path.join(repo, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "build.md"), "# agent");
  process.env.HARNESS_PROJECT_ROOTS = root;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (OLD_ROOTS === undefined) delete process.env.HARNESS_PROJECT_ROOTS;
  else process.env.HARNESS_PROJECT_ROOTS = OLD_ROOTS;
});

beforeEach(() => resetDb(":memory:"));

describe("GET /api/projects — no fs path leak", () => {
  it("response contains only the client contract fields — never the absolute fs path", async () => {
    const res = await GET();
    const body = (await res.json()) as { projects: Array<Record<string, unknown>> };
    expect(body.projects.length).toBeGreaterThan(0);
    for (const p of body.projects) {
      expect(Object.keys(p).sort()).toEqual(["agentCount", "id", "name", "recentRuns"]);
      expect(p).not.toHaveProperty("path");
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("/home/");
    expect(raw).not.toContain(root);
  });
});
