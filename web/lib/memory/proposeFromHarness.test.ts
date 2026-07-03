// web/lib/memory/proposeFromHarness.test.ts
// Contract tests for the HARNESS-side write path (Workstream B builds the module in
// parallel — see the interface contract). Gated on the module existing so the suite
// stays green before B merges and ACTIVATES automatically after. The memory-os CLI is
// mocked with a fixture cli.py (fake checkout) — no live memory-os needed.
//
// Contract under test:
//   scanSecretsLocal(text): string[]                      // audit.py SECRET pattern set
//   proposeFromHarness(slug, type, record) ⇒
//     secret hit                      ⇒ { status: 'rejected' } (CLI never invoked)
//     decision/constraint approved    ⇒ { status: 'provisional' } (pending file, NOT committed knowledge)
//     task/entity approved            ⇒ { status: 'committed' }
//     memory-os unreachable/timeout   ⇒ { status: 'queued' } (local retry queue) — NEVER throws
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const MODULE_PATH = path.resolve(__dirname, "proposeFromHarness.ts");
const modulePresent = fs.existsSync(MODULE_PATH);

async function loadModule(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./proposeFromHarness");
}

/**
 * Fake memory-os checkout whose cli.py answers `propose` with the REAL cmd_propose
 * output shape (verdict approved) and drops a canary per invocation, so "no spawn on
 * secret reject" is assertable without knowing how B shells out.
 */
function fakeMemoryOs(): { dir: string; canary: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-memos-propose-"));
  const engine = path.join(dir, "memory_layer", "engine");
  fs.mkdirSync(engine, { recursive: true });
  const canary = path.join(dir, "invoked.canary");
  fs.writeFileSync(
    path.join(engine, "cli.py"),
    `import json, sys
open(${JSON.stringify(canary)}, "a").write(" ".join(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if "propose" in args:
    print(json.dumps({"task_result": "proposal approved", "audit_status": "approved",
                      "verdict": "approved", "risk_level": "low",
                      "autonomy_class": "audit_required", "reasons": ["clean"],
                      "memory_updates_saved": ["rec_fake01"], "superseded": None,
                      "update_id": "upd_fake01"}))
else:
    print(json.dumps({"task_result": "index synced from JSON", "counts": {}}))
`
  );
  return { dir, canary };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe.skipIf(!modulePresent)("scanSecretsLocal — audit.py SECRET pattern parity", () => {
  it("catches every pattern class the memory-os audit hard-blocks", async () => {
    const mod = await loadModule({});
    const hot: string[] = [
      "-----BEGIN PRIVATE KEY-----\nMIIB...",
      "-----BEGIN RSA PRIVATE KEY-----",
      "token sk-CONFTESTfake0123456789abcdefXYZ in text",
      "gh token ghp_ABCDEFGHIJKLMNOPQRST1234 leaked",
      "aws AKIAIOSFODNN7EXAMPLE key",
      "slack xoxb-1234567890-abcdefghij token",
      "password: hunter2hunter2",
      "api_key = supersecretvalue",
    ];
    for (const text of hot) {
      expect(mod.scanSecretsLocal(text), text).not.toEqual([]);
    }
  });

  it("returns [] for clean text (no false block on ordinary build notes)", async () => {
    const mod = await loadModule({});
    expect(mod.scanSecretsLocal("chose vitest over jest; gate B passed on lane-3")).toEqual([]);
    expect(mod.scanSecretsLocal("")).toEqual([]);
  });
});

describe.skipIf(!modulePresent)("proposeFromHarness — status semantics", () => {
  it("REJECTS a secret-shaped record locally and never invokes the CLI", async () => {
    const fake = fakeMemoryOs();
    const mod = await loadModule({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "5000" });
    const res = await mod.proposeFromHarness("slug-x", "decision", {
      topic: "leak-test",
      decision: "the key is -----BEGIN PRIVATE KEY----- oops",
      impact: "low",
      confidence: "low",
    });
    expect(res.status).toBe("rejected");
    expect(fs.existsSync(fake.canary)).toBe(false); // secret never left the process
  });

  it("an approved decision ⇒ 'provisional' (pending, NOT committed knowledge)", async () => {
    const fake = fakeMemoryOs();
    const mod = await loadModule({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "5000" });
    const res = await mod.proposeFromHarness("slug-x", "decision", {
      topic: "routing",
      decision: "route lane builds to sonnet by default",
      impact: "low",
      confidence: "medium",
    });
    expect(res.status).toBe("provisional");
  });

  it("an approved constraint ⇒ 'provisional' too (both high-impact types gate on the operator)", async () => {
    const fake = fakeMemoryOs();
    const mod = await loadModule({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "5000" });
    const res = await mod.proposeFromHarness("slug-x", "constraint", {
      constraint: "never add --mcp-config to the build-agent launcher",
      type: "security",
    });
    expect(res.status).toBe("provisional");
  });

  it("an approved task ⇒ 'committed'; an approved entity ⇒ 'committed'", async () => {
    const fake = fakeMemoryOs();
    const mod = await loadModule({ ENABLE_MEMORY_OS: "1", MEMORY_OS_DIR: fake.dir, MEMORY_OS_TIMEOUT_MS: "5000" });
    const task = await mod.proposeFromHarness("slug-x", "task", { summary: "wire gate C", status: "open" });
    expect(task.status).toBe("committed");
    const entity = await mod.proposeFromHarness("slug-x", "entity", { name: "eval-gate", entity_type: "tool" });
    expect(entity.status).toBe("committed");
  });

  it("memory-os unreachable ⇒ 'queued' for local retry — NEVER throws (writes fail soft)", async () => {
    const mod = await loadModule({
      ENABLE_MEMORY_OS: "1",
      MEMORY_OS_DIR: "/nonexistent/conformance-void",
      MEMORY_OS_TIMEOUT_MS: "2000",
    });
    const res = await mod.proposeFromHarness("slug-x", "task", { summary: "queued probe", status: "open" });
    expect(res.status).toBe("queued");
  });
});

// Documents the gate in the run output before Workstream B merges.
describe.skipIf(modulePresent)("proposeFromHarness — awaiting Workstream B", () => {
  it("skips until web/lib/memory/proposeFromHarness.ts exists", () => {
    expect(modulePresent).toBe(false);
  });
});
