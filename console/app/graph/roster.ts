// console/app/graph/roster.ts — server-only helper (fs). Resolves a graph route's
// `projectId` against the discovery registry and reads its `.claude/agents/*.md`
// roster (frontmatter only: name/model) into graph.model's RosterAgent shape.
// Best-effort throughout: a project that doesn't resolve on disk (e.g. a fixture
// projectId with no matching repo) just yields an empty roster — the graph still
// renders from agentEvents alone (see model.ts buildGraph, which unions roster ids
// with anyone seen in the trace).
import fs from "fs";
import path from "path";
import { discoverProjects, type Project } from "@/lib/server/discovery";
import type { RosterAgent } from "@/components/graph/model";

// Fixture projectIds are basenames (e.g. "console"); real discovery ids are
// absolute repo paths. Match either so the route works for both fixture and live.
export function resolveProject(projectId: string): Project | undefined {
  const projects = discoverProjects();
  return projects.find((p) => p.id === projectId || path.basename(p.id) === projectId);
}

// Minimal top-level YAML frontmatter reader — only need scalar `key: value` lines
// (name, model); multi-line block scalars (`description: >`) are safely ignored
// since their continuation lines are indented and never match the key pattern.
function parseFrontmatter(src: string): Record<string, string> {
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const out: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") break;
    const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function rosterFromProject(project: Project): RosterAgent[] {
  const dir = path.join(project.path, ".claude", "agents");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const agents: RosterAgent[] = [];
  for (const f of files) {
    try {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      const fm = parseFrontmatter(src);
      const id = fm.name || f.replace(/\.md$/, "");
      const model = fm.model || undefined;
      // Niche = model tier (opus/sonnet/haiku) — the one deterministic grouping
      // signal every agent definition already carries in its frontmatter.
      agents.push({ id, niche: model ?? "agent", label: id, model });
    } catch {
      // unreadable file — skip, best-effort roster
    }
  }
  return agents.sort((a, b) => a.id.localeCompare(b.id));
}
