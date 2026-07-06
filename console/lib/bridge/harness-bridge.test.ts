import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import { Readable } from "stream";
import {
  buildArgs,
  parseHarnessLine,
  spawnHarness,
  containedPlanFile,
  HarnessArgError,
  HarnessTimeoutError,
  type ParsedHarnessEvent,
} from "./harness-bridge";
import { mintLane, mintPlanFile, mintSession, _resetRegistry } from "./registry";
import { resetDb, listAudit } from "@/lib/server/persist";

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
