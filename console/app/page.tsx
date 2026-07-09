// console/app/page.tsx — Fleet home (default route), server component.
// SSR folds the deterministic fixture into a mid-run FleetState so `curl` sees real
// lanes, and runs project discovery (fs) so the registry is populated server-side.
// The client shell (FleetHome) then connects the SSE stream for kinetic live updates.
export const dynamic = "force-dynamic"; // discovery hits the filesystem per request

import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import { discoverProjects } from "@/lib/server/discovery";
import { FleetHome } from "@/components/FleetHome";

export default function Page() {
  // LIVE mode seeds an empty fleet — the SSE stream is the sole source of real lanes.
  // The deterministic fixture (vector/hangar/ledger) is the DEMO fallback only, so it
  // never bleeds demo lanes (or their dead Approve buttons) into a live operator board.
  const initial =
    process.env.HARNESS_LIVE === "1" ? initialFleetState : foldFleet(fixtureEnvelopes(), initialFleetState);

  let projects: Array<{ id: string; name: string }> = [];
  try {
    projects = discoverProjects().map((p) => ({ id: p.id, name: p.name }));
  } catch {
    projects = []; // discovery is best-effort; ops board still renders
  }

  return <FleetHome initial={initial} projects={projects} />;
}
