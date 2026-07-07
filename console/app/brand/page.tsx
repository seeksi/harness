// console/app/brand/page.tsx — /brand: the name decision, kept as a design artifact.
// GANTRY was operator-picked 2026-07-06 from three proposals (§3); the winning card
// renders full-strength, the runners-up stay dimmed for the record. Static server
// component, no data dependencies.
import Link from "next/link";

interface NameProposal {
  name: string;
  rationale: string;
  chosen?: boolean;
}

const PROPOSALS: NameProposal[] = [
  {
    name: "GANTRY",
    rationale: "An industrial structure built to carry and steer heavy work across lanes — the mission-control energy in one word.",
    chosen: true,
  },
  {
    name: "PHOSPHOR",
    rationale: "Names the console's own visual identity — amber phosphor is the interface voice everywhere else on screen.",
  },
  {
    name: "RUNBOARD",
    rationale: "Says exactly what it is — the board every run lives on — plain enough to need zero explanation to the operator.",
  },
];

export default function Page() {
  return (
    <main className="console-shell">
      <header className="topbar">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <Link href="/" className="mono" style={{ fontSize: 11, color: "var(--text-faint)", textDecoration: "none" }}>
            ← fleet
          </Link>
          <span className="display" style={{ fontSize: 24, fontWeight: 700, color: "var(--amber)", letterSpacing: "0.04em" }}>
            Name proposals
          </span>
        </div>
        <span className="mono" style={{ fontSize: 11, color: "var(--text-faint)" }}>
          GANTRY chosen 2026-07-06 — page kept as a design artifact
        </span>
      </header>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginTop: 8 }}>
        {PROPOSALS.map((p) => (
          <section
            key={p.name}
            aria-label={`name proposal: ${p.name}${p.chosen ? " (chosen)" : ""}`}
            style={{
              padding: 24,
              borderRadius: "var(--radius)",
              background: "var(--surface-1)",
              border: p.chosen ? "1px solid var(--amber)" : "1px solid var(--amber-line)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              opacity: p.chosen ? 1 : 0.55,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <div
                className="display"
                style={{
                  fontSize: "clamp(28px, 6vw, 40px)",
                  fontWeight: 700,
                  color: p.chosen ? "var(--amber)" : "var(--text-dim)",
                  letterSpacing: "0.03em",
                  lineHeight: 1.1,
                  wordBreak: "break-word",
                }}
              >
                {p.name}
              </div>
              {p.chosen && (
                <span className="mono" style={{ fontSize: 11, color: "var(--amber)" }}>
                  ✓ chosen
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>{p.rationale}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
