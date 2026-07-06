// console/app/graph/page.tsx — graph index: links into /graph/<projectId> for every
// project the fixture/store currently knows about, plus the discovered registry.
// Not a named acceptance target (the route-level page is), but a one-hop nicety so
// the showpiece is reachable without knowing a projectId in advance.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import { discoverProjects, type Project } from "@/lib/server/discovery";
import { foldProjectIndex } from "./roster";

export default function Page() {
  const state = foldFleet(fixtureEnvelopes(), initialFleetState);

  let discovered: Project[] = [];
  try {
    discovered = discoverProjects();
  } catch {
    discovered = [];
  }

  // Fold each run's projectId into its discovered project (server-side
  // basename-or-slug resolution — see roster.ts's foldProjectIndex) so a
  // fixture/persisted run stamped with a legacy basename lands on the SAME row as
  // the discovered project's slug id, instead of double-listing the same repo.
  const fromRuns = foldProjectIndex(Object.values(state.runs), discovered);

  const ids = [...fromRuns.keys()].sort();

  return (
    <main className="console-shell">
      <header className="topbar">
        <span className="display" style={{ fontSize: 24, fontWeight: 700, color: "var(--amber)", letterSpacing: "0.04em" }}>
          Workflow graphs
        </span>
      </header>
      <div className="cards">
        {ids.length === 0 && (
          <div style={{ padding: 16, borderRadius: 8, border: "1px dashed var(--border)", color: "var(--text-faint)", fontSize: 12 }}>
            No projects known yet.
          </div>
        )}
        {ids.map((id) => (
          <Link
            key={id}
            href={`/graph/${encodeURIComponent(id)}`}
            style={{ display: "block", padding: 14, borderRadius: 8, background: "var(--surface-1)", border: "1px solid var(--border)", color: "var(--text)", textDecoration: "none" }}
          >
            <div className="display" style={{ fontSize: 16 }}>{fromRuns.get(id)}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{id}</div>
          </Link>
        ))}
      </div>
    </main>
  );
}
