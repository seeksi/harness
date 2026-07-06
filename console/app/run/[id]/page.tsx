// console/app/run/[id]/page.tsx — Run focus (deep-linkable steering view), server component.
// SSR folds the same deterministic fixture as fleet home into a FleetState and hands
// the one matching run down, so a deep link / phone check-in / `curl` sees real
// phase-rail + feed content on first paint. The client shell (RunFocus) then
// connects the fleet SSE stream for kinetic live updates, same pattern as page.tsx.
export const dynamic = "force-dynamic";

import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import { RunFocus } from "@/components/run/RunFocus";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const initial = foldFleet(fixtureEnvelopes(), initialFleetState);
  return <RunFocus initial={initial} runId={id} />;
}
