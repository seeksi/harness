// console/components/graph/Inspector.tsx — node click -> agent state/trace snippet.
"use client";

import type { AgentActivitySummary, GraphNode } from "./model";

const ACTIVITY_LABEL: Record<GraphNode["activity"], { label: string; color: string }> = {
  active: { label: "ACTIVE", color: "var(--amber)" },
  recent: { label: "RECENT", color: "var(--amber-rest)" },
  idle: { label: "IDLE", color: "var(--text-faint)" },
};

export function Inspector({
  node,
  activity,
  feedStale,
  onClose,
}: {
  node: GraphNode | null;
  activity: AgentActivitySummary | undefined;
  feedStale: boolean;
  onClose: () => void;
}) {
  if (!node) {
    return (
      <div style={{ padding: 12, borderRadius: "var(--radius)", background: "var(--surface-1)", border: "1px dashed var(--border)", color: "var(--text-faint)", fontSize: 12 }}>
        Click a node to inspect agent state + recent trace.
      </div>
    );
  }

  const a = ACTIVITY_LABEL[node.activity];

  return (
    <div role="region" aria-label={`inspector: ${node.label}`} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: "var(--radius)", background: "var(--surface-1)", border: "1px solid var(--border-bright)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
        <div className="display" style={{ fontSize: 16, color: "var(--text)", wordBreak: "break-word" }}>{node.label}</div>
        <button type="button" onClick={onClose} aria-label="close inspector" style={{ background: "none", border: "none", color: "var(--text-faint)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>×</button>
      </div>
      <div className="mono" style={{ fontSize: 10, color: a.color, letterSpacing: "0.08em" }}>{a.label}</div>
      <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>niche · {node.niche}</div>

      {node.kind === "group" ? (
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {node.memberCount} idle agent{node.memberCount === 1 ? "" : "s"} collapsed here:
          <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
            {node.members?.map((m) => (
              <li key={m} className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>{m}</li>
            ))}
          </ul>
        </div>
      ) : activity ? (
        <>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{activity.eventCount} event{activity.eventCount === 1 ? "" : "s"} observed</div>
          <div className="mono" style={{ fontSize: 10, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>trace snippet{feedStale ? " · stale" : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 160, overflowY: "auto" }}>
            {activity.recentTicks.map((t, i) => (
              <div key={`${t.ts}-${i}`} className="mono feed-line" style={{ fontSize: 10, color: "var(--text-dim)" }}>
                <span style={{ color: "var(--amber-rest)" }}>{t.tool}</span> {t.sig}
              </div>
            ))}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-faint)" }}>No trace observed yet for this agent — from the discovered roster only.</div>
      )}
    </div>
  );
}
