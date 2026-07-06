// console/app/deck/page.tsx — Observability deck (deep-linkable, ?run= filter), RSC.
// SSR folds the deterministic fixture into a mid-run FleetState (same ground truth as
// the fleet home) so `curl /deck` sees real forensics rows; the client shell then
// opens the SSE stream for the live view. Reads the filesystem for project discovery
// and the raw .claude/traces session list — both best-effort (never block the page).
export const dynamic = "force-dynamic";

import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import { discoverProjects } from "@/lib/server/discovery";
import { DeckExplorer } from "@/components/deck/DeckExplorer";
import { listSessions } from "./lib/traceFile";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const runRaw = sp.run;
  const runFilter = typeof runRaw === "string" && runRaw.length > 0 ? runRaw : undefined;

  const envelopes = fixtureEnvelopes();
  const initial = foldFleet(envelopes, initialFleetState);

  let projects: Array<{ id: string; name: string }> = [];
  try {
    projects = discoverProjects().map((p) => ({ id: p.id, name: p.name }));
  } catch {
    projects = []; // discovery is best-effort; the deck still renders
  }

  let sessions: string[] = [];
  try {
    sessions = listSessions(process.env.HARNESS_REPO ?? process.cwd());
  } catch {
    sessions = []; // no traces dir yet is not an error
  }

  return <DeckExplorer initial={initial} envelopes={envelopes} projects={projects} sessions={sessions} initialRunFilter={runFilter} />;
}
