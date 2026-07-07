import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import path from "path";
import os from "os";
import {
  buildDecomposePrompt,
  parseLaneBriefs,
  decomposeBrief,
  DecomposeError,
} from "./decompose";
import { HarnessTimeoutError } from "@/lib/bridge/errors";
import { _resetRegistry } from "@/lib/bridge/registry";
import { resetDb, listAudit } from "@/lib/server/persist";
import * as persist from "@/lib/server/persist";

beforeEach(() => {
  resetDb(":memory:");
  _resetRegistry();
  vi.unstubAllEnvs();
  // Direct mode requires the explicit opt-out (mirrors agent-runner's tests).
  vi.stubEnv("AGENT_ALLOW_DIRECT", "1");
  // AGENT_HOME set (non-empty) ⇒ explicit-override path: decomposeBrief skips isolated-home
  // provisioning, keeping these tests off the real filesystem.
  vi.stubEnv("AGENT_HOME", path.join(os.tmpdir(), "decomp-home-override"));
});

/** Wrap an inner lanes object (or raw string) in claude's --output-format json envelope. */
function envelope(inner: unknown): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    result: typeof inner === "string" ? inner : JSON.stringify(inner),
  });
}

/** Fake claude child emitting `lines` on stdout then closing with `code`. */
function fakeSpawn(lines: string[], code = 0) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: Readable };
    child.stdout = Readable.from(lines.map((l) => l + "\n"));
    child.stdout.on("end", () => child.emit("close", code));
    return child as unknown as ChildProcess;
  });
}

describe("buildDecomposePrompt", () => {
  it("embeds the brief, is READ-ONLY, states the JSON output shape, and forbids Bash", () => {
    const p = buildDecomposePrompt("SPLIT THIS FEATURE");
    expect(p).toContain("SPLIT THIS FEATURE");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain('{"lanes":[{"brief"');
    expect(p).toContain("no Bash");
  });
});

describe("parseLaneBriefs — happy path + fence stripping", () => {
  it("composes task text + the OWNS list", () => {
    const [lane] = parseLaneBriefs(envelope({ lanes: [{ brief: "do the thing", owns: ["api/foo.ts"] }] }));
    expect(lane).toBe("do the thing\n\nOWNS — modify ONLY these paths:\n- api/foo.ts");
  });

  it("parses a ```json fenced result the model added despite instructions", () => {
    const fenced = "```json\n" + JSON.stringify({ lanes: [{ brief: "b", owns: ["a/b.ts"] }] }) + "\n```";
    const [lane] = parseLaneBriefs(envelope(fenced));
    expect(lane).toBe("b\n\nOWNS — modify ONLY these paths:\n- a/b.ts");
  });

  it("keeps the OWNS list intact while truncating an oversized task to the 4000-char cap", () => {
    const [lane] = parseLaneBriefs(envelope({ lanes: [{ brief: "x".repeat(5000), owns: ["api/foo.ts"] }] }));
    expect(lane.length).toBeLessThanOrEqual(4000);
    expect(lane.endsWith("- api/foo.ts")).toBe(true);
  });

  it("keeps a LARGE owns list intact while truncating the task, staying ≤ the cap (fits-after-truncation)", () => {
    const owns = Array.from({ length: 30 }, (_, i) => `src/mod${i}/file.ts`);
    const [lane] = parseLaneBriefs(envelope({ lanes: [{ brief: "t".repeat(5000), owns }] }));
    expect(lane.length).toBeLessThanOrEqual(4000);
    expect(lane.endsWith("- src/mod29/file.ts")).toBe(true); // last (load-bearing) path never trimmed
  });
});

describe("parseLaneBriefs — fail closed (each throws DecomposeError)", () => {
  const cases: Array<[string, string]> = [
    ["non-result envelope", JSON.stringify({ type: "assistant", result: "x" })],
    ["non-string result", JSON.stringify({ type: "result", result: 123 })],
    ["inner not JSON", envelope("not json {")],
    ["0 lanes", envelope({ lanes: [] })],
    ["5 lanes", envelope({ lanes: [
      { brief: "a", owns: ["a"] },
      { brief: "b", owns: ["b"] },
      { brief: "c", owns: ["c"] },
      { brief: "d", owns: ["d"] },
      { brief: "e", owns: ["e"] },
    ] })],
    ["empty lane brief", envelope({ lanes: [{ brief: "", owns: ["a"] }] })],
    ["empty owns", envelope({ lanes: [{ brief: "x", owns: [] }] })],
    ["absolute path", envelope({ lanes: [{ brief: "x", owns: ["/etc/x"] }] })],
    ["../x escape", envelope({ lanes: [{ brief: "x", owns: ["../x"] }] })],
    ["a/../b escape", envelope({ lanes: [{ brief: "x", owns: ["a/../b"] }] })],
    ["empty-string path", envelope({ lanes: [{ brief: "x", owns: [""] }] })],
    ["non-string path", envelope({ lanes: [{ brief: "x", owns: [7] }] })],
    ["overlap equal", envelope({ lanes: [{ brief: "x", owns: ["a/b"] }, { brief: "y", owns: ["a/b"] }] })],
    ["prefix containment", envelope({ lanes: [{ brief: "x", owns: ["a"] }, { brief: "y", owns: ["a/b"] }] })],
    // Windows / drive-letter / backslash path forms (disposition 3).
    ["backslash path", envelope({ lanes: [{ brief: "x", owns: ["a\\b"] }] })],
    ["drive-letter path (C:/x)", envelope({ lanes: [{ brief: "x", owns: ["C:/x"] }] })],
    ["bare drive-letter (C:x)", envelope({ lanes: [{ brief: "x", owns: ["C:x"] }] })],
    ["UNC path (\\\\host\\share)", envelope({ lanes: [{ brief: "x", owns: ["\\\\host\\share"] }] })],
    // Fail-closed owns bounds (disposition 1).
    ["owns count > 32", envelope({ lanes: [{ brief: "x", owns: Array.from({ length: 33 }, (_, i) => `p${i}.ts`) }] })],
    ["path too long (>256)", envelope({ lanes: [{ brief: "x", owns: ["a/" + "b".repeat(300)] }] })],
    // 16 near-max-length paths ⇒ the owns block alone leaves < MIN_TASK_BUDGET under the cap.
    ["owns block leaves no task budget", envelope({ lanes: [{ brief: "x", owns: Array.from({ length: 16 }, (_, i) => `d${i}/` + "y".repeat(248)) }] })],
  ];
  for (const [name, raw] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => parseLaneBriefs(raw)).toThrow(DecomposeError);
    });
  }
});

describe("decomposeBrief — gate + spawn boundary", () => {
  it("REFUSES to spawn unless ENABLE_AGENT_EXEC=1 (default-off gate)", async () => {
    const spawnFn = vi.fn();
    await expect(
      decomposeBrief({ brief: "x", slug: "decomp-abc", model: "sonnet", spawnFn: spawnFn as never })
    ).rejects.toBeInstanceOf(DecomposeError);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(listAudit().map((r) => r.outcome)).toEqual(["refused"]);
  });

  it("runs with a minimal env (no secrets), repo-root cwd, shell:false; audit carries no brief", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-should-not-propagate");
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedShell: boolean | undefined;
    let capturedCwd: string | undefined;
    const spawnFn = vi.fn(
      (_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv; shell?: boolean; cwd?: string }) => {
        capturedEnv = options.env;
        capturedShell = options.shell;
        capturedCwd = options.cwd;
        const child = new EventEmitter() as EventEmitter & { stdout: Readable };
        child.stdout = Readable.from([envelope({ lanes: [{ brief: "TOPSECRET task", owns: ["api/foo.ts"] }] }) + "\n"]);
        child.stdout.on("end", () => child.emit("close", 0));
        return child as unknown as ChildProcess;
      }
    );

    const res = await decomposeBrief({ brief: "do TOPSECRET work", slug: "decomp-abc", model: "sonnet", spawnFn: spawnFn as never });
    expect(res.laneBriefs).toHaveLength(1);
    expect(res.laneBriefs[0]).toContain("OWNS — modify ONLY these paths:\n- api/foo.ts");

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(capturedEnv!.PATH).toBeTruthy();
    expect(capturedShell).toBe(false);
    expect(capturedCwd).toBe(path.resolve(process.env.HARNESS_REPO ?? process.cwd()));

    const log = listAudit();
    expect(log[0].argv).toEqual(["slug:decomp-abc", "model:sonnet"]);
    // The brief is opaque task text — it must NEVER be audited. The lane output likewise.
    expect(JSON.stringify(log)).not.toContain("TOPSECRET");
  });

  it("passes a READ-ONLY toolset (Read,Grep,Glob) + --strict-mcp-config, never Bash/Edit/Write or --mcp-config", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from([envelope({ lanes: [{ brief: "b", owns: ["a"] }] }) + "\n"]);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await decomposeBrief({ brief: "x", slug: "decomp-abc", model: "sonnet", spawnFn: spawnFn as never });
    const i = capturedArgs!.indexOf("--allowedTools");
    expect(capturedArgs![i + 1]).toBe("Read,Grep,Glob");
    expect(capturedArgs).not.toContain("Bash");
    expect(capturedArgs).not.toContain("Edit");
    expect(capturedArgs).not.toContain("Write");
    expect(capturedArgs).toContain("--strict-mcp-config");
    expect(capturedArgs!.filter((a) => /^--mcp-config(=|$)/.test(a))).toEqual([]);
  });

  it("spawns claude with the EXACT argv, in order (direct mode ⇒ argv passed through unchanged)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    let capturedArgs: string[] | undefined;
    const spawnFn = vi.fn((_cmd: string, args: string[]) => {
      capturedArgs = args;
      const child = new EventEmitter() as EventEmitter & { stdout: Readable };
      child.stdout = Readable.from([envelope({ lanes: [{ brief: "b", owns: ["a"] }] }) + "\n"]);
      child.stdout.on("end", () => child.emit("close", 0));
      return child as unknown as ChildProcess;
    });
    await decomposeBrief({ brief: "BRIEF", slug: "decomp-abc", model: "opus", spawnFn: spawnFn as never });
    expect(capturedArgs).toEqual([
      "-p",
      buildDecomposePrompt("BRIEF"),
      "--output-format",
      "json",
      "--model",
      "opus",
      "--allowedTools",
      "Read,Grep,Glob",
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
    ]);
  });

  it("rejects DecomposeError on a nonzero agent exit", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    const spawnFn = fakeSpawn(["boom"], 1);
    await expect(
      decomposeBrief({ brief: "x", slug: "decomp-abc", model: "sonnet", spawnFn: spawnFn as never })
    ).rejects.toBeInstanceOf(DecomposeError);
  });

  it("fails closed when the mandatory pre-spawn audit cannot be written (never spawns)", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    const spawnFn = vi.fn();
    const spy = vi.spyOn(persist, "appendAudit").mockImplementation(() => {
      throw new Error("audit sink down");
    });
    await expect(
      decomposeBrief({ brief: "x", slug: "decomp-abc", model: "sonnet", spawnFn: spawnFn as never })
    ).rejects.toThrow("audit sink down");
    expect(spawnFn).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("kills a hung agent's PROCESS GROUP (SIGTERM→SIGKILL on -pid) and rejects HarnessTimeoutError", async () => {
    vi.stubEnv("ENABLE_AGENT_EXEC", "1");
    const PID = 4242;
    let child: (EventEmitter & { stdout: Readable; pid: number }) | undefined;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((_pid: number, sig?: string) => {
      if (sig === "SIGKILL") child!.emit("close", null); // group hard-kill settles the run
      return true;
    }) as never);
    const spawnFn = vi.fn(() => {
      child = new EventEmitter() as EventEmitter & { stdout: Readable; pid: number };
      child.stdout = new Readable({ read() {} }); // never ends
      child.pid = PID;
      return child as unknown as ChildProcess;
    });

    vi.useFakeTimers();
    try {
      const settled = decomposeBrief({
        brief: "x",
        slug: "decomp-abc",
        model: "sonnet",
        spawnFn: spawnFn as never,
        timeoutMs: 20,
      }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(25); // fire the deadline → SIGTERM + arm the grace timer
      await vi.advanceTimersByTimeAsync(5_000); // fire the grace timer → SIGKILL → close
      const err = await settled;
      expect(err).toBeInstanceOf(HarnessTimeoutError);
    } finally {
      vi.useRealTimers();
    }
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(-PID, "SIGKILL");
    expect(listAudit().map((r) => r.outcome)).toEqual(["timeout", "spawn"]);
    killSpy.mockRestore();
  });
});
