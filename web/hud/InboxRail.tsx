// web/hud/InboxRail.tsx — Lane C.
// The single authoritative triage/action line (design package §attention-model).
// The active (highest-severity) item gets the boldest weight + most breathing room;
// idle items stay tight. Renders nothing when there's nothing to triage so it only
// becomes the attentional anchor when it must.
"use client";

import type { RunState } from "@/lib/contract/types";
import { deriveInbox, type InboxItem } from "./inbox";
import { glassSurface } from "./glass";
import { statusColorForSeverity } from "./severity";

export function InboxRail({
  state,
  onSelect,
}: {
  state: RunState;
  onSelect?: (item: InboxItem) => void;
}) {
  const items = deriveInbox(state);
  if (items.length === 0) return null;

  return (
    <aside
      aria-label="Inbox"
      data-testid="inbox-rail"
      style={{
        ...glassSurface(),
        position: "absolute",
        top: 16,
        right: 16,
        width: 340,
        padding: 12,
        borderRadius: 8,
        fontFamily: "var(--font-geist-sans, system-ui)",
      }}
    >
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((item, i) => {
          const active = i === 0;
          const hue = statusColorForSeverity(item.severity);
          return (
            <li key={item.id} data-testid={`inbox-${item.id}`} style={{ marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => onSelect?.(item)}
                data-active={active}
                style={{
                  width: "100%",
                  textAlign: "left",
                  cursor: "pointer",
                  borderRadius: 6,
                  // left accent bar = the severity hue; full ring when active.
                  border: `1px solid ${active ? hue : "var(--border)"}`,
                  borderLeft: `3px solid ${hue}`,
                  background: active ? "var(--surface-2)" : "var(--surface-1)",
                  color: "var(--text)",
                  // 28px idle floor → ~36px active alert (extra breathing room).
                  padding: active ? "10px 12px" : "6px 12px",
                  minHeight: active ? 36 : 28,
                  fontWeight: active ? 700 : 500,
                  fontSize: 13,
                }}
              >
                {/* the single authoritative action line — exactly the four facts;
                    dense evidence (summary) lives in the detail panel on click. */}
                <span data-testid={`inbox-line-${item.id}`} style={{ display: "block" }}>
                  {item.line}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
