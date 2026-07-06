// console/components/ChimeToggle.tsx
// Visible mute toggle for the desk chime (§5) — the only UI for a preference that's
// otherwise silent by design. Amber when audible (interactive/interface voice),
// dim when muted; state comes from useChimeMuted (lib/chime.ts), persisted in
// localStorage by the parent.
"use client";

import { unlockChimeAudio } from "@/lib/chime";

export function ChimeToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  // Unmuting is the click that satisfies the browser's autoplay-gesture policy —
  // create/resume the shared AudioContext HERE, synchronously inside the click, so
  // the first real chime (which fires later, asynchronously, off an SSE event) can
  // actually play instead of silently sitting suspended.
  const handleClick = () => {
    if (muted) unlockChimeAudio();
    onToggle();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
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
