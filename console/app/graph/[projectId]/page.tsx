// console/app/graph/[projectId]/page.tsx — Showpiece graph route, server component.
// Same SSR-fold-fixture pattern as the fleet home (app/page.tsx): fold the
// deterministic fixture so `curl` sees real graph data, resolve the project against
// discovery (best-effort — a fixture projectId with no matching repo just yields an
// empty roster; the graph still renders off agentEvents alone).
export const dynamic = "force-dynamic"; // roster resolution hits the filesystem per request

import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import { GraphView } from "@/components/graph/GraphView";
import { resolveProject, rosterFromProject, projectAliases } from "../roster";
import type { RosterAgent } from "@/components/graph/model";

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const initial = foldFleet(fixtureEnvelopes(), initialFleetState);

  let projectName = projectId;
  // The route param may be the current discovery slug OR a legacy basename (see
  // roster.ts's resolveProject) — both resolve to the same discovered project here.
  // `aliases` is every id shape a run for this project might carry; resolved
  // server-side so GraphView never has to re-derive a basename from a path
  // client-side. A fixture-only projectId or one with no backing repo just yields
  // its own value as the sole alias — the graph still renders off agentEvents alone.
  let aliases = [projectId];
  let rosterAgents: RosterAgent[] = [];
  try {
    const project = resolveProject(projectId);
    if (project) {
      projectName = project.name;
      aliases = projectAliases(project);
      rosterAgents = rosterFromProject(project);
    }
  } catch {
    rosterAgents = []; // discovery/roster read is best-effort — graph still renders
  }

  return (
    <GraphView
      initial={initial}
      projectId={projectId}
      aliases={aliases}
      projectName={projectName}
      rosterAgents={rosterAgents}
    />
  );
}
