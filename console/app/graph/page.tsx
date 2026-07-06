// console/app/graph/page.tsx — graph index: links into /graph/<projectId> for every
// project the fixture/store currently knows about, plus the discovered registry.
// Not a named acceptance target (the route-level page is), but a one-hop nicety so
// the showpiece is reachable without knowing a projectId in advance.
export const dynamic = "force-dynamic";

import Link from "next/link";
import { foldFleet } from "@/lib/contract/events";
import { fixtureEnvelopes } from "@/lib/contract/fixture";
import { initialFleetState } from "@/lib/contract/types";
import { discoverProjects } from "@/lib/server/discovery";

export default function Page() {
  const state = foldFleet(fixtureEnvelopes(), initialFleetState);
  const fromRuns = new Map(Object.values(state.runs).map((r) => [r.projectId, r.projectName]));

  // Discovery ids are opaque basename-hash slugs (never a path — see discovery.ts's
  // slugFor), so they pass through this single dynamic route segment unchanged;
  // no basename-of-a-path extraction is needed to build the link below.
  let discovered: Array<{ id: string; name: string }> = [];
  try {
    discovered = discoverProjects().map((p) => ({ id: p.id, name: p.name }));
  } catch {
    discovered = [];
  }
  for (const p of discovered) {
    if (!fromRuns.has(p.id)) fromRuns.set(p.id, p.name);
  }

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
