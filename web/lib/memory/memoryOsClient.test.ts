// web/lib/memory/memoryOsClient.test.ts
// Contract tests for the memory-os read client (Workstream B builds the module in
// parallel — see the interface contract). Gated on the module existing so the suite
// stays green before B merges and ACTIVATES automatically after. The CLI shell-out is
// mocked with a FAKE memory-os checkout (a fixture cli.py) — no live memory-os needed.
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const CLIENT_PATH = path.resolve(__dirname, "memoryOsClient.ts");
const clientPresent = fs.existsSync(CLIENT_PATH);

/** Env-stub + fresh import so module-load-time env reads are honored either way. */
async function loadClient(env: Record<string, string | undefined>) {
  vi.resetModules();
  // vi.stubEnv(name, undefined) REMOVES the var (vitest ≥1), so "unset" is testable.
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./memoryOsClient");
}

/**
 * Build a throwaway fake memory-os checkout whose cli.py mocks the real CLI:
 *  - "ok": answers `index sync` / `search` / `packet` with well-formed JSON, and drops
 *    a canary file per invocation so "no spawn" is assertable implementation-agnostically
 *  - "hang": sleeps far past any test timeout (exercises MEMORY_OS_TIMEOUT_MS)
 */
function fakeMemoryOs(behavior: "ok" | "hang"): { dir: string; canary: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-memos-"));
  const engine = path.join(dir, "memory_layer", "engine");
  fs.mkdirSync(engine, { recursive: true });
  const canary = path.join(dir, "invoked.canary");
  const body =
    behavior === "hang"
      ? "import time\ntime.sleep(60)\n"
      : `import json, sys
open(${JSON.stringify(canary)}, "a").write(" ".join(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if "search" in args:
    print(json.dumps({"query": "q", "count": 1, "results": [
        {"kind": "decision", "id": "dec_fake01", "score": 1.0, "freshness": "fresh", "label": "fake"}]}))
elif "packet" in args:
    print(json.dumps({"packet_id": "pkt_fake01", "project": "x", "sections": []}))
else:
    print(json.dumps({"task_result": "index synced from JSON", "counts": {}}))
`;
  fs.writeFileSync(path.join(engine, "cli.py"), body);
  return { dir, canary };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.skipIf(!clientPresent)("memoryOsClient — interface contract", () => {
  it("isMemoryOsEnabled() is false unless ENABLE_MEMORY_OS === '1' (default off)", async () => {
    const off = await loadClient({ ENABLE_MEMORY_OS: undefined });
    expect(off.isMemoryOsEnabled()).toBe(false);
    const on = await loadClient({ ENABLE_MEMORY_OS: "1" });
    expect(on.isMemoryOsEnabled()).toBe(true);
    const zero = await loadClient({ ENABLE_MEMORY_OS: "0" });
    expect(zero.isMemoryOsEnabled()).toBe(false);
  });

  it("disabled ⇒ memSearch/memPacket return null WITHOUT spawning the CLI", async () => {
    const fake = fakeMemoryOs("ok");
    const mod = await loadClient({ ENABLE_MEMORY_OS: undefined, MEMORY_OS_DIR: fake.dir });
    expect(await mod.memSearch("slug-x", "query")).toBeNull();
    expect(await mod.memPacket("slug-x", "task", "objective")).toBeNull();
    // The canary file is written by ANY cli.py invocation — absent means no spawn.
    expect(fs.existsSync(fake.canary)).toBe(false);
  });

  it("enabled + working CLI ⇒ memSearch resolves an array (fail-open contract shape)", async () => {
    const fake = fakeMemoryOs("ok");
    const mod = await loadClient({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "5000" });
    const res = await mod.memSearch("slug-x", "query");
    expect(Array.isArray(res)).toBe(true);
    expect((res as unknown[]).length).toBeGreaterThan(0);
  });

  it("enabled + working CLI ⇒ memPacket resolves a non-null packet", async () => {
    const fake = fakeMemoryOs("ok");
    const mod = await loadClient({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "5000" });
    expect(await mod.memPacket("slug-x", "task", "objective")).not.toBeNull();
  });

  it("a hanging CLI is cut off by MEMORY_OS_TIMEOUT_MS ⇒ null (never blocks a gate)", async () => {
    const fake = fakeMemoryOs("hang");
    const mod = await loadClient({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "300" });
    expect(await mod.memSearch("slug-x", "query")).toBeNull();
  }, 15_000);

  it("a nonexistent MEMORY_OS_DIR ⇒ null, never throws (reads fail open)", async () => {
    const mod = await loadClient({
      ENABLE_MEMORY_OS: "1",
      MEMORY_OS_DIR: "/nonexistent/conformance-void",
      MEMORY_OS_TIMEOUT_MS: "2000",
    });
    await expect(mod.memSearch("slug-x", "query")).resolves.toBeNull();
    await expect(mod.memPacket("slug-x", "task", "objective")).resolves.toBeNull();
  });
});

// Keeps the file non-empty for vitest before Workstream B merges (a suite with only
// skipped describes is fine, but this documents WHY it is skipped in the run output).
describe.skipIf(clientPresent)("memoryOsClient — awaiting Workstream B", () => {
  it("skips until web/lib/memory/memoryOsClient.ts exists", () => {
    expect(clientPresent).toBe(false);
  });
});
