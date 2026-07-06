import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { isValidCommittish, isValidRepoRoot, resolveProjectPath, gitShow } from "./gitDiff";

const symlinkSupported = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "deck-gitdiff-symlink-probe-"));
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

  it("rejects a leading-slash, absolute-path-shaped committish", () => {
    expect(isValidCommittish("/etc/passwd")).toBe(false);
    expect(isValidCommittish("/HEAD")).toBe(false);
  });

  it("rejects a `HEAD:path` pathspec form", () => {
    expect(isValidCommittish("HEAD:path/to/file")).toBe(false);
    expect(isValidCommittish("HEAD:/etc/passwd")).toBe(false);
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

  it.skipIf(!symlinkSupported)(
    "accepts a symlink pointing INTO the allowlist via realpath equality [skipped: sandbox disallows symlink creation]",
    () => {
      const link = path.join(os.tmpdir(), `deck-repo-link-${process.pid}`);
      fs.symlinkSync(repo, link);
      try {
        expect(isValidRepoRoot(link, [repo])).toBe(true);
      } finally {
        fs.rmSync(link, { force: true });
      }
    }
  );

  it.skipIf(!symlinkSupported)(
    "rejects a symlink pointing OUTSIDE the allowlist even though the link's own path isn't allowed either [skipped: sandbox disallows symlink creation]",
    () => {
      const link = path.join(os.tmpdir(), `deck-repo-link-outside-${process.pid}`);
      fs.symlinkSync(outside, link);
      try {
        expect(isValidRepoRoot(link, [repo])).toBe(false);
      } finally {
        fs.rmSync(link, { force: true });
      }
    }
  );

  it("rejects a plain off-allowlist path with no relation to any allowed entry", () => {
    expect(isValidRepoRoot("/some/other/path", [repo])).toBe(false);
  });

  it("runs git show for a valid repo + commit-ish and returns the patch text", async () => {
    const out = await gitShow(repo, sha, [repo]);
    expect(out).toContain("hello");
    expect(out).toContain("f.txt");
  });

  it("rejects an invalid commit-ish before spawning git", async () => {
    await expect(gitShow(repo, "--upload-pack=x", [repo])).rejects.toThrow(/invalid commit-ish/);
  });

  it("rejects a repo root not in `allowed`, self-contained — even without any upstream gate", async () => {
    await expect(gitShow(repo, sha, ["/some/other/path"])).rejects.toThrow(/not an allowed discovered project/);
  });

  it("propagates git's own error for a nonexistent commit-ish", async () => {
    await expect(gitShow(repo, "deadbeef00deadbeef00deadbeef00deadbeef0", [repo])).rejects.toThrow();
  });

  describe("resolveProjectPath — opaque client id resolved server-side against discovery", () => {
    it("resolves a known id to its own discovered path (never the client's raw input)", () => {
      const discovered = [{ id: "opaque-1", path: repo }];
      expect(resolveProjectPath("opaque-1", discovered)).toBe(repo);
    });

    it("returns null for an unknown id", () => {
      const discovered = [{ id: "opaque-1", path: repo }];
      expect(resolveProjectPath("not-a-real-id", discovered)).toBeNull();
    });

    it("returns null when the id matches but the discovered path fails isValidRepoRoot (e.g. no .git)", () => {
      const discovered = [{ id: "opaque-1", path: outside }];
      expect(resolveProjectPath("opaque-1", discovered)).toBeNull();
    });

    it("never treats the id itself as a filesystem path — a client sending a path as `id` does not resolve", () => {
      const discovered = [{ id: "opaque-1", path: repo }];
      // Even though `repo` is a valid, allowed path, sending it directly as the id
      // (instead of the opaque "opaque-1") must not resolve — the id is a lookup key,
      // not an alternate spelling of the path.
      expect(resolveProjectPath(repo, discovered)).toBeNull();
    });
  });
});
