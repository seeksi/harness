// web/hud/TraceDrawer.tsx — Lane C.
// The trace tick feed lives in a DRAWER, never in the 3D graph (design package §C).
// Mono, tabular, newest last; bounded by the store's trace ring buffer.
"use client";

import type { RunState } from "@/lib/contract/types";
import { glassSurface } from "./glass";

export function TraceDrawer({ state, open }: { state: RunState; open: boolean }) {
  if (!open) return null;
  return (
    <aside
      aria-label="Trace drawer"
      data-testid="trace-drawer"
      style={{
        ...glassSurface(),
        position: "absolute",
        left: 16,
        right: 16,
        bottom: 16,
        maxHeight: "30vh",
        overflowY: "auto",
        padding: 12,
        borderRadius: 8,
        fontFamily: "var(--font-geist-mono, ui-monospace, monospace)",
        fontSize: 12,
        // tabular/lining so ts/tool columns align
        fontVariantNumeric: "tabular-nums lining-nums",
      }}
    >
      {state.trace.length === 0 ? (
        <p style={{ color: "var(--text-faint)", margin: 0 }}>No trace ticks yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {state.trace.map((t, i) => (
            <li
              key={i}
              data-testid="trace-row"
              style={{ display: "flex", gap: 8, padding: "1px 0", color: "var(--text)" }}
            >
              <span style={{ color: "var(--accent-vivid)", minWidth: 96 }}>{t.tool}</span>
              <span style={{ color: "var(--text-dim)" }}>{t.sig}</span>
              {t.subtaskId ? (
                <span style={{ color: "var(--text-faint)" }}> · {t.subtaskId}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
