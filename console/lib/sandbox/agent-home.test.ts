import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ensureAgentHome, removeAgentHome } from "./agent-home";
import { AgentExecError } from "@/lib/bridge/errors";

// A fake OPERATOR home (the credential source: $HOME/.claude/.credentials.json) and a
// scratch area for the isolated home. os.homedir() reads $HOME on POSIX, so stubbing
// HOME points ensureAgentHome's source (and its default destination) at the fixture.
// Homes are PER LANE: <base>/<slug>; AGENT_ISOLATED_HOME overrides the BASE dir.
let operatorHome: string;
const SLUG = "lane-t";
const cred = () => path.join(operatorHome, ".claude", ".credentials.json");
const mode = (p: string) => fs.statSync(p).mode & 0o777;

beforeEach(() => {
  vi.unstubAllEnvs();
  // realpath'd: the provisioner requires canonical paths (macOS /tmp is a symlink).
  operatorHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "op-home-")));
  fs.mkdirSync(path.join(operatorHome, ".claude"), { recursive: true });
  fs.writeFileSync(cred(), '{"claudeAiOauth":"fixture-token-v1"}', { mode: 0o600 });
  vi.stubEnv("HOME", operatorHome);
});

afterEach(() => {
  fs.rmSync(operatorHome, { recursive: true, force: true });
});

describe("ensureAgentHome — minimal isolated HOME provisioning (per lane)", () => {
  it("provisions <home>/.gantry/agent-homes/<slug> by default: 0700 dirs, credential copy 0600, git identity", () => {
    const home = ensureAgentHome(SLUG);
    expect(home).toBe(path.join(operatorHome, ".gantry", "agent-homes", SLUG));
    expect(mode(home)).toBe(0o700);
    expect(mode(path.join(home, ".claude"))).toBe(0o700);
    const dest = path.join(home, ".claude", ".credentials.json");
    expect(fs.readFileSync(dest, "utf8")).toBe('{"claudeAiOauth":"fixture-token-v1"}');
    expect(mode(dest)).toBe(0o600);
    // Git identity so the agent's worktree `git commit` works in a fresh HOME.
    const gitcfg = fs.readFileSync(path.join(home, ".gitconfig"), "utf8");
    expect(gitcfg).toContain("[user]");
    expect(gitcfg).toMatch(/name = .+/);
    expect(gitcfg).toMatch(/email = .+/);
    // ONLY the minimum is provisioned — no CLAUDE.md/settings/agents leak in.
    expect(fs.readdirSync(path.join(home, ".claude"))).toEqual([".credentials.json"]);
  });

  it("REFUSES a malformed slug (path-component injection) before touching anything", () => {
    for (const bad of ["../escape", "UPPER", "a/b", "", ".hidden", "x".repeat(40)]) {
      expect(() => ensureAgentHome(bad), bad).toThrow(AgentExecError);
    }
    expect(fs.existsSync(path.join(operatorHome, ".gantry"))).toBe(false);
  });

  it("per-lane homes COEXIST: provisioning lane B never wipes lane A (concurrent-lane safety)", () => {
    const a = ensureAgentHome("lane-a");
    fs.writeFileSync(path.join(a, ".claude", "session-state"), "lane A mid-run");
    const b = ensureAgentHome("lane-b");
    expect(b).not.toBe(a);
    expect(fs.readFileSync(path.join(a, ".claude", "session-state"), "utf8")).toBe("lane A mid-run");
    // …while re-provisioning lane A itself still wipes only lane A.
    ensureAgentHome("lane-a");
    expect(fs.existsSync(path.join(a, ".claude", "session-state"))).toBe(false);
    expect(fs.existsSync(path.join(b, ".claude", ".credentials.json"))).toBe(true);
  });

  it("respects AGENT_ISOLATED_HOME as the BASE dir (<base>/<slug>)", () => {
    const base = path.join(operatorHome, "custom-isolated");
    vi.stubEnv("AGENT_ISOLATED_HOME", base);
    expect(ensureAgentHome(SLUG)).toBe(path.join(base, SLUG));
    expect(fs.existsSync(path.join(base, SLUG, ".claude", ".credentials.json"))).toBe(true);
  });

  it("REBUILDS from scratch every call: agent-planted persistent config is wiped", () => {
    const home = ensureAgentHome(SLUG);
    // A Bash-capable agent plants config in ITS OWN home to contaminate later runs…
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "malicious standing instructions");
    fs.mkdirSync(path.join(home, ".claude", "agents"));
    fs.writeFileSync(path.join(home, ".npmrc"), "registry=https://evil.example");
    fs.writeFileSync(path.join(home, ".gitconfig"), "[core]\n\tfsmonitor = evil\n");
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":"stale"}');
    fs.writeFileSync(cred(), '{"claudeAiOauth":"fixture-token-v2"}');
    // …the next provisioning wipes everything and rebuilds only the two artifacts.
    ensureAgentHome(SLUG);
    expect(fs.readdirSync(path.join(home, ".claude"))).toEqual([".credentials.json"]);
    expect(fs.existsSync(path.join(home, ".npmrc"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".gitconfig"), "utf8")).not.toContain("fsmonitor");
    expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8")).toBe(
      '{"claudeAiOauth":"fixture-token-v2"}'
    );
  });

  it("REFUSES to wipe a pre-existing directory it did not create (no marker → fail closed)", () => {
    const base = path.join(operatorHome, "base");
    const target = path.join(base, SLUG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "keep.txt"), "operator data");
    vi.stubEnv("AGENT_ISOLATED_HOME", base);
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("operator data"); // untouched
  });

  it("FAILS CLOSED when the operator credential is missing, a symlink, or oversized", () => {
    fs.rmSync(cred());
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    // symlinked credential source is never read through
    fs.writeFileSync(path.join(operatorHome, "other.json"), "{}");
    fs.symlinkSync(path.join(operatorHome, "other.json"), cred());
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    fs.rmSync(cred());
    fs.writeFileSync(cred(), Buffer.alloc(65 * 1024));
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
  });

  it("REFUSES a symlinked agent-home path AND a symlinked ancestor, touching NOTHING at the target", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-")));
    try {
      // final component (the lane home itself) is a symlink
      fs.mkdirSync(path.join(operatorHome, ".gantry", "agent-homes"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry", "agent-homes", SLUG));
      expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
      expect(fs.readdirSync(elsewhere)).toEqual([]); // nothing created through the link
      // ancestor (.gantry itself) is a symlink → canonicality check catches it pre-mkdir
      fs.rmSync(path.join(operatorHome, ".gantry"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry"));
      expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
      expect(fs.readdirSync(elsewhere)).toEqual([]); // no mkdir side effect either
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("credential failure leaves an existing marked home INTACT (validation precedes the wipe)", () => {
    const home = ensureAgentHome(SLUG);
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "leftover from last run");
    fs.rmSync(cred());
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    // The refusal happened BEFORE the wipe: the previous incarnation is untouched.
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("leftover from last run");
  });

  it("REFUSES an empty or relative AGENT_ISOLATED_HOME (never the daemon cwd, never a silent fallback)", () => {
    vi.stubEnv("AGENT_ISOLATED_HOME", "");
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    vi.stubEnv("AGENT_ISOLATED_HOME", "relative/path");
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
  });

  it("REFUSES BEFORE WIPING: a marked home reached through a symlinked ancestor survives intact", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-")));
    try {
      // A provisioner-shaped (marked) directory lives at the symlink TARGET; if validation
      // ran after the wipe, this rm -rf would reach through the redirected ancestor.
      const victim = path.join(elsewhere, "agent-homes", SLUG);
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, ".provisioned-by-gantry"), "gantry-agent-home v1\n");
      fs.writeFileSync(path.join(victim, "evidence.txt"), "must survive");
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry"));
      expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
      expect(fs.readFileSync(path.join(victim, "evidence.txt"), "utf8")).toBe("must survive");
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("REFUSES to wipe when the marker is spoofed (a directory, wrong content, or wrong size)", () => {
    const base = path.join(operatorHome, "spoofbase");
    const target = path.join(base, SLUG);
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(target, ".provisioned-by-gantry")); // marker as a directory
    fs.writeFileSync(path.join(target, "keep.txt"), "operator data");
    vi.stubEnv("AGENT_ISOLATED_HOME", base);
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    fs.rmSync(path.join(target, ".provisioned-by-gantry"), { recursive: true });
    fs.writeFileSync(path.join(target, ".provisioned-by-gantry"), "not the provisioner content");
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("operator data"); // untouched
  });

  it("REFUSES a custom base whose PARENT symlinks into the repo (realpath ban, no mkdir side effect)", () => {
    const repoRoot = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
    fs.symlinkSync(repoRoot, path.join(operatorHome, "sneaky"));
    vi.stubEnv("AGENT_ISOLATED_HOME", path.join(operatorHome, "sneaky", "agent-homes-x"));
    expect(() => ensureAgentHome(SLUG)).toThrow(AgentExecError);
    expect(fs.existsSync(path.join(repoRoot, "agent-homes-x"))).toBe(false); // nothing created in the repo
  });

  it("REFUSES a base inside the repo or the worktrees allow-dir (credential must stay outside)", () => {
    const repoRoot = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
    const wtDir = path.resolve(repoRoot, "..", `${path.basename(repoRoot)}.worktrees`);
    for (const banned of [path.join(repoRoot, "agent-homes"), path.join(wtDir, "lane-x", "home")]) {
      vi.stubEnv("AGENT_ISOLATED_HOME", banned);
      expect(() => ensureAgentHome(SLUG), banned).toThrow(AgentExecError);
    }
  });
});

describe("removeAgentHome — post-run reclaim of a lane's credential-bearing home", () => {
  it("removes a home this provisioner created (credential copy reclaimed)", () => {
    const home = ensureAgentHome(SLUG);
    expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
    removeAgentHome(SLUG);
    expect(fs.existsSync(home)).toBe(false);
    // Sibling-lane homes are untouched (per-lane cleanup only).
    const other = ensureAgentHome("lane-other");
    removeAgentHome(SLUG); // no-op again
    expect(fs.existsSync(other)).toBe(true);
  });

  it("REFUSES to delete a directory it did not create (no/spoofed marker → fail closed)", () => {
    const base = path.join(operatorHome, "rmbase");
    const target = path.join(base, SLUG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "keep.txt"), "operator data");
    vi.stubEnv("AGENT_ISOLATED_HOME", base);
    expect(() => removeAgentHome(SLUG)).toThrow(AgentExecError);
    fs.writeFileSync(path.join(target, ".provisioned-by-gantry"), "not the provisioner content");
    expect(() => removeAgentHome(SLUG)).toThrow(AgentExecError);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("operator data"); // untouched
  });

  it("is a NO-OP when the home was never provisioned (drop mode / legacy AGENT_HOME)", () => {
    expect(() => removeAgentHome(SLUG)).not.toThrow();
    expect(fs.existsSync(path.join(operatorHome, ".gantry"))).toBe(false); // nothing created either
  });

  it("REFUSES a base inside the repo/worktrees even with an AUTHENTIC marker (same ban as provisioning)", () => {
    // A fixture repo root so the test never touches the real working tree.
    const repo = path.join(operatorHome, "fixture-repo");
    const target = path.join(repo, "agent-homes", SLUG);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, ".provisioned-by-gantry"), "gantry-agent-home v1\n");
    fs.writeFileSync(path.join(target, "evidence.txt"), "project data");
    vi.stubEnv("HARNESS_REPO", repo);
    vi.stubEnv("AGENT_ISOLATED_HOME", path.join(repo, "agent-homes"));
    expect(() => removeAgentHome(SLUG)).toThrow(AgentExecError);
    expect(fs.readFileSync(path.join(target, "evidence.txt"), "utf8")).toBe("project data"); // untouched
  });
});
