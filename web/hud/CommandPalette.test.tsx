// web/hud/CommandPalette.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette", () => {
  it("opens on Ctrl+K, runs a command on click, and closes", () => {
    const run = vi.fn();
    render(<CommandPalette commands={[{ id: "trace", label: "Toggle trace", run }]} />);
    expect(screen.queryByTestId("command-palette")).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("command-trace"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });

  it("Escape closes the palette", () => {
    render(<CommandPalette commands={[]} />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("command-palette")).toBeNull();
  });
});
