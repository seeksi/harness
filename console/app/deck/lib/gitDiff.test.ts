import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isValidCommittish, isValidRepoRoot, gitShow } from "./gitDiff";

describe("isValidCommittish — flag-injection gate", () => {
  it("accepts a full sha, a short sha, and a plain ref/branch name", () => {
    expect(isValidCommittish("a".repeat(40))).toBe(true);
    expect(isValidCommittish("abc1234")).toBe(true);
    expect(isValidCommittish("HEAD")).toBe(true);
    expect(isValidCommittish("feature/my-branch")).toBe(true);
  });

  it("rejects anything shaped like a git flag", () => {
    expect(isValidCommittish("--upload-pack=/bin/sh")).toBe(false);
    expect(isValidCommittish("-x")).toBe(false);
  });

  it("rejects range syntax and whitespace/shell metacharacters", () => {
    expect(isValidCommittish("HEAD..main")).toBe(false);
    expect(isValidCommittish("HEAD; rm -rf /")).toBe(false);
    expect(isValidCommittish("HEAD `whoami`")).toBe(false);
    expect(isValidCommittish("a b")).toBe(false);
  });

  it("rejects an over-length string", () => {
    expect(isValidCommittish("a".repeat(101))).toBe(false);
  });
});

describe("isValidRepoRoot / gitShow — filesystem + process trust boundary", () => {
  let repo: string;
  let outside: string;
  let sha: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "deck-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), "hello\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();

    outside = fs.mkdtempSync(path.join(os.tmpdir(), "deck-notrepo-"));
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a repo that is in the allowed (discovered) list and has a .git dir", () => {
    expect(isValidRepoRoot(repo, [repo])).toBe(true);
  });

  it("rejects a repo not in the allowed list", () => {
    expect(isValidRepoRoot(repo, ["/some/other/path"])).toBe(false);
  });

  it("rejects a dir with no .git even if it's in the allowed list", () => {
    expect(isValidRepoRoot(outside, [outside])).toBe(false);
  });

  it("runs git show for a valid repo + commit-ish and returns the patch text", async () => {
    const out = await gitShow(repo, sha);
    expect(out).toContain("hello");
    expect(out).toContain("f.txt");
  });

  it("rejects an invalid commit-ish before spawning git", async () => {
    await expect(gitShow(repo, "--upload-pack=x")).rejects.toThrow(/invalid commit-ish/);
  });

  it("propagates git's own error for a nonexistent commit-ish", async () => {
    await expect(gitShow(repo, "deadbeef00deadbeef00deadbeef00deadbeef0")).rejects.toThrow();
  });
});
