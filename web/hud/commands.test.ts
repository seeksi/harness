// web/hud/commands.test.ts
import { describe, it, expect } from "vitest";
import { filterCommands, isPaletteChord, type Command } from "./commands";

const cmds: Command[] = [
  { id: "start", label: "Start run", run: () => {} },
  { id: "trace", label: "Toggle trace drawer", hint: "logs", run: () => {} },
  { id: "approve", label: "Approve promote", run: () => {} },
];

describe("commands", () => {
  it("returns all on empty query", () => {
    expect(filterCommands(cmds, "  ")).toHaveLength(3);
  });

  it("matches label and hint case-insensitively", () => {
    expect(filterCommands(cmds, "RUN").map((c) => c.id)).toEqual(["start"]);
    expect(filterCommands(cmds, "logs").map((c) => c.id)).toEqual(["trace"]);
  });

  it("detects the ⌘K / Ctrl+K chord", () => {
    expect(isPaletteChord({ key: "k", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPaletteChord({ key: "K", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPaletteChord({ key: "j", metaKey: true, ctrlKey: false })).toBe(false);
    expect(isPaletteChord({ key: "k", metaKey: false, ctrlKey: false })).toBe(false);
  });
});
