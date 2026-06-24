// web/lib/daemon/harness-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import path from "path";
import {
  buildArgs,
  parseHarnessLine,
  spawnHarness,
  containedPlanFile,
  HarnessArgError,
  HarnessTimeoutError,
} from "./harness-bridge";
import { mintLane, mintSession, mintPlanFile, _resetRegistry } from "./registry";
import { resetDb, getAuditLog } from "@/lib/store/persist";

beforeEach(() => {
  _resetRegistry();
  // Fresh in-memory DB per test so the default audit sink (T7) is isolated and
  // never touches the real ./data/umbrella.db file.
  resetDb(":memory:");
});

describe("buildArgs — server-minted provenance → argv (no client strings, no shell)", () => {
  it("builds clean argv for minted slugs/sessions/plan-files + static subcommands", () => {
    mintLane("scene");
    mintLane("control-plane");
    mintSession("abc123_DEF");
    mintPlanFile("plan.jsonl");
    expect(buildArgs({ cmd: "wt-new", slug: "scene" })).toEqual(["wt-new", "scene"]);
    expect(buildArgs({ cmd: "wt-verify", slug: "scene" })).toEqual(["wt-verify", "scene"]);
    expect(buildArgs({ cmd: "integ-merge", slug: "control-plane" })).toEqual([
      "integ-merge",
      "control-plane",
    ]);
    expect(buildArgs({ cmd: "trace", session: "abc123_DEF" })).toEqual(["trace", "abc123_DEF"]);
    expect(buildArgs({ cmd: "integ-start" })).toEqual(["integ-start"]);
    expect(buildArgs({ cmd: "promote" })).toEqual(["promote"]);
    // budget resolves the minted plan file to the absolute contained path (T5).
    expect(buildArgs({ cmd: "budget", planFile: "plan.jsonl" })).toEqual([
      "budget",
      containedPlanFile("plan.jsonl"),
    ]);
  });

  it("contains plan files under the allow-dir and rejects escapes (T5)", () => {
    const baseAbs = path.resolve(process.env.HARNESS_REPO ?? process.cwd(), "data/plans");
    // A normal name resolves to a child of the allow-dir.
    const ok = containedPlanFile("plan.jsonl");
    expect(ok).toBe(path.join(baseAbs, "plan.jsonl"));
    expect(path.isAbsolute(ok)).toBe(true);
    expect(ok.startsWith(baseAbs + path.sep)).toBe(true);
    // Defense in depth: a separator/traversal name (which provenance would already
    // block upstream) is rejected by the containment layer if it ever reached it.
    for (const escape of ["../../etc/passwd", "../secret", "/etc/passwd", "a/../../b"]) {
      expect(() => containedPlanFile(escape), escape).toThrow(HarnessArgError);
    }
  });

  it("honors HARNESS_PLAN_DIR / HARNESS_REPO for the allow-dir (T5)", async () => {
    const prevDir = process.env.HARNESS_PLAN_DIR;
    const prevRepo = process.env.HARNESS_REPO;
    vi.resetModules(); // PLAN_DIR_ABS is frozen at module load — re-import with new env
    process.env.HARNESS_PLAN_DIR = "custom/plans";
    process.env.HARNESS_REPO = "/srv/harness";
    try {
      const mod = await import("./harness-bridge");
      expect(mod.containedPlanFile("p.jsonl")).toBe(path.join("/srv/harness", "custom", "plans", "p.jsonl"));
      expect(() => mod.containedPlanFile("../escape")).toThrow();
    } finally {
      if (prevDir !== undefined) process.env.HARNESS_PLAN_DIR = prevDir;
      else delete process.env.HARNESS_PLAN_DIR;
      if (prevRepo !== undefined) process.env.HARNESS_REPO = prevRepo;
      else delete process.env.HARNESS_REPO;
      vi.resetModules();
    }
  });

  it("rejects a regex-VALID but UNMINTED slug/session/plan-file (provenance over pattern — T1)", () => {
    // These match the shape regex but were never minted by the server → rejected.
    expect(() => buildArgs({ cmd: "wt-new", slug: "scene" })).toThrow(HarnessArgError);
    expect(() => buildArgs({ cmd: "wt-verify", slug: "scene" })).toThrow(HarnessArgError);
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

  it("on timeout: SIGTERM, then SIGKILL after grace, holds the slot until exit, rejects (T6)", async () => {
    let child: (EventEmitter & { stdout: Readable; kill: ReturnType<typeof vi.fn> }) | undefined;
    // The kill mock simulates the OS: SIGKILL actually reaps the child → emits close.
    const kill = vi.fn((sig: string) => {
      if (sig === "SIGKILL") setImmediate(() => child!.emit("close", null));
    });
    const fakeSpawn = vi.fn(() => {
      child = new EventEmitter() as EventEmitter & { stdout: Readable; kill: typeof kill };
      child.stdout = new Readable({ read() {} }); // never ends → simulates a hang
      child.kill = kill;
      return child as unknown as ChildProcess;
    });

    mintLane("scene");
    // The promise must NOT settle on SIGTERM — only once close fires (after SIGKILL),
    // proving the slot is held until the child is truly gone (no run overlap).
    await expect(
      spawnHarness({ cmd: "wt-new", slug: "scene" }, () => {}, {
        spawnFn: fakeSpawn as never,
        timeoutMs: 20,
        killGraceMs: 5,
      })
    ).rejects.toBeInstanceOf(HarnessTimeoutError);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledWith("SIGKILL"); // escalated after grace
    expect(getAuditLog().map((r) => r.outcome)).toEqual(["timeout"]); // T7: timeout audited
  });

  it("writes an audit record (argv + outcome + ts, never stdout/secrets) per spawn (T7)", async () => {
    const fakeSpawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from([
        '{"type":"phase","phase":1,"status":"active"}\n',
        "secret token sk-leak-should-never-be-audited\n", // stdout must NOT reach the audit
      ]);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });

    mintLane("scene");
    await spawnHarness({ cmd: "wt-new", slug: "scene" }, () => {}, {
      spawnFn: fakeSpawn as never,
      scriptPath: "/x/harness.sh",
    });

    const log = getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ cmd: "wt-new", argv: ["wt-new", "scene"], outcome: "exit", code: 0 });
    expect(typeof log[0].ts).toBe("number");
    // The audit captures argv + outcome only — no stdout content, ever.
    expect(JSON.stringify(log[0])).not.toContain("sk-leak");
  });

  it("audits refused promote and invalid args without spawning (T7)", async () => {
    const fakeSpawn = vi.fn();
    const prev = process.env.ENABLE_PROMOTE_TO_MAIN;
    delete process.env.ENABLE_PROMOTE_TO_MAIN;
    try {
      await expect(
        spawnHarness({ cmd: "promote" }, () => {}, { spawnFn: fakeSpawn as never })
      ).rejects.toBeInstanceOf(HarnessArgError);
      await expect(
        spawnHarness({ cmd: "wt-new", slug: "../bad" }, () => {}, { spawnFn: fakeSpawn as never })
      ).rejects.toBeInstanceOf(HarnessArgError);
    } finally {
      if (prev !== undefined) process.env.ENABLE_PROMOTE_TO_MAIN = prev;
    }

    expect(fakeSpawn).not.toHaveBeenCalled();
    const log = getAuditLog();
    expect(log.map((r) => r.outcome).sort()).toEqual(["invalid-args", "refused"]);
    // refused promote records the exact argv; no error message leaks the rejected value.
    const refused = log.find((r) => r.outcome === "refused")!;
    expect(refused.argv).toEqual(["promote"]);
    const invalid = log.find((r) => r.outcome === "invalid-args")!;
    expect(invalid.error).toBe("HarnessArgError"); // class name only, not the message
    expect(invalid.error).not.toContain("bad"); // the rejected value never appears
  });

  it("audits a synchronous spawn throw, and an audit observer failure never breaks the run (T7)", async () => {
    // (1) sync spawn throw → still audited as error, then rejects.
    const throwingSpawn = vi.fn(() => {
      throw new Error("spawn boom");
    });
    mintLane("scene");
    await expect(
      spawnHarness({ cmd: "wt-new", slug: "scene" }, () => {}, { spawnFn: throwingSpawn as never })
    ).rejects.toThrow("spawn boom");
    expect(getAuditLog().map((r) => r.outcome)).toEqual(["error"]);

    // (2) a throwing onAudit observer must not change the outcome (best-effort).
    const okSpawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from(['{"type":"phase","phase":1,"status":"done"}\n']);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    const result = await spawnHarness({ cmd: "wt-new", slug: "scene" }, () => {}, {
      spawnFn: okSpawn as never,
      onAudit: () => {
        throw new Error("observer boom");
      },
    });
    expect(result.code).toBe(0); // observer threw, but the run still resolved
  });

  it("completes before the deadline → resolves, no kill, single settle (T6 race)", async () => {
    const kill = vi.fn();
    const fakeSpawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { stdout: Readable; kill: typeof kill };
      child.stdout = Readable.from(['{"type":"phase","phase":1,"status":"done"}\n']);
      child.kill = kill;
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });

    mintLane("scene");
    const result = await spawnHarness({ cmd: "wt-new", slug: "scene" }, () => {}, {
      spawnFn: fakeSpawn as never,
      timeoutMs: 5_000,
    });
    expect(result.code).toBe(0);
    expect(kill).not.toHaveBeenCalled(); // deadline canceled, child never killed
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
