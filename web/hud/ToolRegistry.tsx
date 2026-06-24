// web/hud/ToolRegistry.tsx — Lane C.
// The agent's REAL capability surface as a HUD glass panel: the tool allowlist
// (GET /api/agent/capabilities), Bash shown explicitly DENIED so the operator sees
// what is NOT permitted, and the strict zero-server MCP state as a locked/clean row.
// Read-only display; client component because it fetches on mount.
"use client";

import { useEffect, useState } from "react";
import { glassSurface } from "./glass";

interface Capabilities {
  tools: string[];
  bashEnabled: boolean;
  mcp: { strict: boolean; servers: string[] };
}

// Tools the operator should SEE the disposition of even when not in the allowlist.
// Bash is the load-bearing one: rendering it DENIED is the whole point of the panel.
const ALWAYS_SHOWN_DENIED = ["Bash"] as const;

const MONO = "var(--font-mono)";

function ToolRow({ name, allowed }: { name: string; allowed: boolean }) {
  const hue = allowed ? "var(--status-ok-text)" : "var(--status-crit-text)";
  const fill = allowed ? "var(--status-ok-fill)" : "var(--status-crit-fill)";
  return (
    <li
      data-testid={`tool-${name}`}
      data-allowed={allowed}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "4px 8px",
        borderRadius: 6,
        background: "var(--surface-1)",
        borderLeft: `3px solid ${fill}`,
        marginBottom: 4,
        fontFamily: MONO,
        fontSize: 12,
        fontVariantNumeric: "tabular-nums lining-nums",
        // denied rows read muted; allowed rows read at full text weight.
        color: allowed ? "var(--text)" : "var(--text-dim)",
      }}
    >
      <span>{name}</span>
      <span style={{ color: hue, fontWeight: 600 }}>{allowed ? "[ALLOWED]" : "[OFF]"}</span>
    </li>
  );
}

export function ToolRegistry({ open }: { open: boolean }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError(null);
    fetch("/api/agent/capabilities")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: Capabilities) => {
        if (alive) setCaps(data);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "fetch failed");
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const mcpServers = caps?.mcp.servers.length ?? 0;

  return (
    <section
      aria-label="Tool registry"
      data-testid="tool-registry"
      style={{
        ...glassSurface(),
        position: "absolute",
        top: 16,
        left: 16,
        width: 300,
        padding: 12,
        borderRadius: 8,
        fontFamily: MONO,
      }}
    >
      <header
        style={{ fontSize: 11, letterSpacing: 1, color: "var(--text-dim)", marginBottom: 8 }}
      >
        TOOL REGISTRY
      </header>

      {error ? (
        <p data-testid="tool-registry-error" style={{ color: "var(--status-crit-text)", fontSize: 12, margin: 0 }}>
          capabilities unavailable — {error}
        </p>
      ) : !caps ? (
        <p data-testid="tool-registry-loading" style={{ color: "var(--text-faint)", fontSize: 12, margin: 0 }}>
          loading capabilities…
        </p>
      ) : (
        <>
          {/* ponytail: read-only display. Each row is a self-contained ToolRow, so per-tool
              toggles/approvals slot in by adding a control to ToolRow + a mutate POST.
              add when the agent gains a runtime allowlist-edit endpoint. */}
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {caps.tools.map((t) => (
              <ToolRow key={t} name={t} allowed />
            ))}
            {ALWAYS_SHOWN_DENIED.filter((d) => !caps.tools.includes(d)).map((d) => (
              <ToolRow key={d} name={d} allowed={d === "Bash" ? caps.bashEnabled : false} />
            ))}
          </ul>

          <div
            data-testid="mcp-status"
            style={{
              marginTop: 8,
              padding: "6px 8px",
              borderRadius: 6,
              background: "var(--surface-1)",
              borderLeft: `3px solid var(--status-ok-fill)`,
              fontSize: 12,
              color: "var(--text-dim)",
            }}
          >
            <span style={{ color: "var(--status-ok-text)", fontWeight: 600 }}>MCP: </span>
            {caps.mcp.strict ? "strict" : "open"} — {mcpServers} servers
            {mcpServers === 0 ? " (isolated)" : ""}
          </div>
        </>
      )}
    </section>
  );
}
