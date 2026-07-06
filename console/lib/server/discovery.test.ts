import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { discoverProjects } from "./discovery";

let root: string;

function mkRepo(dir: string, agents: string[], withGit = true, withAgentsDir = true) {
  fs.mkdirSync(dir, { recursive: true });
  if (withGit) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  if (withAgentsDir) {
    const ad = path.join(dir, ".claude", "agents");
    fs.mkdirSync(ad, { recursive: true });
    for (const a of agents) fs.writeFileSync(path.join(ad, a), "# agent");
  }
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "disc-"));
  mkRepo(path.join(root, "alpha"), ["build.md", "review.md"]);
  mkRepo(path.join(root, "beta"), ["one.md"]);
  mkRepo(path.join(root, "no-agents"), [], true, false); // git but no .claude/agents
  mkRepo(path.join(root, "no-git"), ["x.md"], false, true); // agents but no .git
  mkRepo(path.join(root, "_agent-library"), ["lib.md"]); // archived — must be excluded
  fs.mkdirSync(path.join(root, "plain-dir"), { recursive: true }); // not a repo
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("discoverProjects", () => {
  it("finds qualifying repos (git + .claude/agents) and counts agent defs", () => {
    const projects = discoverProjects([root]);
    const names = projects.map((p) => p.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(projects.find((p) => p.name === "alpha")!.agentCount).toBe(2);
  });

  it("excludes non-repos, agent-less repos, and non-git dirs", () => {
    const names = discoverProjects([root]).map((p) => p.name);
    expect(names).not.toContain("no-agents");
    expect(names).not.toContain("no-git");
    expect(names).not.toContain("plain-dir");
  });

  it("excludes the archived _agent-library scaffolding", () => {
    const names = discoverProjects([root]).map((p) => p.name);
    expect(names).not.toContain("_agent-library");
  });

  it("returns [] for a missing root without throwing", () => {
    expect(discoverProjects([path.join(root, "does-not-exist")])).toEqual([]);
  });

  it("dedupes and sorts by name", () => {
    const projects = discoverProjects([root, root]);
    const names = projects.map((p) => p.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("discoverProjects — opaque id shape", () => {
  it("id is never the filesystem path — a basename-hash slug instead", () => {
    const alpha = discoverProjects([root]).find((p) => p.name === "alpha")!;
    expect(alpha.id).not.toBe(alpha.path);
    expect(alpha.id).not.toContain(path.sep);
    expect(alpha.id).toMatch(/^alpha-[0-9a-f]{8}$/);
    // `path` still carries the real fs location for server-side use.
    expect(alpha.path).toBe(path.join(root, "alpha"));
  });

  it("id is deterministic across repeated discovery calls (no persisted mapping needed)", () => {
    const a = discoverProjects([root]).find((p) => p.name === "alpha")!.id;
    const b = discoverProjects([root]).find((p) => p.name === "alpha")!.id;
    expect(a).toBe(b);
  });

  it("repos sharing a basename under different roots get distinct, stable ids", () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "disc-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "disc-b-"));
    try {
      mkRepo(path.join(rootA, "same"), ["x.md"]);
      mkRepo(path.join(rootB, "same"), ["y.md"]);
      const matches = discoverProjects([rootA, rootB]).filter((p) => p.name === "same");
      expect(matches).toHaveLength(2);
      expect(matches[0].id).not.toBe(matches[1].id);
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});
