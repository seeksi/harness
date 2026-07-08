// Vitest coverage for bin/gantry's pure units + console HTTP/SSE client paths. The CLI stays
// a single-file zero-dep CJS script (see bin/gantry's header) — this file rides the console's
// existing vitest suite by loading it via createRequire rather than adding a separate CLI test
// harness. `require.main === module` in bin/gantry keeps `main()` from auto-running on require.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

const requireCli = createRequire(import.meta.url);
// bin/gantry is untyped plain CJS — no rule bans `any` in this config, so no disable needed.
const gantry: any = requireCli("../../../bin/gantry");
const { parseArgs, baseUrl, csrfHeaders, api, resolveProject, renderEvent, cmdStatus, followRun } = gantry;
// Resolve the bin path from THIS file's location (not process.cwd()) so the subprocess tests
// don't depend on which directory vitest was launched from.
const GANTRY_BIN = requireCli.resolve("../../../bin/gantry");

// Every die() path in bin/gantry ends in a real process.exit(1); stub it to throw a sentinel
// instead so a test can assert the die happened without actually killing the test worker.
class ExitSignal extends Error {
  code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as any);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
  logSpy.mockRestore();
});

// --- parseArgs ------------------------------------------------------------------------------
describe("parseArgs", () => {
  const runOpts = {
    lane: { type: "string", multiple: true, default: [] },
    decompose: { type: "boolean", default: false },
    project: { type: "string" },
    model: { type: "string", default: "auto" },
    url: { type: "string", default: "http://x.test" },
    "no-follow": { type: "boolean", default: false },
  };

  it("parses --flag=value and --flag value long-option forms", () => {
    const { values } = parseArgs({ args: ["--project=foo", "--model", "opus"], options: runOpts, allowPositionals: true });
    expect(values.project).toBe("foo");
    expect(values.model).toBe("opus");
  });

  it("applies declared defaults when an option is absent", () => {
    const { values } = parseArgs({ args: [], options: runOpts });
    expect(values.decompose).toBe(false);
    expect(values.model).toBe("auto");
    expect(values.lane).toEqual([]);
    expect(values.url).toBe("http://x.test");
  });

  it("dies on an unknown option", () => {
    expect(() => parseArgs({ args: ["--bogus"], options: runOpts })).toThrow(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown option '--bogus'"));
  });

  it("dies when a value-taking option is missing its value", () => {
    expect(() => parseArgs({ args: ["--project"], options: runOpts })).toThrow(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("dies on a stray positional when allowPositionals is false (default)", () => {
    expect(() => parseArgs({ args: ["stray"], options: { url: { type: "string", default: "x" } } })).toThrow(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("collects positionals when allowPositionals is true", () => {
    const { positionals } = parseArgs({ args: ["a brief"], options: runOpts, allowPositionals: true });
    expect(positionals).toEqual(["a brief"]);
  });

  it("--lane repeats into an array (multiple: true)", () => {
    const { values } = parseArgs({ args: ["--lane", "a", "--lane", "b"], options: runOpts, allowPositionals: true });
    expect(values.lane).toEqual(["a", "b"]);
  });

  it("--decompose is a value-less boolean flag", () => {
    const { values } = parseArgs({ args: ["--decompose"], options: runOpts, allowPositionals: true });
    expect(values.decompose).toBe(true);
    expect(() =>
      parseArgs({ args: ["--decompose=1"], options: runOpts, allowPositionals: true })
    ).toThrow(ExitSignal); // boolean flags reject an explicit value
  });

  // The four "run" guards (>1 positional, bad --model, >4 lanes, --decompose XOR --lane) live
  // inline in main(), which is intentionally unexported (it reads live process.argv and drives
  // cmdRun/cmdUp side effects). Exercise them as a real subprocess instead of spying in-process
  // — each guard dies before any network call, so this is fast and deterministic.
  describe("run-command guards (subprocess)", () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [GANTRY_BIN, "run", ...args], { encoding: "utf8" });

    it("dies with more than one positional brief", () => {
      const r = run("brief one", "brief two");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("one brief only");
    });

    it("dies on an invalid --model", () => {
      const r = run("brief", "--model", "bogus");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("--model must be auto|haiku|sonnet|opus");
    });

    it("dies with more than 4 --lane briefs", () => {
      const r = run("brief", "--lane", "a", "--lane", "b", "--lane", "c", "--lane", "d", "--lane", "e");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("at most 4 --lane briefs");
    });

    it("dies when --decompose and --lane are combined", () => {
      const r = run("brief", "--decompose", "--lane", "a");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("mutually exclusive");
    });
  });
});

// --- baseUrl / csrfHeaders --------------------------------------------------------------------
describe("baseUrl", () => {
  it("passes through valid http/https URLs unchanged", () => {
    expect(baseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(baseUrl("https://example.com")).toBe("https://example.com");
  });

  it("preserves a trailing slash as-is (no normalization)", () => {
    expect(baseUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
  });

  it("dies on an invalid URL", () => {
    expect(() => baseUrl("not-a-url")).toThrow(ExitSignal);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("invalid console URL"));
  });
});

describe("csrfHeaders", () => {
  it("builds the console's required CSRF header set from the base URL's origin", () => {
    const headers = csrfHeaders("http://127.0.0.1:3000/some/path");
    expect(headers).toEqual({
      "content-type": "application/json",
      "x-harness-request": "1",
      "sec-fetch-site": "same-origin",
      origin: "http://127.0.0.1:3000",
    });
  });
});

// --- renderEvent (used internally by followRun; spot-check directly too) ----------------------
describe("renderEvent", () => {
  it("renders a phase event line", () => {
    const line = renderEvent({ ts: Date.now() / 1000, type: "phase", payload: { phase: 2, status: "done" } });
    expect(line).toContain("phase build done");
  });

  it("returns null for chatty per-tool-call trace/sync frames", () => {
    expect(renderEvent({ ts: Date.now() / 1000, type: "trace", payload: {} })).toBeNull();
    expect(renderEvent({ ts: Date.now() / 1000, type: "sync", payload: {} })).toBeNull();
  });
});

// --- api / resolveProject / cmdStatus / followRun against a mock console server ---------------
// A request to an unexpected route/method returns 404 so a client that stops calling the right
// endpoint (e.g. resolveProject no longer hitting /api/projects) fails the test instead of
// silently reading a happy payload the handler would otherwise have returned unconditionally.
function notFound(res: http.ServerResponse) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unexpected route/method" }));
}

describe("HTTP/SSE client paths (mock node:http server)", () => {
  let server: http.Server;
  let base: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("mock server address unavailable");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    handler = (_req, res) => notFound(res);
  });

  describe("api", () => {
    it("returns the parsed JSON body on a 2xx response", async () => {
      handler = (req, res) => {
        // A route/method regression must 404 (→ die) rather than fall through to the happy body.
        if (req.method !== "GET" || req.url !== "/api/whatever") return notFound(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      };
      await expect(api(base, "/api/whatever")).resolves.toEqual({ ok: true });
    });

    it("dies with the response's error message on a non-2xx response", async () => {
      handler = (req, res) => {
        if (req.method !== "GET" || req.url !== "/api/whatever") return notFound(res);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
      };
      await expect(api(base, "/api/whatever")).rejects.toThrow(ExitSignal);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("bad request"));
    });

    it("dies with a reachability hint when the console can't be reached", async () => {
      // Bind, read the port, then close — nothing is listening there anymore.
      const dead = http.createServer();
      await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
      const addr = dead.address();
      const deadPort = addr && typeof addr !== "string" ? addr.port : 0;
      await new Promise<void>((resolve) => dead.close(() => resolve()));

      await expect(api(`http://127.0.0.1:${deadPort}`, "/api/whatever")).rejects.toThrow(ExitSignal);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("cannot reach console"));
    });
  });

  describe("resolveProject", () => {
    const projects = [
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ];

    beforeEach(() => {
      handler = (req, res) => {
        if (req.method !== "GET" || req.url !== "/api/projects") return notFound(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ projects }));
      };
    });

    it("resolves by exact id match", async () => {
      await expect(resolveProject(base, "p2")).resolves.toEqual(projects[1]);
    });

    it("resolves by exact name match", async () => {
      await expect(resolveProject(base, "Alpha")).resolves.toEqual(projects[0]);
    });

    it("dies when the wanted project matches nothing", async () => {
      await expect(resolveProject(base, "nope")).rejects.toThrow(ExitSignal);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unknown project 'nope'"));
    });

    it("auto-selects the only project when none is requested", async () => {
      handler = (req, res) => {
        if (req.method !== "GET" || req.url !== "/api/projects") return notFound(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ projects: [projects[0]] }));
      };
      await expect(resolveProject(base, undefined)).resolves.toEqual(projects[0]);
    });

    it("falls back to the project matching the cwd basename among several", async () => {
      // try/finally so a failed assertion can't leak the mocked cwd into a later test.
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/some/path/Beta");
      try {
        await expect(resolveProject(base, undefined)).resolves.toEqual(projects[1]);
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it("dies when several projects exist and none is requested or matches cwd", async () => {
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/some/path/nothing-matches");
      try {
        await expect(resolveProject(base, undefined)).rejects.toThrow(ExitSignal);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it("dies when the console has no projects at all", async () => {
      handler = (req, res) => {
        if (req.method !== "GET" || req.url !== "/api/projects") return notFound(res);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
      };
      await expect(resolveProject(base, undefined)).rejects.toThrow(ExitSignal);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no projects discovered"));
    });
  });

  describe("cmdStatus", () => {
    it("renders GET /api/runs + /api/projects — project name/id, run outcome+brief, and the empty-project note", async () => {
      handler = (req, res) => {
        if (req.method !== "GET") return notFound(res);
        if (req.url === "/api/runs") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ live: true, slot: "abc" }));
        } else if (req.url === "/api/projects") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              projects: [
                { id: "p1", name: "Alpha", recentRuns: [{ outcome: "done", startedAt: 1700000000, brief: "hello-brief" }] },
                { id: "p2", name: "Beta", recentRuns: [] },
              ],
            })
          );
        } else {
          notFound(res);
        }
      };
      await expect(cmdStatus(base)).resolves.toBeUndefined();
      // Non-TTY under vitest, so bin/gantry emits plain strings (no ANSI) — assert the content.
      const out = logSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
      expect(out).toContain("Alpha");
      expect(out).toContain("(p1)");
      expect(out).toContain("done"); // recent run outcome mark
      expect(out).toContain("hello-brief"); // the brief text
      expect(out).toContain("no runs yet"); // Beta has an empty recentRuns list
    });
  });

  describe("followRun (SSE)", () => {
    // Frames are written synchronously in one handler call; the client still reads them as an
    // async iterable over the response body, so this exercises the real chunk-buffering logic
    // in bin/gantry without needing real network timing.
    const frame = (env: unknown) => `data: ${JSON.stringify(env)}\n\n`;
    // The client MUST hit GET /api/fleet/stream with an SSE Accept header; a regression on any
    // of those 404s (→ die) instead of streaming, failing the happy-path tests below.
    const isStreamRequest = (req: http.IncomingMessage) =>
      req.method === "GET" && req.url === "/api/fleet/stream" && (req.headers.accept ?? "").includes("text/event-stream");

    it("filters to the target runId, skips a malformed JSON line, and resolves 'done'", async () => {
      handler = (req, res) => {
        if (!isStreamRequest(req)) return notFound(res);
        res.writeHead(200, { "content-type": "text/event-stream" });
        // A terminal frame for a DIFFERENT run must not resolve our followRun call.
        res.write(frame({ runId: "other-run", type: "health", ts: Date.now() / 1000, payload: { verdict: "x", lifecycle: "failed" } }));
        // Malformed JSON must be skipped, not fatal.
        res.write("data: {not valid json\n\n");
        // Our run's terminal frame.
        res.write(frame({ runId: "r1", type: "health", ts: Date.now() / 1000, payload: { verdict: "ok", lifecycle: "done" } }));
        res.end();
      };
      await expect(followRun(base, "r1")).resolves.toBe("done");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("resolves 'failed' on a failed lifecycle frame for the target run", async () => {
      handler = (req, res) => {
        if (!isStreamRequest(req)) return notFound(res);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ runId: "r2", type: "health", ts: Date.now() / 1000, payload: { verdict: "bad", lifecycle: "failed" } }));
        res.end();
      };
      await expect(followRun(base, "r2")).resolves.toBe("failed");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("dies when the stream endpoint responds with a non-ok status", async () => {
      handler = (req, res) => {
        if (!isStreamRequest(req)) return notFound(res);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("nope");
      };
      await expect(followRun(base, "r3")).rejects.toThrow(ExitSignal);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("returns 'unknown' (not fatal) when the stream can't be reached at all", async () => {
      // followRun itself never calls process.exit for done/failed — cmdRun (unexported, not in
      // scope here since it depends on live process.argv) maps the returned lifecycle string to
      // an exit code. This connect-failure path is the one spot inside followRun that could have
      // died but deliberately doesn't (a dropped stream shouldn't kill an in-flight server run).
      const dead = http.createServer();
      await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", () => resolve()));
      const addr = dead.address();
      const deadPort = addr && typeof addr !== "string" ? addr.port : 0;
      await new Promise<void>((resolve) => dead.close(() => resolve()));

      await expect(followRun(`http://127.0.0.1:${deadPort}`, "r4")).resolves.toBe("unknown");
      expect(exitSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("stream connect failed"));
    });
  });
});

// --- cmdRun follow-mode exit-code mapping (real subprocess) ----------------------------------
// followRun only RESOLVES a lifecycle string; the spec-required exit mapping (done → 0,
// failed → 1) lives in the unexported cmdRun (bin/gantry: `if (outcome !== "done") process.exit(1)`).
// The in-process followRun tests above can't see that mapping, so drive the real binary in FOLLOW
// mode against a mock console and assert the CHILD's exit code. This is the only coverage that
// would catch a broken done→0 / failed→1 mapping.
describe("cmdRun follow-mode exit codes (subprocess)", () => {
  // Spin up a mock console that satisfies the full run→follow path (single project so
  // resolveProject auto-selects, POST /api/runs returns the runId, then an SSE health frame with
  // the given terminal lifecycle), run `gantry run` WITHOUT --no-follow, and resolve the child's
  // exit code.
  //
  // Each hit is recorded INSIDE the branch that actually served it — in particular the stream hit
  // is pushed only after the SSE Accept header is validated — so an assertion on it proves the SSE
  // follow branch ran, not merely that some GET reached the /api/fleet/stream URL.
  //
  // The stream response is deliberately LEFT OPEN after the terminal frame is written (no res.end).
  // followRun returns "unknown" on a stream drop, and cmdRun maps every non-"done" outcome to
  // exit 1 — so if the terminal frame were served then the stream closed, a REGRESSED
  // failed-lifecycle parse would still exit 1 and false-pass. Holding the stream open means the
  // child can only terminate by recognizing the terminal frame itself: a broken parse would hang
  // and TIME OUT rather than pass. (done→0 is not vulnerable that way — a missed "done" resolves
  // to "unknown"→exit 1, failing toBe(0) — but holding open keeps both directions symmetric.)
  function runFollow(lifecycle: "done" | "failed"): Promise<{ code: number; hits: string[] }> {
    return new Promise((resolve, reject) => {
      const runId = `run-${lifecycle}`;
      const hits: string[] = [];
      let streamRes: import("node:http").ServerResponse | undefined;
      const srv = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (req.method === "GET" && url === "/api/projects") {
          hits.push("GET /api/projects");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ projects: [{ id: "p1", name: "solo" }] }));
        } else if (req.method === "POST" && url === "/api/runs") {
          hits.push("POST /api/runs");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: runId }));
        } else if (req.method === "GET" && url === "/api/fleet/stream" && (req.headers.accept ?? "").includes("text/event-stream")) {
          hits.push("SSE /api/fleet/stream");
          streamRes = res;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ runId, type: "health", ts: Date.now() / 1000, payload: { verdict: "x", lifecycle } })}\n\n`);
          // no res.end() — hold the stream open (see block comment).
        } else {
          hits.push(`${req.method} ${url}`);
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "unexpected route/method" }));
        }
      });
      const cleanup = () => {
        try {
          streamRes?.end();
        } catch {
          /* socket already torn down by the child */
        }
        srv.close();
      };
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as AddressInfo).port;
        const child = spawn(process.execPath, [GANTRY_BIN, "run", "a brief", "--url", `http://127.0.0.1:${port}`], { stdio: "ignore" });
        child.on("error", (e) => {
          cleanup();
          reject(e);
        });
        child.on("exit", (code) => {
          cleanup();
          resolve({ code: code ?? -1, hits });
        });
      });
    });
  }

  it("exits 0 when the run's terminal lifecycle is 'done'", async () => {
    const { code, hits } = await runFollow("done");
    expect(code).toBe(0);
    expect(hits).toContain("GET /api/projects");
    expect(hits).toContain("POST /api/runs");
    expect(hits).toContain("SSE /api/fleet/stream");
  });

  it("exits 1 when the run's terminal lifecycle is 'failed'", async () => {
    const { code, hits } = await runFollow("failed");
    expect(code).toBe(1);
    expect(hits).toContain("GET /api/projects");
    expect(hits).toContain("POST /api/runs");
    expect(hits).toContain("SSE /api/fleet/stream");
  });
});

// ponytail: cmdUp and findClaude's PATH-scan branch are not unit-tested here — cmdUp resolves the
// repo root from process.argv[1] (explicitly out of scope per the spec's hard constraint) and
// spawns `next start`. cmdRun is now covered end-to-end via the subprocess exit-code tests above
// (done→0 / failed→1) plus resolveProject/followRun in-process; only its `npx next start` spawn in
// cmdUp remains undriven. Add a subprocess-level fixture-mode smoke test if cmdUp needs coverage.
