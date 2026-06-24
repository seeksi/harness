// web/hud/TaskLoop.tsx — Lane C.
// The agent's loop, "now → planned": the current ACTIVE phase, the building/active
// subtask(s), and PLANNED (pending) subtasks — each with a model badge (haiku/
// sonnet/opus) and status. Single-slot today, but rendered generically over the list.
"use client";

import type { RunState, Subtask, SubtaskStatus } from "@/lib/contract/types";
import { glassSurface } from "./glass";

const MONO = "var(--font-mono)";

// status hue: building = cyan in-progress, blocked = red, merged/reviewed = ok, pending = faint.
function statusColor(status: SubtaskStatus): string {
  switch (status) {
    case "building":
      return "var(--status-info-text)";
    case "blocked":
      return "var(--status-crit-text)";
    case "reviewed":
    case "merged":
      return "var(--status-ok-text)";
    default:
      return "var(--text-faint)";
  }
}

function ModelBadge({ model }: { model?: Subtask["model"] }) {
  return (
    <span
      data-testid="model-badge"
      style={{
        fontSize: 10,
        letterSpacing: 0.5,
        padding: "1px 5px",
        borderRadius: 4,
        border: "1px solid var(--border)",
        color: model ? "var(--accent-vivid)" : "var(--text-faint)",
        background: "var(--surface-2)",
      }}
    >
      {model ?? "—"}
    </span>
  );
}

function SubtaskRow({ st }: { st: Subtask }) {
  return (
    <li
      data-testid={`loop-subtask-${st.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderRadius: 6,
        background: "var(--surface-1)",
        borderLeft: `3px solid ${statusColor(st.status)}`,
        marginBottom: 4,
        fontFamily: MONO,
        fontSize: 12,
        fontVariantNumeric: "tabular-nums lining-nums",
      }}
    >
      <ModelBadge model={st.model} />
      <span style={{ flex: 1, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {st.title || st.id}
      </span>
      <span style={{ color: statusColor(st.status) }}>{st.status}</span>
    </li>
  );
}

export function TaskLoop({ state, open }: { state: RunState; open: boolean }) {
  if (!open) return null;

  const activePhase = state.phases.find((p) => p.status === "active");
  // "now": anything actively in flight. "planned": still pending.
  const active = state.subtasks.filter((s) => s.status === "building");
  const planned = state.subtasks.filter((s) => s.status === "pending");

  return (
    <section
      aria-label="Task loop"
      data-testid="task-loop"
      style={{
        ...glassSurface(),
        position: "absolute",
        bottom: 16,
        right: 16,
        width: 320,
        padding: 12,
        borderRadius: 8,
        fontFamily: MONO,
      }}
    >
      <header
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}
      >
        <span style={{ fontSize: 11, letterSpacing: 1, color: "var(--text-dim)" }}>TASK LOOP</span>
        <span data-testid="active-phase" style={{ fontSize: 12, color: "var(--accent-vivid)" }}>
          {activePhase ? `▸ ${activePhase.label}` : "idle"}
        </span>
      </header>

      <div style={{ fontSize: 10, letterSpacing: 1, color: "var(--text-faint)", margin: "0 0 4px" }}>
        NOW
      </div>
      {active.length === 0 ? (
        <p data-testid="loop-now-empty" style={{ color: "var(--text-faint)", fontSize: 12, margin: "0 0 8px" }}>
          no active subtask
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0 }}>
          {active.map((s) => (
            <SubtaskRow key={s.id} st={s} />
          ))}
        </ul>
      )}

      <div style={{ fontSize: 10, letterSpacing: 1, color: "var(--text-faint)", margin: "0 0 4px" }}>
        PLANNED
      </div>
      {planned.length === 0 ? (
        <p data-testid="loop-planned-empty" style={{ color: "var(--text-faint)", fontSize: 12, margin: 0 }}>
          nothing planned
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {planned.map((s) => (
            <SubtaskRow key={s.id} st={s} />
          ))}
        </ul>
      )}
    </section>
  );
}
