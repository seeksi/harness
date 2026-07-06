// console/app/brand/page.tsx — /brand: three product-name proposals (§3), each set
// as an Oxanium wordmark on the CRT tokens, with a one-line rationale. Pure display
// — the operator picks later; this build does NOT rename anything ("Umbrella"/
// "HARNESS" stay wherever they already appear). Static server component, no data
// dependencies.
import Link from "next/link";

interface NameProposal {
  name: string;
  rationale: string;
}

const PROPOSALS: NameProposal[] = [
  {
    name: "PHOSPHOR",
    rationale: "Names the console's own visual identity — amber phosphor is the interface voice everywhere else on screen.",
  },
  {
    name: "GANTRY",
    rationale: "An industrial structure built to carry and steer heavy work across lanes — the mission-control energy in one word.",
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
          operator picks later — nothing renamed by this page
        </span>
      </header>

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginTop: 8 }}>
        {PROPOSALS.map((p) => (
          <section
            key={p.name}
            aria-label={`name proposal: ${p.name}`}
            style={{
              padding: 24,
              borderRadius: "var(--radius)",
              background: "var(--surface-1)",
              border: "1px solid var(--amber-line)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div
              className="display"
              style={{
                fontSize: "clamp(28px, 6vw, 40px)",
                fontWeight: 700,
                color: "var(--amber)",
                letterSpacing: "0.03em",
                lineHeight: 1.1,
                wordBreak: "break-word",
              }}
            >
              {p.name}
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-dim)", lineHeight: 1.5 }}>{p.rationale}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
