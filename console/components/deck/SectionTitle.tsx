// console/components/deck/SectionTitle.tsx — tiny shared section label, deck-wide.
"use client";

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono" style={{ margin: "0 0 8px", fontSize: 11, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
      {children}
    </div>
  );
}
