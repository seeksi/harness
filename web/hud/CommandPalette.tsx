// web/hud/CommandPalette.tsx — Lane C.
// Keyboard-first ⌘K / Ctrl+K command palette. The matching/ordering and chord
// detection are pure (commands.ts); this component owns the overlay, focus, and
// keyboard. Esc closes; Enter runs the top match.
"use client";

import { useEffect, useRef, useState } from "react";
import { filterCommands, isPaletteChord, type Command } from "./commands";
import { glassSurface } from "./glass";

export function CommandPalette({ commands }: { commands: Command[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteChord(e)) {
        e.preventDefault();
        setOpen((o) => !o);
        setQuery(""); // event handler, not effect body — safe
      } else if (e.key === "Escape") {
        setOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the input when the palette opens (no state writes — effect-safe).
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;
  const results = filterCommands(commands, query);

  const runCommand = (c: Command) => {
    c.run();
    setOpen(false);
    setQuery("");
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <div
      role="dialog"
      aria-label="Command palette"
      data-testid="command-palette"
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "start center",
        paddingTop: "12vh",
        background: "hsla(222, 11%, 4%, 0.5)",
        zIndex: 50,
      }}
      onClick={close}
    >
      <div
        style={{ ...glassSurface(), width: 520, borderRadius: 10, padding: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…"
          aria-label="Command query"
          data-testid="command-input"
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) runCommand(results[0]);
          }}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 12px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "inherit",
            fontSize: 14,
          }}
        />
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid={`command-${c.id}`}
                onClick={() => runCommand(c)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  borderRadius: 6,
                }}
              >
                {c.label}
                {c.hint && <span style={{ opacity: 0.6 }}> — {c.hint}</span>}
              </button>
            </li>
          ))}
          {results.length === 0 && (
            <li style={{ opacity: 0.6, padding: "8px 12px" }}>No commands</li>
          )}
        </ul>
      </div>
    </div>
  );
}
