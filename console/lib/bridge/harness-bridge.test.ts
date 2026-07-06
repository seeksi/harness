import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import {
  buildArgs,
  parseHarnessLine,
  spawnHarness,
  containedPlanFile,
  minimalChildEnv,
  HarnessArgError,
  HarnessTimeoutError,
  type ParsedHarnessEvent,
} from "./harness-bridge";
import { mintLane, mintPlanFile, mintSession, _resetRegistry } from "./registry";
import { resetDb, listAudit } from "@/lib/server/persist";
import * as persistModule from "@/lib/server/persist";

beforeEach(() => {
  _resetRegistry();
  resetDb(":memory:");
});

// A fake child process that streams the given stdout lines then closes with `code`.
function fakeChild(lines: string[], code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    pid: number;
    kill: (s?: NodeJS.Signals) => boolean;
  };
  child.stdout = Readable.from(lines.map((l) => l + "\n"));
  child.stderr = Readable.from([]);
  child.pid = 4242;
  child.kill = () => true;
  // close fires after stdout drains
  child.stdout.on("end", () => setImmediate(() => child.emit("close", code)));
  return child;
}

describe("buildArgs — argv typing + injection rejection (T1)", () => {
  it("builds argv only from server-minted provenance values", () => {
    const slug = mintLane("lane-abc");
    expect(buildArgs({ cmd: "wt-new", slug })).toEqual(["wt-new", "lane-abc"]);
    expect(buildArgs({ cmd: "integ-merge", slug })).toEqual(["integ-merge", "lane-abc"]);
    const session = mintSession("sess_01");
    expect(buildArgs({ cmd: "trace", session })).toEqual(["trace", "sess_01"]);
  });

  it("REJECTS an unminted slug even if it matches the shape (provenance, not regex)", () => {
    // Shape-valid but never minted → provenance check fails.
    expect(() => buildArgs({ cmd: "wt-commit", slug: "lane-notminted" })).toThrow(HarnessArgError);
  });

  it("REJECTS a shell/path-injection slug string", () => {
    for (const evil of ["lane; rm -rf /", "../../etc/passwd", "$(whoami)", "a b", "LANE"]) {
      expect(() => buildArgs({ cmd: "wt-new", slug: evil })).toThrow(HarnessArgError);
    }
  });

  it("REJECTS a plan file that escapes the allow-dir (T5)", () => {
    // even a minted-looking traversal name is rejected at mint AND containment.
    expect(() => mintPlanFile("../evil.jsonl")).toThrow(HarnessArgError);
    expect(() => containedPlanFile("../../etc/shadow")).toThrow(HarnessArgError);
  });

  it("contains a legitimate minted plan file under the allow-dir", () => {
    const name = mintPlanFile("plan-abc.jsonl");
    const abs = buildArgs({ cmd: "budget", planFile: name });
    expect(abs[0]).toBe("budget");
    expect(abs[1].endsWith("/data/plans/plan-abc.jsonl")).toBe(true);
  });

  it("refuses promote unless ENABLE_PROMOTE_TO_MAIN=1 (audited as refused)", async () => {
    delete process.env.ENABLE_PROMOTE_TO_MAIN;
    await expect(spawnHarness({ cmd: "promote" }, () => {})).rejects.toThrow(HarnessArgError);
    expect(listAudit()[0]).toMatchObject({ cmd: "promote", outcome: "refused" });
  });
});

describe("parseHarnessLine — per-event-type schema whitelist (T4)", () => {
  it("copies ONLY whitelisted fields; drops a smuggled extra field", () => {
    const line = JSON.stringify({
      type: "gate",
      id: "B",
      status: "raised",
      severity: "high",
      summary: "cross-review block",
      subtaskId: "px-b",
      leakedSecret: "sk-ant-XXXX", // must be dropped
      __proto__: { polluted: true },
    });
    const ev = parseHarnessLine(line)!;
    expect(ev).toBeTruthy();
    expect(ev).not.toHaveProperty("leakedSecret");
    expect(Object.keys(ev).sort()).toEqual(["id", "severity", "status", "subtaskId", "summary", "type"]);
  });

  it("drops an event missing a required field", () => {
    expect(parseHarnessLine(JSON.stringify({ type: "phase", phase: 2 }))).toBeNull(); // no status
    expect(parseHarnessLine(JSON.stringify({ type: "gate", id: "A", status: "raised" }))).toBeNull(); // no severity/summary
  });

  it("drops an event with a bad enum / out-of-range value", () => {
    expect(parseHarnessLine(JSON.stringify({ type: "phase", phase: 9, status: "active" }))).toBeNull();
    expect(parseHarnessLine(JSON.stringify({ type: "gate", id: "Z", status: "raised", severity: "high", summary: "x" }))).toBeNull();
    expect(parseHarnessLine(JSON.stringify({ type: "health", verdict: "on-fire" }))).toBeNull();
  });

  it("drops unknown types, prototype keys, and non-JSON lines", () => {
    expect(parseHarnessLine(JSON.stringify({ type: "constructor" }))).toBeNull();
    expect(parseHarnessLine(JSON.stringify({ type: "memory", secret: 1 }))).toBeNull();
    expect(parseHarnessLine("harness.sh: creating worktree…")).toBeNull();
    expect(parseHarnessLine("")).toBeNull();
    expect(parseHarnessLine("{not json")).toBeNull();
  });

  it("drops an event whose string field exceeds the per-field size cap (T6)", () => {
    const bigSummary = "z".repeat(8 * 1024 + 1); // > MAX_FIELD_LEN
    const line = JSON.stringify({ type: "gate", id: "B", status: "raised", severity: "high", summary: bigSummary });
    expect(parseHarnessLine(line)).toBeNull();
    // a normal-length summary still passes
    expect(parseHarnessLine(JSON.stringify({ type: "gate", id: "B", status: "raised", severity: "high", summary: "ok" }))).toBeTruthy();
  });

  it("reduces nested objects (approval/evals/evidence) to known fields", () => {
    const phase = parseHarnessLine(
      JSON.stringify({ type: "phase", phase: 6, status: "active", approval: { kind: "promote-to-main", state: "awaiting", extra: "x" } })
    )!;
    expect(phase.approval).toEqual({ kind: "promote-to-main", state: "awaiting" });
    const health = parseHarnessLine(
      JSON.stringify({ type: "health", verdict: "healthy", evals: { regressionPass: true, capabilityScore: 0.9, junk: 1 } })
    )!;
    expect(health.evals).toEqual({ regressionPass: true, capabilityScore: 0.9 });
  });
});

describe("spawnHarness — shell:false + audit row per spawn (T7)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("spawns with shell:false and streams only schema-valid events", async () => {
    mintLane("lane-x");
    const spawnFn = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      expect(opts.shell).toBe(false); // CRITICAL invariant
      return fakeChild([
        JSON.stringify({ type: "phase", phase: 2, status: "active" }),
        "not-json noise line",
        JSON.stringify({ type: "trace", tool: "Read", sig: "a.ts", stolen: "secret" }),
      ], 0) as never;
    });
    const events: ParsedHarnessEvent[] = [];
    const { code } = await spawnHarness({ cmd: "wt-verify", slug: "lane-x" }, (e) => events.push(e), { spawnFn });
    expect(code).toBe(0);
    expect(events.map((e) => e.type)).toEqual(["phase", "trace"]);
    expect(events[1]).not.toHaveProperty("stolen");
    // one audit row for the successful spawn
    const audit = listAudit();
    expect(audit[0]).toMatchObject({ cmd: "wt-verify", outcome: "exit", code: 0 });
    expect(audit[0].argv).toEqual(["wt-verify", "lane-x"]);
  });

  it("writes an invalid-args audit row and never spawns on unminted input", async () => {
    const spawnFn = vi.fn();
    await expect(spawnHarness({ cmd: "wt-commit", slug: "lane-unminted" }, () => {}, { spawnFn: spawnFn as never })).rejects.toThrow(
      HarnessArgError
    );
    expect(spawnFn).not.toHaveBeenCalled();
    const audit = listAudit();
    expect(audit[0]).toMatchObject({ cmd: "wt-commit", outcome: "invalid-args" });
    expect(audit[0].argv).toEqual([]);
    // the audit error is the CLASS name only — never the rejected value
    expect(audit[0].error).toBe("HarnessArgError");
  });

  it("passes a MINIMAL allowlisted env — a canary secret in process.env never reaches the child (T4b)", async () => {
    mintLane("lane-env");
    process.env.SUPER_SECRET_CANARY = "canary-shhh-0xDEADBEEF";
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-pass-through";
    process.env.HARNESS_FLAG_X = "keep-me";
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnFn = vi.fn((_cmd: string, _args: string[], opts: Record<string, unknown>) => {
      capturedEnv = opts.env as NodeJS.ProcessEnv;
      return fakeChild([], 0) as never;
    });
    try {
      await spawnHarness({ cmd: "wt-verify", slug: "lane-env" }, () => {}, { spawnFn });
      expect(capturedEnv).toBeDefined();
      // The canary secret is absent — by name AND by value.
      expect(capturedEnv!.SUPER_SECRET_CANARY).toBeUndefined();
      expect(capturedEnv!.ANTHROPIC_API_KEY).toBeUndefined();
      expect(Object.values(capturedEnv!)).not.toContain("canary-shhh-0xDEADBEEF");
      // The child still gets what it needs.
      expect(capturedEnv!.PATH).toBeDefined();
      expect(capturedEnv!.HARNESS_FLAG_X).toBe("keep-me");
    } finally {
      delete process.env.SUPER_SECRET_CANARY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.HARNESS_FLAG_X;
    }
  });

  it("minimalChildEnv keeps only PATH/HOME/... + HARNESS_* + the promote flag", () => {
    const env = minimalChildEnv({
      PATH: "/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant-xxxx",
      NTFY_TOKEN: "tk_leak",
      HARNESS_LIVE: "1",
      ENABLE_PROMOTE_TO_MAIN: "1",
      RANDOM_OTHER: "nope",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", HARNESS_LIVE: "1", ENABLE_PROMOTE_TO_MAIN: "1" });
  });

  it("FAILS CLOSED: if the mandatory pre-spawn audit throws, it never spawns (T7)", async () => {
    mintLane("lane-noaudit");
    const spy = vi.spyOn(persistModule, "appendAudit").mockImplementation(() => {
      throw new Error("db down");
    });
    const spawnFn = vi.fn();
    await expect(
      spawnHarness({ cmd: "wt-verify", slug: "lane-noaudit" }, () => {}, { spawnFn: spawnFn as never })
    ).rejects.toThrow(/db down/);
    expect(spawnFn).not.toHaveBeenCalled(); // no unaudited spawn
    spy.mockRestore();
  });

  it("drops oversize stdout lines and kills+rejects on an egregious flood (T6)", async () => {
    mintLane("lane-flood");
    const big = "x".repeat(64 * 1024 + 1); // > MAX_LINE_LEN
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      pid: number;
      kill: (s?: NodeJS.Signals) => boolean;
    };
    child.stdout = Readable.from(Array.from({ length: 60 }, () => big + "\n")); // > MAX_OVERSIZE_LINES
    child.stderr = Readable.from([]);
    child.pid = undefined as unknown as number; // no pid → child.kill fallback (no real group kill)
    const killed: NodeJS.Signals[] = [];
    child.kill = ((s: NodeJS.Signals) => {
      killed.push(s);
      return true;
    }) as never;
    child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
    const spawnFn = vi.fn(() => child as never);
    const events: ParsedHarnessEvent[] = [];
    await expect(
      spawnHarness({ cmd: "wt-verify", slug: "lane-flood" }, (e) => events.push(e), { spawnFn })
    ).rejects.toThrow(/flood/);
    expect(events).toHaveLength(0); // oversize lines never parsed/forwarded
    expect(killed).toContain("SIGKILL");
    expect(listAudit()[0]).toMatchObject({ cmd: "wt-verify", outcome: "error", error: "stdout-flood" });
  });

  it("times out a hung child (SIGTERM→SIGKILL) and rejects HarnessTimeoutError", async () => {
    mintLane("lane-hang");
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; pid: number; kill: () => boolean };
    child.stdout = new Readable({ read() {} }); // never ends
    child.stderr = new Readable({ read() {} });
    child.pid = undefined as unknown as number; // no pid → child.kill fallback
    const killed: NodeJS.Signals[] = [];
    child.kill = ((s: NodeJS.Signals) => {
      killed.push(s);
      if (s === "SIGKILL") setImmediate(() => child.emit("close", null));
      return true;
    }) as never;
    const spawnFn = vi.fn(() => child as never);
    await expect(
      spawnHarness({ cmd: "wt-new", slug: "lane-hang" }, () => {}, { spawnFn, timeoutMs: 10, killGraceMs: 5 })
    ).rejects.toThrow(HarnessTimeoutError);
    expect(killed).toContain("SIGTERM");
    expect(listAudit()[0]).toMatchObject({ cmd: "wt-new", outcome: "timeout" });
  });
});
