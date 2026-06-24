// web/hud/commands.ts
// ⌘K command registry + filtering (pure). The palette component owns the keyboard
// and overlay; matching/ordering lives here so it is unit-tested.

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Case-insensitive subsequence-free substring match on label/hint, preserving order. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (c) => c.label.toLowerCase().includes(q) || (c.hint?.toLowerCase().includes(q) ?? false)
  );
}

/** True when a keyboard event is the ⌘K / Ctrl+K palette toggle. */
export function isPaletteChord(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}
