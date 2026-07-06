import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isValidSessionId, listSessions, readTraceFile, parseTraceLines, MAX_TRACE_BYTES } from "./traceFile";

// Probed once, synchronously, at collection time (not inside a hook — it.skipIf reads
// this before beforeAll ever runs). Some sandboxes disallow symlink creation entirely;
// when that's the case we skip the symlink-dependent tests VISIBLY (named + skipped in
// the report) rather than have the test silently `return` a fake pass.
const symlinkSupported = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "deck-symlink-probe-"));
  try {
    const target = path.join(probe, "t");
    const link = path.join(probe, "l");
    fs.writeFileSync(target, "x");
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

describe("isValidSessionId — the whitelist gate", () => {
  it("accepts the shape trace-log.py mints (alnum/underscore/hyphen)", () => {
    expect(isValidSessionId("abc123")).toBe(true);
    expect(isValidSessionId("session_ABC-123")).toBe(true);
    expect(isValidSessionId("a".repeat(64))).toBe(true);
  });

  it("rejects path traversal and path separators outright", () => {
    expect(isValidSessionId("../../etc/passwd")).toBe(false);
    expect(isValidSessionId("..")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
    expect(isValidSessionId("a\\b")).toBe(false);
    expect(isValidSessionId("/etc/passwd")).toBe(false);
  });

  it("rejects dots, spaces, and other path-meaningful characters", () => {
    expect(isValidSessionId("a.jsonl")).toBe(false);
    expect(isValidSessionId("a b")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
  });

  it("rejects an over-length id", () => {
    expect(isValidSessionId("a".repeat(65))).toBe(false);
  });
});

describe("parseTraceLines — tolerant JSONL parsing", () => {
  it("parses well-formed lines", () => {
    const text = '{"ts":1.5,"tool":"Read","sig":"abcd1234"}\n{"ts":2,"tool":"Bash","sig":"ef012345"}\n';
    expect(parseTraceLines(text)).toEqual([
      { ts: 1.5, tool: "Read", sig: "abcd1234" },
      { ts: 2, tool: "Bash", sig: "ef012345" },
    ]);
  });

  it("skips blank lines and a malformed/partial trailing line without throwing", () => {
    const text = '{"ts":1,"tool":"Read","sig":"x"}\n\n{"ts":2,"tool":"Edit"'; // truncated mid-write
    expect(parseTraceLines(text)).toEqual([{ ts: 1, tool: "Read", sig: "x" }]);
  });

  it("skips a well-formed-JSON line that doesn't match the trace shape", () => {
    const text = '{"unrelated":true}\n{"ts":1,"tool":"Read","sig":"x"}\n';
    expect(parseTraceLines(text)).toEqual([{ ts: 1, tool: "Read", sig: "x" }]);
  });
});

describe("readTraceFile / listSessions — filesystem trust boundary", () => {
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-traces-"));
    const dir = path.join(root, ".claude", "traces");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sess-abc.jsonl"), '{"ts":1,"tool":"Read","sig":"aaaa1111"}\n');
    fs.writeFileSync(path.join(dir, "not-a-valid-name!!.jsonl"), '{"ts":1,"tool":"Read","sig":"bad"}\n');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("lists only filenames that pass the session whitelist", () => {
    const sessions = listSessions(root);
    expect(sessions).toContain("sess-abc");
    expect(sessions).not.toContain("not-a-valid-name!!");
  });

  it("returns [] for a repo with no traces dir, without throwing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "deck-empty-"));
    expect(listSessions(empty)).toEqual([]);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("reads a valid session's lines", () => {
    expect(readTraceFile(root, "sess-abc")).toEqual([{ ts: 1, tool: "Read", sig: "aaaa1111" }]);
  });

  it("returns [] for a well-formed but nonexistent session id (not an error)", () => {
    expect(readTraceFile(root, "no-such-session")).toEqual([]);
  });

  it("throws before touching the filesystem for a path-traversal-shaped id", () => {
    expect(() => readTraceFile(root, "../../../etc/passwd")).toThrow(/invalid session id/);
  });

  it("throws for a session id containing a path separator", () => {
    expect(() => readTraceFile(root, "a/b")).toThrow(/invalid session id/);
  });

  it.skipIf(!symlinkSupported)(
    "rejects a symlink escape even with a whitelisted id [skipped: sandbox disallows symlink creation]",
    () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deck-outside-"));
      fs.writeFileSync(path.join(outside, "secret.jsonl"), '{"ts":1,"tool":"Read","sig":"leak"}\n');
      const dir = path.join(root, ".claude", "traces");
      const linkPath = path.join(dir, "escape.jsonl");
      fs.symlinkSync(path.join(outside, "secret.jsonl"), linkPath);
      try {
        expect(() => readTraceFile(root, "escape")).toThrow(/outside the traces directory/);
      } finally {
        fs.rmSync(linkPath, { force: true });
        fs.rmSync(outside, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(!symlinkSupported)(
    "rejects a symlinked `.claude/traces` DIRECTORY resolving outside the repo, even though the file-under-dir check alone would pass [skipped: sandbox disallows symlink creation]",
    () => {
      // A second, independent repo root whose `.claude/traces` is a real directory
      // holding a real file — nothing here looks malicious in isolation.
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-outside-root-"));
      const outsideDir = path.join(outsideRoot, ".claude", "traces");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "sess-esc.jsonl"), '{"ts":1,"tool":"Read","sig":"leak"}\n');

      // A second victim repo root whose `.claude/traces` is REPLACED by a symlink
      // pointing at the outside root's traces dir. `realpath(file)` and
      // `realpath(dir)/<id>.jsonl` still agree (both resolve into outsideDir), so the
      // file-vs-dir equality check alone can't catch this — only ancestry-under-
      // repo-root containment can.
      const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-victim-root-"));
      fs.mkdirSync(path.join(victimRoot, ".claude"), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(victimRoot, ".claude", "traces"));

      try {
        expect(() => readTraceFile(victimRoot, "sess-esc")).toThrow(/traces directory resolves outside the repo root/);
      } finally {
        fs.rmSync(victimRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    }
  );

  it("refuses to parse a trace file over the size cap", () => {
    const dir = path.join(root, ".claude", "traces");
    const big = path.join(dir, "huge.jsonl");
    // Sparse file: correct reported size via statSync without allocating real content.
    fs.writeFileSync(big, "");
    fs.truncateSync(big, MAX_TRACE_BYTES + 1);
    try {
      expect(() => readTraceFile(root, "huge")).toThrow(/too large.*refusing to parse/);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });
});
