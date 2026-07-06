// console/components/CommandPalette.tsx
// ⌘K command palette — jump / approve / abort. Mid-run everything is fast here
// (§5). "Jump to <run>" entries call `onSelect`, which the parent wires to
// router.push(runRoute(runId)) — a real navigation to /run/[id], not local
// state. Approve/abort stay wired to store actions, unchanged. Abort requires a
// typed confirmation (destructive).
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunState, GateId } from "@/lib/contract/types";
import { raisedGates } from "@/lib/contract/selectors";
import { deckRunRoute } from "@/lib/routes";
import { sanitizeProjectId } from "@/lib/format";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void;
}

interface Props {
  open: boolean;
  runs: RunState[];
  onClose: () => void;
  onSelect: (runId: string) => void;
  onApprove: (runId: string, gate: GateId) => void;
  onAbort: (runId: string) => void;
  onLaunch: () => void;
  onOpenDeck: (href: string) => void;
}

export function CommandPalette({ open, runs, onClose, onSelect, onApprove, onAbort, onLaunch, onOpenDeck }: Props) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [{ id: "launch", label: "Launch a run", hint: "new", run: onLaunch }];
    for (const r of runs) {
      list.push({ id: `jump:${r.runId}`, label: `Jump to ${r.projectName}`, hint: sanitizeProjectId(r.projectId), run: () => onSelect(r.runId) });
      list.push({ id: `deck:${r.runId}`, label: `Open deck for ${r.projectName}`, hint: "deck", run: () => onOpenDeck(deckRunRoute(r.runId)) });
      for (const g of raisedGates(r)) {
        list.push({ id: `approve:${r.runId}:${g.id}`, label: `Approve gate ${g.id} — ${r.projectName}`, hint: "gate", run: () => onApprove(r.runId, g.id) });
      }
      if (r.status === "running") {
        list.push({
          id: `abort:${r.runId}`,
          label: `Abort ${r.projectName}`,
          hint: "type ABORT",
          danger: true,
          run: () => {
            const c = window.prompt(`Type ABORT to abort ${r.projectName}:`);
            if (c === "ABORT") onAbort(r.runId);
          },
        });
      }
    }
    return list;
  }, [runs, onLaunch, onSelect, onApprove, onAbort, onOpenDeck]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
  }, [q, commands]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);
  useEffect(() => setIdx(0), [q]);

  if (!open) return null;

  function exec(c: Cmd | undefined) {
    if (!c) return;
    onClose();
    c.run();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, display: "grid", placeItems: "start center", paddingTop: "12vh", background: "rgba(0,0,0,0.6)", zIndex: 60 }}
    >
      <div style={{ width: "min(560px, 92%)", borderRadius: 12, overflow: "hidden", background: "var(--surface-2)", border: "1px solid var(--amber-line)" }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Command…  (jump · approve · abort · launch)"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); exec(filtered[idx]); }
            else if (e.key === "Escape") onClose();
          }}
          style={{ width: "100%", padding: 14, background: "var(--surface-1)", color: "var(--text)", border: "none", borderBottom: "1px solid var(--border)", outline: "none", fontSize: 14, fontFamily: "var(--font-mono)" }}
        />
        <ul style={{ listStyle: "none", margin: 0, padding: 6, maxHeight: 320, overflowY: "auto" }}>
          {filtered.length === 0 && <li style={{ padding: 12, color: "var(--text-faint)", fontSize: 12 }}>no matching command</li>}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseEnter={() => setIdx(i)}
                onClick={() => exec(c)}
                style={{
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "9px 10px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 13,
                  color: c.danger ? "var(--fail)" : "var(--text)",
                  background: i === idx ? "var(--surface-3)" : "transparent",
                }}
              >
                <span>{c.label}</span>
                {c.hint && <span className="mono" style={{ fontSize: 10, color: "var(--text-faint)" }}>{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
