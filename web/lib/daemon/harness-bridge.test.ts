// web/lib/daemon/harness-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  buildArgs,
  parseHarnessLine,
  spawnHarness,
  HarnessArgError,
} from "./harness-bridge";
import { mintLane, mintSession, mintPlanFile, _resetRegistry } from "./registry";

beforeEach(() => _resetRegistry());

describe("buildArgs — server-minted provenance → argv (no client strings, no shell)", () => {
  it("builds clean argv for minted slugs/sessions/plan-files + static subcommands", () => {
    mintLane("scene");
    mintLane("control-plane");
    mintSession("abc123_DEF");
    mintPlanFile("plan.jsonl");
    expect(buildArgs({ cmd: "wt-new", slug: "scene" })).toEqual(["wt-new", "scene"]);
    expect(buildArgs({ cmd: "integ-merge", slug: "control-plane" })).toEqual([
      "integ-merge",
      "control-plane",
    ]);
    expect(buildArgs({ cmd: "trace", session: "abc123_DEF" })).toEqual(["trace", "abc123_DEF"]);
    expect(buildArgs({ cmd: "budget", planFile: "plan.jsonl" })).toEqual(["budget", "plan.jsonl"]);
    expect(buildArgs({ cmd: "integ-start" })).toEqual(["integ-start"]);
    expect(buildArgs({ cmd: "promote" })).toEqual(["promote"]);
  });

  it("rejects a regex-VALID but UNMINTED slug/session/plan-file (provenance over pattern — T1)", () => {
    // These match the shape regex but were never minted by the server → rejected.
    expect(() => buildArgs({ cmd: "wt-new", slug: "scene" })).toThrow(HarnessArgError);
    expect(() => buildArgs({ cmd: "integ-merge", slug: "scene" })).toThrow(HarnessArgError);
    expect(() => buildArgs({ cmd: "trace", session: "abc123" })).toThrow(HarnessArgError);
    expect(() => buildArgs({ cmd: "budget", planFile: "plan.jsonl" })).toThrow(HarnessArgError);
    // After minting, the same value passes.
    mintLane("scene");
    expect(buildArgs({ cmd: "wt-new", slug: "scene" })).toEqual(["wt-new", "scene"]);
  });

  it("mint rejects shell-injection / path-traversal shapes (defense in depth)", () => {
    const badSlugs = ["a; rm -rf /", "$(whoami)", "../etc", "Scene", "", "a`b`"];
    for (const s of badSlugs) {
      expect(() => mintLane(s), s).toThrow(HarnessArgError);
    }
    for (const s of ["a/b", "a b", ".."]) {
      expect(() => mintSession(s), s).toThrow(HarnessArgError);
    }
    for (const s of ["../../etc/passwd", "a;b", "a/b.jsonl", ".."]) {
      expect(() => mintPlanFile(s), s).toThrow(HarnessArgError);
    }
  });
});

describe("parseHarnessLine — structured-only, ignores human output", () => {
  it("parses a valid JSON event line", () => {
    expect(parseHarnessLine('{"type":"phase","phase":1,"status":"active"}')).toEqual({
      type: "phase",
      phase: 1,
      status: "active",
    });
  });

  it("ignores non-JSON, unknown types, and malformed JSON", () => {
    expect(parseHarnessLine("promoted integration -> main (fast-forward)")).toBeNull();
    expect(parseHarnessLine('{"type":"evil","x":1}')).toBeNull();
    expect(parseHarnessLine("{not json")).toBeNull();
    expect(parseHarnessLine("")).toBeNull();
  });

  it("rejects hello — the stream route owns the resync snapshot", () => {
    expect(parseHarnessLine('{"type":"hello","run":{}}')).toBeNull();
  });

  it("rejects inherited Object keys as types (no prototype-chain bypass)", () => {
    expect(parseHarnessLine('{"type":"constructor"}')).toBeNull();
    expect(parseHarnessLine('{"type":"toString"}')).toBeNull();
    expect(parseHarnessLine('{"type":"hasOwnProperty"}')).toBeNull();
    expect(parseHarnessLine('{"type":"__proto__"}')).toBeNull();
  });

  it("strips unknown fields — a smuggled extra field never passes through (T4)", () => {
    const out = parseHarnessLine(
      '{"type":"phase","phase":1,"status":"active","ANTHROPIC_API_KEY":"sk-leak","x":1}'
    );
    expect(out).toEqual({ type: "phase", phase: 1, status: "active" });
    expect(out as Record<string, unknown>).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("drops events missing a required field or with a bad enum (T4)", () => {
    expect(parseHarnessLine('{"type":"phase","phase":1}')).toBeNull(); // missing status
    expect(parseHarnessLine('{"type":"phase","phase":9,"status":"active"}')).toBeNull(); // phase out of range
    expect(parseHarnessLine('{"type":"phase","phase":1,"status":"nope"}')).toBeNull(); // bad enum
    expect(parseHarnessLine('{"type":"gate","id":"Z","status":"raised","severity":"high","summary":"x"}')).toBeNull(); // bad gate id
    expect(parseHarnessLine('{"type":"agentFire","id":"a","subtaskId":"s","kind":"review","severity":"high"}')).toBeNull(); // missing firedAt
  });

  it("reduces nested counts to known fields only (T4)", () => {
    const out = parseHarnessLine(
      '{"type":"gate","id":"C","status":"raised","severity":"high","summary":"x","counts":{"high":2,"critical":1,"secret":"s"}}'
    );
    expect(out).toEqual({
      type: "gate",
      id: "C",
      status: "raised",
      severity: "high",
      summary: "x",
      counts: { high: 2, critical: 1 },
    });
  });

  it("keeps valid optional fields", () => {
    expect(
      parseHarnessLine('{"type":"subtask","id":"st-a","status":"building","phase":2,"model":"opus"}')
    ).toEqual({ type: "subtask", id: "st-a", status: "building", phase: 2, model: "opus" });
  });
});

describe("spawnHarness — shell:false + validated argv + structured-only events", () => {
  it("spawns with shell:false and the buildArgs argv, forwarding only parsed events", async () => {
    let captured: { cmd: string; args: string[]; shell: unknown } | null = null;
    const fakeSpawn = vi.fn((cmd: string, args: string[], options: { shell?: boolean }) => {
      captured = { cmd, args, shell: options.shell };
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from([
        '{"type":"phase","phase":2,"status":"active"}\n',
        "promoted integration -> main\n", // human line — must be ignored
        '{"type":"gate","id":"C","status":"raised","severity":"high","summary":"conflict"}\n',
      ]);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });

    mintLane("scene");
    const events: string[] = [];
    const result = await spawnHarness(
      { cmd: "wt-new", slug: "scene" },
      (e) => events.push(e.type),
      { spawnFn: fakeSpawn as never, scriptPath: "/x/harness.sh" }
    );

    expect(result.code).toBe(0);
    expect(captured!.args).toEqual(["wt-new", "scene"]);
    expect(captured!.shell).toBe(false);
    expect(events).toEqual(["phase", "gate"]); // human line dropped
  });

  it("validates args before spawning (never spawns on bad input)", async () => {
    const fakeSpawn = vi.fn();
    await expect(
      spawnHarness({ cmd: "wt-new", slug: "../bad" }, () => {}, { spawnFn: fakeSpawn as never })
    ).rejects.toBeInstanceOf(HarnessArgError);
    expect(fakeSpawn).not.toHaveBeenCalled();
  });

  it("refuses to spawn promote unless the default-off flag is set", async () => {
    const fakeSpawn = vi.fn();
    const prev = process.env.ENABLE_PROMOTE_TO_MAIN;
    delete process.env.ENABLE_PROMOTE_TO_MAIN;
    try {
      await expect(
        spawnHarness({ cmd: "promote" }, () => {}, { spawnFn: fakeSpawn as never })
      ).rejects.toBeInstanceOf(HarnessArgError);
      expect(fakeSpawn).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.ENABLE_PROMOTE_TO_MAIN = prev;
    }
  });
});
