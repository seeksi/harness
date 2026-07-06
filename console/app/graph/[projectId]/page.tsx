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
import { resolveProject, rosterFromProject } from "../roster";
import type { RosterAgent } from "@/components/graph/model";

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const initial = foldFleet(fixtureEnvelopes(), initialFleetState);

  let projectName = projectId;
  // The route param is the discovery id (an opaque slug — see discovery.ts's
  // slugFor), which is also what a live run's own projectId gets stamped with
  // (app/api/runs/route.ts passes `project.id`). They coincide for real discovered
  // projects; canonicalProjectId + GraphView's basename fallback remain only for a
  // fixture-only projectId or any pre-migration value that doesn't resolve here.
  let canonicalProjectId: string | undefined;
  let rosterAgents: RosterAgent[] = [];
  try {
    const project = resolveProject(projectId);
    if (project) {
      projectName = project.name;
      canonicalProjectId = project.id;
      rosterAgents = rosterFromProject(project);
    }
  } catch {
    rosterAgents = []; // discovery/roster read is best-effort — graph still renders
  }

  return (
    <GraphView
      initial={initial}
      projectId={projectId}
      canonicalProjectId={canonicalProjectId}
      projectName={projectName}
      rosterAgents={rosterAgents}
    />
  );
}
