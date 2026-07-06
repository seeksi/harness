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

// Discovery ids are opaque basename-hash slugs (never a filesystem path — see
// discovery.ts's slugFor), so a current route/run projectId round-trips through
// the [projectId] segment unchanged. But pre-migration persisted runs and some
// fixtures stamped `projectId` with the repo's bare folder name instead (a
// "legacy basename") — resolve EITHER shape against the live discovery registry
// so /graph/<slug> and /graph/<legacy-basename> both land on the same project. A
// projectId matching neither simply won't resolve (e.g. a fixture-only id with no
// backing repo), which is fine — the caller treats that as "no roster" and falls
// back to agentEvents alone.
export function resolveProject(projectId: string): Project | undefined {
  const projects = discoverProjects();
  return projects.find((p) => p.id === projectId) ?? projects.find((p) => p.name === projectId);
}

/** Every id shape a run might legitimately carry for this discovered project: its
 * canonical slug and its bare folder name (legacy basename). Computed server-side
 * so client code (GraphView) never has to re-derive a basename from a path. */
export function projectAliases(project: Project): string[] {
  return [project.id, project.name];
}

/** Pure fold for the graph index (app/graph/page.tsx): merges run-observed
 * projectIds into their discovered project (basename-or-slug, same rule as
 * resolveProject) so a fixture/persisted run stamped with a legacy basename lands
 * on the SAME entry as the discovered project's slug id — never a duplicate row —
 * then adds any remaining discovered project with no observed runs yet. Returns a
 * canonical-id -> display-name map, insertion order not significant (caller sorts).
 */
export function foldProjectIndex(
  runs: Array<{ projectId: string; projectName: string }>,
  discovered: Project[]
): Map<string, string> {
  const byId = new Map(discovered.map((p) => [p.id, p]));
  const byName = new Map(discovered.map((p) => [p.name, p]));
  const out = new Map<string, string>();
  for (const r of runs) {
    const resolved = byId.get(r.projectId) ?? byName.get(r.projectId);
    const id = resolved?.id ?? r.projectId;
    const name = resolved?.name ?? r.projectName;
    if (!out.has(id)) out.set(id, name);
  }
  for (const p of discovered) {
    if (!out.has(p.id)) out.set(p.id, p.name);
  }
  return out;
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
