// console/lib/server/discovery.ts
// Project auto-discovery over a NAMED-ROOTS config. A project = a git repo (has
// `.git`) that carries `.claude/agents/` (harness-compatible). We scan each root
// itself and its immediate children (one level deep — lazy; deep recursion isn't
// needed for the flat project layout). `_agent-library` is archived scaffolding,
// NOT live agent definitions — excluded by path. Node-only (fs).

import fs from "fs";
import path from "path";

export interface Project {
  id: string; // stable: absolute repo path
  name: string; // basename
  path: string;
  agentCount: number; // number of *.md agent definitions found
}

// Default roots — overridable via HARNESS_PROJECT_ROOTS (":"-separated absolute dirs).
const DEFAULT_ROOTS = [
  process.env.HOME ? path.join(process.env.HOME, "HARNESS") : "/home/alter/HARNESS",
  process.env.HOME ? path.join(process.env.HOME, "AGENTS") : "/home/alter/AGENTS",
  process.env.HOME ? path.join(process.env.HOME, "projects") : "/home/alter/projects",
];

export function configuredRoots(): string[] {
  const env = process.env.HARNESS_PROJECT_ROOTS;
  if (env && env.trim()) return env.split(":").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_ROOTS;
}

const EXCLUDE_SEGMENT = "_agent-library";

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function agentDefsCount(repo: string): number {
  const dir = path.join(repo, ".claude", "agents");
  if (!isDir(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

// A repo qualifies if it has BOTH .git and .claude/agents/ and isn't the archive.
function qualifies(repo: string): Project | null {
  if (repo.split(path.sep).includes(EXCLUDE_SEGMENT)) return null;
  if (!isDir(path.join(repo, ".git")) && !fs.existsSync(path.join(repo, ".git"))) return null;
  if (!isDir(path.join(repo, ".claude", "agents"))) return null;
  return { id: repo, name: path.basename(repo), path: repo, agentCount: agentDefsCount(repo) };
}

export function discoverProjects(roots: string[] = configuredRoots()): Project[] {
  const found = new Map<string, Project>();
  for (const root of roots) {
    if (!isDir(root)) continue;
    // The root itself may be a repo.
    const rootProj = qualifies(root);
    if (rootProj) found.set(rootProj.id, rootProj);
    // …and each immediate child.
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === EXCLUDE_SEGMENT) continue;
      const child = path.join(root, name);
      if (!isDir(child)) continue;
      const proj = qualifies(child);
      if (proj) found.set(proj.id, proj);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
