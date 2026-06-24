// web/app/api/agent/capabilities/capabilities.test.ts
// GET returns the agent's real capability surface, sourced from agent-bridge constants.

import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { DEFAULT_TOOLS } from "@/lib/daemon/agent-bridge";

describe("GET /api/agent/capabilities", () => {
  it("returns the DEFAULT_TOOLS allowlist, bashEnabled:false, strict zero-server MCP", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Single source of truth — mirrors the bridge constant, not a hardcoded copy.
    expect(body.tools).toEqual(DEFAULT_TOOLS);
    expect(body.bashEnabled).toBe(false);
    expect(body.mcp).toEqual({ strict: true, servers: [] });
  });
});
