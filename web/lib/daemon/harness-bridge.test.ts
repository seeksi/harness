// web/lib/daemon/harness-bridge.test.ts
import { describe, it, expect, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  buildArgs,
  parseHarnessLine,
  spawnHarness,
  HarnessArgError,
  type HarnessSubcommand,
} from "./harness-bridge";

describe("buildArgs — validated enum→argv (no client strings, no shell)", () => {
  it("builds clean argv for valid subcommands", () => {
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

  it("rejects shell-injection / path-traversal attempts", () => {
    const bad: HarnessSubcommand[] = [
      { cmd: "wt-new", slug: "a; rm -rf /" },
      { cmd: "wt-new", slug: "$(whoami)" },
      { cmd: "wt-new", slug: "../etc" },
      { cmd: "wt-new", slug: "Scene" }, // uppercase not allowed
      { cmd: "wt-new", slug: "" },
      { cmd: "integ-merge", slug: "a`b`" },
      { cmd: "trace", session: "a/b" },
      { cmd: "trace", session: "a b" },
      { cmd: "budget", planFile: "../../etc/passwd" },
      { cmd: "budget", planFile: "a;b" },
      { cmd: "budget", planFile: "a/b.jsonl" },
    ];
    for (const sub of bad) {
      expect(() => buildArgs(sub), JSON.stringify(sub)).toThrow(HarnessArgError);
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
});
