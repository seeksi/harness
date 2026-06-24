// web/app/api/agent/capabilities/route.ts
// GET /api/agent/capabilities — the agent's REAL capability surface, sourced from the
// agent-bridge constants so this is a single source of truth (not a hardcoded copy):
//   - tools: the DEFAULT_TOOLS allowlist passed to `claude --allowedTools`.
//   - bashEnabled: false — Bash is deliberately NOT in the allowlist (no git/shell).
//   - mcp: --strict-mcp-config with no --mcp-config ⇒ ZERO MCP servers loaded.
// Read-only GET (no mutation) ⇒ no CSRF; kept same-origin/simple by being a plain GET.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { DEFAULT_TOOLS } from "@/lib/daemon/agent-bridge";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    tools: DEFAULT_TOOLS,
    bashEnabled: false,
    mcp: { strict: true, servers: [] as string[] },
  });
}
