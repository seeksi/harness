// web/lib/daemon/harness-contract.test.ts
// Contract test: harness.sh's stdout event stream must be consumable by
// parseHarnessLine — on BOTH success and failure paths. Runs the real script
// against throwaway git repos and asserts every emitted stdout line parses into a
// valid SSEEvent (schema-valid, not just JSON), and that gate failures still
// propagate a non-zero exit. This is the seam that lets the daemon wire to live
// execution.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { parseHarnessLine } from "./harness-bridge";

const HARNESS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.claude/skills/harness/harness.sh"
);

const repos: string[] = [];
function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
}
function harness(cwd: string, args: string[]): string {
  return execFileSync("sh", [HARNESS, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HARNESS_BASE: "main" },
  });
}
function newRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "harness-contract-"));
  repos.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}
/** Every non-blank stdout line must parse to a valid SSEEvent. */
function assertAllValidEvents(stdout: string): string[] {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    expect(parseHarnessLine(line), `parseHarnessLine rejected: ${line}`).not.toBeNull();
  }
  return lines.map((l) => JSON.parse(l).type as string);
}

afterAll(() => {
  for (const r of repos) {
    rmSync(r, { recursive: true, force: true });
    rmSync(`${r}.worktrees`, { recursive: true, force: true }); // wt.sh sibling dir
  }
});

/** Worktree path wt.sh/harness.sh derive for a slug: ../<repo>.worktrees/<slug>. */
function wtPath(repo: string, slug: string): string {
  return path.join(`${repo}.worktrees`, slug);
}
/** Run harness expecting a non-zero exit; return its stdout + status. */
function harnessFails(cwd: string, args: string[]): { stdout: string; status?: number } {
  try {
    harness(cwd, args);
    throw new Error(`expected harness ${args.join(" ")} to exit non-zero`);
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status };
  }
}

describe("harness.sh → parseHarnessLine contract", () => {
  it("exists at the resolved path", () => {
    expect(existsSync(HARNESS), HARNESS).toBe(true);
  });

  it("success path: every stdout line is a valid event (integ-start + integ-merge)", () => {
    const repo = newRepo();
    git(repo, ["branch", "feat/scene"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "base"]);

    const types = assertAllValidEvents(
      harness(repo, ["integ-start"]) + harness(repo, ["integ-merge", "scene"])
    );
    expect(types).toContain("phase");
    expect(types).toContain("subtask");
    expect(types).toContain("gate");
  });

  it("failure path: a merge conflict emits a valid raised gate + blocked, and exits non-zero", () => {
    const repo = newRepo();
    writeFileSync(path.join(repo, "f.txt"), "A\n");
    git(repo, ["add", "f.txt"]);
    git(repo, ["commit", "-q", "-m", "add f"]);
    git(repo, ["checkout", "-q", "-b", "feat/conflict"]);
    writeFileSync(path.join(repo, "f.txt"), "FROM_FEAT\n");
    git(repo, ["commit", "-q", "-am", "feat change"]);
    git(repo, ["checkout", "-q", "main"]);
    writeFileSync(path.join(repo, "f.txt"), "FROM_MAIN\n");
    git(repo, ["commit", "-q", "-am", "main change"]);

    harness(repo, ["integ-start"]); // now on integration (off main)

    let stdout = "";
    let status: number | undefined;
    try {
      harness(repo, ["integ-merge", "conflict"]);
      throw new Error("expected integ-merge to exit non-zero on conflict");
    } catch (e) {
      const err = e as { stdout?: string; status?: number };
      stdout = err.stdout ?? "";
      status = err.status;
    }

    expect(status, "non-zero exit on conflict").toBeGreaterThan(0);
    const types = assertAllValidEvents(stdout);
    // The conflict raised Gate C and marked the subtask + phase blocked.
    const events = stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "gate", id: "C", status: "raised", severity: "high" })
    );
    expect(types).toContain("subtask");
    expect(types).toContain("phase");
  });

  it("wt-verify: a committed, clean lane emits a valid cleared Gate B and exits 0", () => {
    const repo = newRepo();
    harness(repo, ["wt-new", "built"]); // creates feat/built worktree off main
    const wt = wtPath(repo, "built");
    writeFileSync(path.join(wt, "x.txt"), "agent work\n");
    git(wt, ["add", "x.txt"]);
    git(wt, ["commit", "-q", "-m", "agent work"]);

    const stdout = harness(repo, ["wt-verify", "built"]);
    assertAllValidEvents(stdout); // every emitted line is a schema-valid event
    const events = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events).toContainEqual(expect.objectContaining({ type: "gate", id: "B", status: "clear" }));
  });

  it("wt-verify: a no-op lane (no commits beyond base) raises Gate B and exits non-zero", () => {
    const repo = newRepo();
    harness(repo, ["wt-new", "noop"]); // worktree created but the agent committed nothing

    const { stdout, status } = harnessFails(repo, ["wt-verify", "noop"]);
    expect(status, "non-zero exit").toBeGreaterThan(0);
    const events = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "gate", id: "B", status: "raised", severity: "high" })
    );
  });

  it("wt-verify: UNTRACKED (uncommitted) files raise Gate B even with prior commits", () => {
    const repo = newRepo();
    harness(repo, ["wt-new", "dirty"]);
    const wt = wtPath(repo, "dirty");
    writeFileSync(path.join(wt, "a.txt"), "committed\n");
    git(wt, ["add", "a.txt"]);
    git(wt, ["commit", "-q", "-m", "real work"]);
    writeFileSync(path.join(wt, "leftover.txt"), "never added\n"); // untracked, not committed

    const { stdout, status } = harnessFails(repo, ["wt-verify", "dirty"]);
    expect(status, "non-zero exit on untracked").toBeGreaterThan(0);
    const events = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "gate", id: "B", status: "raised", severity: "high" })
    );
  });
});
