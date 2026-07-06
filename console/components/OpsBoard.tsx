// console/components/OpsBoard.tsx
// The idle state — NEVER 'empty'. When no runs are active the ops board stays live:
// the discovered fleet, a standing status line, and the launch call-to-action. (§5:
// "no runs yet — ops board still live".)
"use client";

export function OpsBoard({ projectCount, onLaunch }: { projectCount: number; onLaunch: () => void }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        alignItems: "flex-start",
        padding: 24,
        borderRadius: "var(--radius)",
        background: "var(--surface-1)",
        border: "1px dashed var(--border-bright)",
      }}
    >
      <div className="mono breathe" style={{ fontSize: 11, color: "var(--live)", letterSpacing: "0.1em" }}>
        ● OPS BOARD LIVE
      </div>
      <div className="display" style={{ fontSize: 20, color: "var(--text)" }}>No runs in flight</div>
      <div style={{ fontSize: 13, color: "var(--text-dim)", maxWidth: 440 }}>
        {projectCount} project{projectCount === 1 ? "" : "s"} discovered and standing by. Launch a run to fill the
        lanes, or press <kbd style={{ color: "var(--amber)" }}>⌘K</kbd> for the command palette.
      </div>
      <button
        type="button"
        onClick={onLaunch}
        style={{
          marginTop: 6,
          padding: "8px 16px",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          color: "var(--bg)",
          background: "var(--amber)",
          border: "1px solid var(--amber)",
        }}
      >
        Launch a run
      </button>
    </div>
  );
}
