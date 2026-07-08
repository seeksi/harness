import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildAgentPrompt,
  buildLanePrompt,
  maxHandoffs,
  defaultHandoffFs,
  CONTEXT_GUARD_PROMPT,
  HANDOFF_INLINE_CAP,
} from "./handoff";
import { mintLane, _resetRegistry } from "@/lib/bridge/registry";

const OLD = process.env.CONTEXT_MAX_HANDOFFS;
afterEach(() => {
  if (OLD === undefined) delete process.env.CONTEXT_MAX_HANDOFFS;
  else process.env.CONTEXT_MAX_HANDOFFS = OLD;
});

describe("buildAgentPrompt", () => {
  it("embeds the brief, mandates the full toolset, and forbids git commit", () => {
    const p = buildAgentPrompt("add a /health route");
    expect(p).toContain("add a /health route");
    expect(p).toContain("FULL toolset");
    expect(p).toMatch(/DO NOT run `git commit`/);
  });

  it("length-caps an oversized brief (never exceeds agent-runner's MAX_PROMPT)", () => {
    const p = buildAgentPrompt("x".repeat(200_000));
    expect(p.length).toBeLessThan(100_000);
  });
});

describe("buildLanePrompt — composes over buildAgentPrompt + guard", () => {
  it("first attempt (no handoff): base prompt + context-guard, no handoff section", () => {
    const p = buildLanePrompt("do the thing");
    expect(p).toContain("do the thing"); // the base build prompt
    expect(p).toContain(CONTEXT_GUARD_PROMPT.trim().slice(0, 30)); // guard appended
    expect(p).not.toContain("Handoff from the previous agent");
  });

  it("respawn (with handoff): inlines the previous handoff between the base and the guard", () => {
    const p = buildLanePrompt("task text", "prior progress notes");
    expect(p).toContain("task text");
    expect(p).toContain("## Handoff from the previous agent (continue from here)");
    expect(p).toContain("prior progress notes");
    expect(p).toContain(CONTEXT_GUARD_PROMPT.trim().slice(0, 30));
    // Order: base task → handoff → guard.
    expect(p.indexOf("task text")).toBeLessThan(p.indexOf("prior progress notes"));
    expect(p.indexOf("prior progress notes")).toBeLessThan(p.indexOf("Context budget"));
  });

  it("head-truncates an oversized handoff at HANDOFF_INLINE_CAP (small brief: full cap available)", () => {
    const huge = "H".repeat(HANDOFF_INLINE_CAP + 5_000);
    const p = buildLanePrompt("t", huge);
    // Only the first HANDOFF_INLINE_CAP handoff chars survive (head-preserving).
    const hs = "H".repeat(HANDOFF_INLINE_CAP);
    expect(p).toContain(hs);
    expect(p).not.toContain(hs + "H"); // not one char more than the cap
  });

  it("combined budget: maximal brief + maximal handoff still composes under MAX_PROMPT (100k)", () => {
    // MAX_BRIEF (90k) + HANDOFF_INLINE_CAP (20k) + wrapper text naively exceeds agent-runner's
    // MAX_PROMPT — the composer must shrink the inlined handoff to the remaining budget so a
    // legitimate respawn never becomes an AgentExecError lane failure.
    const p = buildLanePrompt("x".repeat(200_000), "H".repeat(200_000));
    expect(p.length).toBeLessThan(100_000);
    // Truncation hit the HANDOFF, never the guard: the guard's tail must survive intact.
    expect(p).toContain("rushed, broken finish.");
    expect(p).toContain("## Handoff from the previous agent (continue from here)");
    expect(p).toContain("HHHH"); // some handoff head still inlined
  });
});

describe("maxHandoffs — CONTEXT_MAX_HANDOFFS clamp parsing", () => {
  it("unset ⇒ default 2", () => {
    delete process.env.CONTEXT_MAX_HANDOFFS;
    expect(maxHandoffs()).toBe(2);
  });
  it("junk ⇒ default 2", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "not-a-number";
    expect(maxHandoffs()).toBe(2);
  });
  it("empty string ⇒ default 2 (Number('') is 0 — must NOT silently disable respawn)", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "";
    expect(maxHandoffs()).toBe(2);
  });
  it("whitespace-only ⇒ default 2", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "   ";
    expect(maxHandoffs()).toBe(2);
  });
  it("padded numeric ' 3 ' ⇒ trimmed and parsed to 3", () => {
    process.env.CONTEXT_MAX_HANDOFFS = " 3 ";
    expect(maxHandoffs()).toBe(3);
  });
  it("7 ⇒ clamped high to 5", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "7";
    expect(maxHandoffs()).toBe(5);
  });
  it("-1 ⇒ clamped low to 0 (respawn disabled)", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "-1";
    expect(maxHandoffs()).toBe(0);
  });
  it("0 ⇒ 0 (explicitly disables respawn)", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "0";
    expect(maxHandoffs()).toBe(0);
  });
  it("3 ⇒ 3 (in-range passthrough)", () => {
    process.env.CONTEXT_MAX_HANDOFFS = "3";
    expect(maxHandoffs()).toBe(3);
  });
});

describe("defaultHandoffFs — lane-provenance gate + fail-safe", () => {
  afterEach(() => _resetRegistry());

  it("rejects unminted slugs on read()/archive()/sweep() before any path join", () => {
    _resetRegistry();
    expect(() => defaultHandoffFs.read("lane-unminted")).toThrow(/unminted/);
    expect(() => defaultHandoffFs.archive("lane-unminted", 0)).toThrow(/unminted/);
    expect(() => defaultHandoffFs.sweep("lane-unminted", 0)).toThrow(/unminted/);
  });

  it("minted slug with no worktree: read() fails safe (git error ⇒ null, no respawn)", () => {
    // worktreePathFor points at a non-existent ../<repo>.worktrees/<slug>; `git -C` throws,
    // and read() must swallow it and report no handoff (fail safe: never a spurious respawn).
    mintLane("lane-nonexistent-slug-xyz");
    expect(defaultHandoffFs.read("lane-nonexistent-slug-xyz")).toBeNull();
  });
});

describe("defaultHandoffFs — real git worktree (index restore, neutralize, symlink, size cap)", () => {
  // REPO_ROOT / WORKTREES_DIR are module-load constants from HARNESS_REPO, so drive the
  // whole boundary off a throwaway temp repo + worktree and re-import the module against
  // it (same pattern as agent-runner.test.ts's relocateTrace destination suite). The repo
  // TRACKS HANDOFF.md at HEAD (this repo's production shape).
  let tmp: string;
  let repo: string;
  let wt: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  const porcelain = () => git(wt, "status", "--porcelain", "--", "HANDOFF.md").trim();
  const wtHandoff = () => path.join(wt, "HANDOFF.md");
  const archived = (label: string) => path.join(repo, "data", "handoffs", `lane-x.HANDOFF.${label}.md`);

  async function setup() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"));
    repo = path.join(tmp, "repo");
    wt = path.join(tmp, "repo.worktrees", "lane-x");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "HANDOFF.md"), "BASELINE\n");
    git(repo, "add", "-A");
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
    git(repo, "worktree", "add", "-q", wt);
    vi.stubEnv("HARNESS_REPO", repo);
    vi.resetModules();
    const mod = await import("./handoff");
    const reg = await import("@/lib/bridge/registry");
    reg.mintLane("lane-x");
    return mod;
  }

  it("tracked-and-unchanged: read() is null and nothing is touched", async () => {
    const mod = await setup();
    expect(mod.defaultHandoffFs.read("lane-x")).toBeNull();
    expect(porcelain()).toBe("");
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
  });

  it("STAGED agent handoff: read() returns it; archive() restores HEAD in BOTH index and worktree", async () => {
    const mod = await setup();
    fs.writeFileSync(wtHandoff(), "AGENT-NOTES\n");
    git(wt, "add", "HANDOFF.md"); // the index-restore hole: agent staged its handoff
    expect(mod.defaultHandoffFs.read("lane-x")).toBe("AGENT-NOTES\n");
    mod.defaultHandoffFs.archive("lane-x", 0);
    expect(porcelain()).toBe(""); // index AND worktree back at HEAD — nothing for wt-commit
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
    expect(fs.readFileSync(archived("0"), "utf8")).toBe("AGENT-NOTES\n");
  });

  it("DELETED HANDOFF.md (staged deletion): read() neutralizes — baseline restored, null returned", async () => {
    const mod = await setup();
    git(wt, "rm", "-q", "HANDOFF.md"); // agent-controlled staged deletion
    expect(porcelain()).not.toBe("");
    expect(mod.defaultHandoffFs.read("lane-x")).toBeNull();
    expect(porcelain()).toBe(""); // wt-commit can no longer commit the deletion
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
  });

  it("SYMLINK HANDOFF.md: refused unread (target never returned), unlinked, baseline restored", async () => {
    const mod = await setup();
    const secret = path.join(tmp, "secret.txt");
    fs.writeFileSync(secret, "TOP-SECRET\n");
    fs.rmSync(wtHandoff());
    fs.symlinkSync(secret, wtHandoff());
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(mod.defaultHandoffFs.read("lane-x")).toBeNull(); // never the symlink target's content
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("lane-x"); // lane named in the daemon-side log...
    expect(logged).not.toContain("TOP-SECRET"); // ...but never file content
    expect(fs.lstatSync(wtHandoff()).isSymbolicLink()).toBe(false); // link removed, not archived
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
    expect(porcelain()).toBe("");
    expect(fs.existsSync(secret)).toBe(true); // target untouched
  });

  it("SIZE CAP: a >1 MiB handoff is read head-only — exactly HANDOFF_INLINE_CAP bytes", async () => {
    const mod = await setup();
    fs.writeFileSync(wtHandoff(), "A".repeat(1024 * 1024 + 100));
    const got = mod.defaultHandoffFs.read("lane-x");
    expect(got).toBe("A".repeat(mod.HANDOFF_INLINE_CAP)); // head-preserving, never the whole file
  });

  it("STAGED RENAME (git mv HANDOFF.md OTHER.md): sweep neutralizes the rename TARGET too", async () => {
    // Under a pathspec the rename splits into `D HANDOFF.md` + an invisible `A OTHER.md`
    // (pathspec disables rename pairing) — restoring HANDOFF.md alone would leave the
    // handoff content staged as OTHER.md for wt-commit. The FULL porcelain pairs them as
    // one R entry; the target must be archived out and dropped from the index.
    const mod = await setup();
    git(wt, "mv", "HANDOFF.md", "OTHER.md"); // identical content ⇒ similarity fires ⇒ R entry
    mod.defaultHandoffFs.sweep("lane-x", 0);
    expect(git(wt, "status", "--porcelain").trim()).toBe(""); // FULL status clean, no pathspec
    expect(fs.existsSync(path.join(wt, "OTHER.md"))).toBe(false); // target gone from worktree
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
    const archiveDir = path.join(repo, "data", "handoffs");
    const renamed = fs.readdirSync(archiveDir).filter((f) => /\.renamed-0\.md$/.test(f));
    expect(renamed).toHaveLength(1); // handoff content archived, never committable
    expect(fs.readFileSync(path.join(archiveDir, renamed[0]), "utf8")).toBe("BASELINE\n");
  });

  it("WILDCARD rename target (`git mv HANDOFF.md '*'`): neutralized literally, lane work untouched", async () => {
    // The target name is agent-chosen; passed as a raw git pathspec, `*` would match every
    // path and `git restore --source=HEAD` would silently revert the lane's entire build
    // output. The :(literal) pathspec must confine the restore to the one target.
    const mod = await setup();
    fs.writeFileSync(path.join(wt, "work.txt"), "OLD\n");
    git(wt, "add", "work.txt");
    execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "work"]);
    fs.writeFileSync(path.join(wt, "work.txt"), "NEW\n"); // the lane's uncommitted build output
    git(wt, "mv", "HANDOFF.md", "*");
    mod.defaultHandoffFs.sweep("lane-x", 0);
    expect(fs.readFileSync(path.join(wt, "work.txt"), "utf8")).toBe("NEW\n"); // lane work survives
    expect(git(wt, "status", "--porcelain").trim()).toBe("M work.txt"); // ONLY the lane work dirty
    expect(fs.existsSync(path.join(wt, "*"))).toBe(false);
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
  });

  it("SYMLINK-ANCESTOR rename target (crafted index entry): throws sanitized, outside file untouched", async () => {
    // `git mv` refuses paths beyond a symlink, but a Bash-capable agent can craft the R
    // pairing directly via `update-index --cacheinfo`. lstat/rename/rm follow INTERMEDIATE
    // symlinks, so without the real-parent guard neutralization would archive/delete a file
    // OUTSIDE the worktree. Must fail closed with a sanitized error (no agent-chosen path).
    const mod = await setup();
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "evil.md"), "BASELINE\n"); // similar ⇒ R pairing fires
    git(wt, "rm", "-q", "HANDOFF.md"); // staged D half of the pair
    fs.symlinkSync(outside, path.join(wt, "link"));
    const blob = git(wt, "hash-object", "-w", path.join(outside, "evil.md")).trim();
    git(wt, "update-index", "--add", "--cacheinfo", `100644,${blob},link/evil.md`);
    let err: Error | null = null;
    try {
      mod.defaultHandoffFs.sweep("lane-x", 0);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull(); // fail closed — the lane must die
    expect(err!.message).toMatch(/symlink ancestor escaping the worktree/);
    expect(err!.message).not.toContain("evil"); // agent-chosen name never in the error
    expect(fs.readFileSync(path.join(outside, "evil.md"), "utf8")).toBe("BASELINE\n"); // untouched
    expect(fs.existsSync(path.join(outside, "evil.md"))).toBe(true); // not archived away
  });

  it("EMPTY handoff (truncated to \"\"): read() is null AND the file is neutralized (porcelain clean)", async () => {
    // A bare-return "" would (a) leave the truncated file dirty for wt-commit (sweep's
    // read()!==null guard skips archive) and (b) let "" trigger a wasted respawn.
    const mod = await setup();
    fs.writeFileSync(wtHandoff(), "");
    expect(porcelain()).not.toBe("");
    expect(mod.defaultHandoffFs.read("lane-x")).toBeNull();
    expect(porcelain()).toBe("");
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
  });

  it("SWEEP on a leftover staged handoff: archived out with the attempt label + index clean", async () => {
    const mod = await setup();
    fs.writeFileSync(wtHandoff(), "LEFTOVER\n");
    git(wt, "add", "HANDOFF.md");
    mod.defaultHandoffFs.sweep("lane-x", 3);
    expect(porcelain()).toBe("");
    expect(fs.readFileSync(wtHandoff(), "utf8")).toBe("BASELINE\n");
    expect(fs.readFileSync(archived("3"), "utf8")).toBe("LEFTOVER\n");
  });
});
