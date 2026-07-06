// console/components/ChimeToggle.tsx
// Visible mute toggle for the desk chime (§5) — the only UI for a preference that's
// otherwise silent by design. Amber when audible (interactive/interface voice),
// dim when muted; state comes from useChimeMuted (lib/chime.ts), persisted in
// localStorage by the parent.
"use client";

export function ChimeToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={!muted}
      aria-label={muted ? "unmute desk chime" : "mute desk chime"}
      title={muted ? "desk chime muted — click to unmute" : "desk chime on — click to mute"}
      className="mono"
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        fontSize: 11,
        cursor: "pointer",
        color: muted ? "var(--text-faint)" : "var(--amber)",
        background: "var(--surface-2)",
        border: `1px solid ${muted ? "var(--border-bright)" : "var(--amber-line)"}`,
      }}
    >
      {muted ? "🔇 chime" : "🔔 chime"}
    </button>
  );
}
