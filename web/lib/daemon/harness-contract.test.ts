// web/lib/daemon/harness-contract.test.ts
// Contract test: harness.sh's stdout event stream must be consumable by
// parseHarnessLine — on BOTH success and failure paths. Runs the real script
// against throwaway git repos and asserts every emitted stdout line parses into a
// valid SSEEvent (schema-valid, not just JSON), and that gate failures still
// propagate a non-zero exit. This is the seam that lets the daemon wire to live
// execution.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
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
function harness(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("sh", [HARNESS, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HARNESS_BASE: "main", ...extraEnv },
  });
}
/** Env that hides any ambient git identity (global/system config + author vars). */
const NO_GIT_IDENTITY: Record<string, string> = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "",
  GIT_AUTHOR_EMAIL: "",
  GIT_COMMITTER_NAME: "",
  GIT_COMMITTER_EMAIL: "",
};
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
function harnessFails(cwd: string, args: string[], extraEnv: Record<string, string> = {}): { stdout: string; status?: number } {
  try {
    harness(cwd, args, extraEnv);
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

  it("wt-commit: an EDITED-but-uncommitted lane is committed, then wt-verify clears Gate B", () => {
    const repo = newRepo();
    harness(repo, ["wt-new", "edited"]); // creates feat/edited worktree off main
    const wt = wtPath(repo, "edited");
    writeFileSync(path.join(wt, "x.txt"), "agent edited this\n"); // agent edits, never commits

    const commitOut = harness(repo, ["wt-commit", "edited"]); // harness commits the edits
    assertAllValidEvents(commitOut);

    const stdout = harness(repo, ["wt-verify", "edited"]); // now committed + clean → clear
    assertAllValidEvents(stdout);
    const events = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events).toContainEqual(expect.objectContaining({ type: "gate", id: "B", status: "clear" }));
  });

  it("wt-commit: a true no-op lane makes NO commit, so wt-verify still raises Gate B", () => {
    const repo = newRepo();
    harness(repo, ["wt-new", "nothing"]); // worktree created, agent edits nothing

    const commitOut = harness(repo, ["wt-commit", "nothing"]); // dirty check → no commit
    assertAllValidEvents(commitOut);

    const { stdout, status } = harnessFails(repo, ["wt-verify", "nothing"]);
    expect(status, "non-zero exit on genuine no-op").toBeGreaterThan(0);
    const events = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "gate", id: "B", status: "raised", severity: "high" })
    );
  });

  it("wt-commit: commits even with NO git identity configured (pinned author/no hooks)", () => {
    // Proves fix #3: on a bare prod host the `deploy` user may have no user.name/email.
    // With global+system config nulled and author env vars unset, a plain `git commit`
    // would fail ("Please tell me who you are"); wt-commit must still succeed via its
    // pinned -c user.name/-c user.email and --no-verify.
    const repo = newRepo();
    harness(repo, ["wt-new", "noid"]);
    const wt = wtPath(repo, "noid");
    writeFileSync(path.join(wt, "x.txt"), "agent edited this\n");

    const out = harness(repo, ["wt-commit", "noid"], NO_GIT_IDENTITY);
    assertAllValidEvents(out);
    // The commit landed and is authored by the pinned harness identity.
    const log = execFileSync("git", ["log", "-1", "--pretty=%an <%ae> %s"], {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env, ...NO_GIT_IDENTITY },
    }).trim();
    expect(log).toBe("umbrella-harness <harness@umbrella.local> lane noid: agent build");
  });

  it("wt-commit: a detached / wrong-branch worktree HEAD is REJECTED and commits nothing", () => {
    // Proves the worktree/branch guards (#1 registration match + #2 symbolic-ref): a
    // detached HEAD no longer matches refs/heads/feat/<slug>, so wt-commit dies before
    // staging — it must never commit onto the wrong ref.
    const repo = newRepo();
    harness(repo, ["wt-new", "detach"]);
    const wt = wtPath(repo, "detach");
    writeFileSync(path.join(wt, "x.txt"), "agent edited this\n");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();
    git(wt, ["checkout", "-q", "--detach", head]); // detach HEAD off feat/detach

    const { status } = harnessFails(repo, ["wt-commit", "detach"]);
    expect(status, "non-zero exit on detached HEAD").toBeGreaterThan(0);
    // No commit was created on feat/detach beyond base.
    const ahead = execFileSync("git", ["rev-list", "--count", "main..feat/detach"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(ahead).toBe("0");
  });

  it("wt-commit: a .claude/traces file is NOT staged/committed (secret-leak guard)", () => {
    // Proves fix #4: even if the agent un-ignores .claude/traces, wt-commit restores
    // the canonical .gitignore and excludes the trace dir from staging.
    const repo = newRepo();
    harness(repo, ["wt-new", "trace"]);
    const wt = wtPath(repo, "trace");
    writeFileSync(path.join(wt, "x.txt"), "real work\n");
    // Agent edits .gitignore to un-ignore traces, then a trace with sensitive content.
    writeFileSync(path.join(wt, ".gitignore"), "# nothing ignored now\n");
    mkdirSync(path.join(wt, ".claude/traces"), { recursive: true });
    writeFileSync(path.join(wt, ".claude/traces/sess.jsonl"), '{"secret":"leak me"}\n');

    const out = harness(repo, ["wt-commit", "trace"]);
    assertAllValidEvents(out);
    // The trace path must not appear in the committed tree of feat/trace.
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "feat/trace"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(tree).toContain("x.txt");
    expect(tree).not.toContain(".claude/traces/sess.jsonl");
  });

  it("wt-commit: restored canonical .gitignore + excluded trace ⇒ wt-verify CLEARS", () => {
    // Proves the restore path end-to-end: repo HAS a committed .gitignore that ignores
    // .claude/traces/. The agent overwrites that .gitignore to un-ignore traces AND drops
    // a trace file. wt-commit must restore the canonical .gitignore, exclude the trace
    // from staging, and commit only the real edit — leaving a CLEAN tree so Gate B clears.
    const repo = newRepo();
    writeFileSync(path.join(repo, ".gitignore"), ".claude/traces/\n");
    git(repo, ["add", ".gitignore"]);
    git(repo, ["commit", "-q", "-m", "add gitignore"]);

    harness(repo, ["wt-new", "ignr"]);
    const wt = wtPath(repo, "ignr");
    writeFileSync(path.join(wt, "x.txt"), "real work\n");
    writeFileSync(path.join(wt, ".gitignore"), "# agent un-ignored everything\n"); // tracked edit
    mkdirSync(path.join(wt, ".claude/traces"), { recursive: true });
    writeFileSync(path.join(wt, ".claude/traces/sess.jsonl"), '{"secret":"leak me"}\n');

    const commitOut = harness(repo, ["wt-commit", "ignr"]);
    assertAllValidEvents(commitOut);

    // Gate B must CLEAR: canonical .gitignore restored ⇒ the trace is ignored ⇒ no
    // untracked leftovers ⇒ clean tree. The committed tree has x.txt + the original
    // .gitignore, NOT the trace.
    const verifyOut = harness(repo, ["wt-verify", "ignr"]);
    assertAllValidEvents(verifyOut);
    const events = verifyOut.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(events).toContainEqual(expect.objectContaining({ type: "gate", id: "B", status: "clear" }));
    const tree = execFileSync("git", ["ls-tree", "-r", "--name-only", "feat/ignr"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(tree).toContain("x.txt");
    expect(tree).not.toContain(".claude/traces/sess.jsonl");
    // The canonical .gitignore (not the agent's overwrite) is what got committed.
    const committedIgnore = execFileSync("git", ["show", "feat/ignr:.gitignore"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(committedIgnore).toBe(".claude/traces/\n");
  });

  it("reset-base: returns a repo stranded on integration back to the base branch", () => {
    const repo = newRepo();
    harness(repo, ["integ-start"]); // moves HEAD to integration (off main)
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    ).toBe("integration");

    harness(repo, ["reset-base"]); // human/git output → stderr; stdout may be empty (no events)
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    ).toBe("main");
  });

  it("reset-base: a no-op on an already-base repo exits 0 cleanly", () => {
    const repo = newRepo(); // fresh repo is already on main
    // Must not throw (exit 0) and must leave HEAD on main.
    expect(() => harness(repo, ["reset-base"])).not.toThrow();
    expect(
      execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
    ).toBe("main");
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
