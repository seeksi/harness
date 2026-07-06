import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { resolveProject, projectAliases, foldProjectIndex, rosterFromProject } from "./roster";

let root: string;
const OLD_ROOTS = process.env.HARNESS_PROJECT_ROOTS;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "roster-"));
  const repo = path.join(root, "harness");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const agentsDir = path.join(repo, ".claude", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, "build.md"), "---\nname: build\nmodel: sonnet\n---\n");
  process.env.HARNESS_PROJECT_ROOTS = root;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (OLD_ROOTS === undefined) delete process.env.HARNESS_PROJECT_ROOTS;
  else process.env.HARNESS_PROJECT_ROOTS = OLD_ROOTS;
});

describe("resolveProject — basename OR slug, server-side", () => {
  it("resolves the current opaque discovery slug", () => {
    const bySlug = resolveProject(`harness-${slugHash()}`);
    expect(bySlug?.name).toBe("harness");
  });

  it("resolves a legacy basename (bare folder name) to the same project", () => {
    const byBasename = resolveProject("harness");
    expect(byBasename?.name).toBe("harness");
    expect(byBasename?.id).toMatch(/^harness-[0-9a-f]{8}$/);
  });

  it("returns undefined for an id matching neither shape", () => {
    expect(resolveProject("no-such-project")).toBeUndefined();
  });
});

describe("projectAliases", () => {
  it("includes both the canonical slug and the bare basename", () => {
    const project = resolveProject("harness")!;
    const aliases = projectAliases(project);
    expect(aliases).toContain(project.id);
    expect(aliases).toContain("harness");
  });
});

describe("foldProjectIndex — no double-listing across legacy-basename vs slug ids", () => {
  it("folds a run stamped with a legacy basename into the discovered project's slug entry", () => {
    const project = resolveProject("harness")!;
    const runs = [{ projectId: "harness", projectName: "harness-fixture-name" }];
    const out = foldProjectIndex(runs, [project]);
    expect(out.size).toBe(1);
    expect(out.get(project.id)).toBe(project.name); // discovered name wins, one row
    expect(out.has("harness")).toBe(false); // no separate legacy-basename row
  });

  it("keeps a run whose projectId matches no discovered project as its own entry", () => {
    const runs = [{ projectId: "fixture-only", projectName: "Fixture Only" }];
    const out = foldProjectIndex(runs, []);
    expect(out.get("fixture-only")).toBe("Fixture Only");
  });

  it("adds discovered projects with no observed runs", () => {
    const project = resolveProject("harness")!;
    const out = foldProjectIndex([], [project]);
    expect(out.get(project.id)).toBe(project.name);
  });

  it("does not duplicate when the run's projectId already matches the canonical slug", () => {
    const project = resolveProject("harness")!;
    const runs = [{ projectId: project.id, projectName: project.name }];
    const out = foldProjectIndex(runs, [project]);
    expect(out.size).toBe(1);
  });
});

describe("rosterFromProject — unaffected by the resolution change", () => {
  it("still reads the roster off the resolved project's real path", () => {
    const project = resolveProject("harness")!;
    const agents = rosterFromProject(project);
    expect(agents.map((a) => a.id)).toEqual(["build"]);
  });
});

// The discovery slug is basename + sha1(abs path).slice(0,8) — recomputed here (not
// imported) to keep this test independent of discovery.ts's internals; if the hash
// algorithm ever changes this assertion breaks loudly rather than silently drifting.
function slugHash(): string {
  const abs = path.resolve(path.join(root, "harness"));
  return crypto.createHash("sha1").update(abs).digest("hex").slice(0, 8);
}
