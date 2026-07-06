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
