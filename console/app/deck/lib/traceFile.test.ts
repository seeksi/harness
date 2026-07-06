import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { isValidSessionId, listSessions, readTraceFile, parseTraceLines } from "./traceFile";

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

  it("rejects a symlink escape even with a whitelisted id", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deck-outside-"));
    fs.writeFileSync(path.join(outside, "secret.jsonl"), '{"ts":1,"tool":"Read","sig":"leak"}\n');
    const dir = path.join(root, ".claude", "traces");
    const linkPath = path.join(dir, "escape.jsonl");
    try {
      fs.symlinkSync(path.join(outside, "secret.jsonl"), linkPath);
    } catch {
      // symlink creation can be unsupported/unprivileged in some sandboxes — skip
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    expect(() => readTraceFile(root, "escape")).toThrow(/outside the traces directory/);
    fs.rmSync(linkPath, { force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
