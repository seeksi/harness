// web/hud/ToolRegistry.test.tsx
// Renders the allowlist with a mocked fetch: allowed tools show [ALLOWED], Bash shows
// [OFF] (explicitly denied), and the strict zero-server MCP row reads "(isolated)".
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ToolRegistry } from "./ToolRegistry";

const caps = {
  tools: ["Read", "Edit", "Write", "Grep", "Glob"],
  bashEnabled: false,
  mcp: { strict: true, servers: [] as string[] },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ToolRegistry", () => {
  it("renders nothing when closed and does not fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ToolRegistry open={false} />);
    expect(container.firstChild).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fetches and shows allowed tools, Bash denied, and isolated MCP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => caps })
    );
    render(<ToolRegistry open />);

    await waitFor(() => expect(screen.getByTestId("tool-Read")).toBeInTheDocument());
    expect(screen.getByTestId("tool-Read").textContent).toContain("[ALLOWED]");
    expect(screen.getByTestId("tool-Read").getAttribute("data-allowed")).toBe("true");

    // Bash is not in the allowlist but is shown explicitly DENIED.
    const bash = screen.getByTestId("tool-Bash");
    expect(bash.textContent).toContain("[OFF]");
    expect(bash.getAttribute("data-allowed")).toBe("false");

    expect(screen.getByTestId("mcp-status").textContent).toContain("strict");
    expect(screen.getByTestId("mcp-status").textContent).toContain("0 servers");
    expect(screen.getByTestId("mcp-status").textContent).toContain("(isolated)");
    vi.unstubAllGlobals();
  });

  it("shows an error state when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    render(<ToolRegistry open />);
    await waitFor(() =>
      expect(screen.getByTestId("tool-registry-error")).toBeInTheDocument()
    );
    expect(screen.getByTestId("tool-registry-error").textContent).toContain("HTTP 500");
    vi.unstubAllGlobals();
  });
});
