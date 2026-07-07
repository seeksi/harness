import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { ensureAgentHome } from "./agent-home";
import { AgentExecError } from "@/lib/bridge/errors";

// A fake OPERATOR home (the credential source: $HOME/.claude/.credentials.json) and a
// scratch area for the isolated home. os.homedir() reads $HOME on POSIX, so stubbing
// HOME points ensureAgentHome's source (and its default destination) at the fixture.
let operatorHome: string;
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

describe("ensureAgentHome — minimal isolated HOME provisioning", () => {
  it("provisions <home>/.gantry/agent-home by default: 0700 dirs, credential copy 0600, git identity", () => {
    const home = ensureAgentHome();
    expect(home).toBe(path.join(operatorHome, ".gantry", "agent-home"));
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

  it("respects AGENT_ISOLATED_HOME as the destination", () => {
    const custom = path.join(operatorHome, "custom-isolated");
    vi.stubEnv("AGENT_ISOLATED_HOME", custom);
    expect(ensureAgentHome()).toBe(custom);
    expect(fs.existsSync(path.join(custom, ".claude", ".credentials.json"))).toBe(true);
  });

  it("REBUILDS from scratch every call: agent-planted persistent config is wiped", () => {
    const home = ensureAgentHome();
    // A Bash-capable agent plants config in ITS OWN home to contaminate later runs…
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "malicious standing instructions");
    fs.mkdirSync(path.join(home, ".claude", "agents"));
    fs.writeFileSync(path.join(home, ".npmrc"), "registry=https://evil.example");
    fs.writeFileSync(path.join(home, ".gitconfig"), "[core]\n\tfsmonitor = evil\n");
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":"stale"}');
    fs.writeFileSync(cred(), '{"claudeAiOauth":"fixture-token-v2"}');
    // …the next provisioning wipes everything and rebuilds only the two artifacts.
    ensureAgentHome();
    expect(fs.readdirSync(path.join(home, ".claude"))).toEqual([".credentials.json"]);
    expect(fs.existsSync(path.join(home, ".npmrc"))).toBe(false);
    expect(fs.readFileSync(path.join(home, ".gitconfig"), "utf8")).not.toContain("fsmonitor");
    expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8")).toBe(
      '{"claudeAiOauth":"fixture-token-v2"}'
    );
  });

  it("REFUSES to wipe a pre-existing directory it did not create (no marker → fail closed)", () => {
    const target = path.join(operatorHome, "precious");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "operator data");
    vi.stubEnv("AGENT_ISOLATED_HOME", target);
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("operator data"); // untouched
  });

  it("FAILS CLOSED when the operator credential is missing, a symlink, or oversized", () => {
    fs.rmSync(cred());
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    // symlinked credential source is never read through
    fs.writeFileSync(path.join(operatorHome, "other.json"), "{}");
    fs.symlinkSync(path.join(operatorHome, "other.json"), cred());
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    fs.rmSync(cred());
    fs.writeFileSync(cred(), Buffer.alloc(65 * 1024));
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
  });

  it("REFUSES a symlinked agent-home path AND a symlinked ancestor, touching NOTHING at the target", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-")));
    try {
      // final component is a symlink
      fs.mkdirSync(path.join(operatorHome, ".gantry"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry", "agent-home"));
      expect(() => ensureAgentHome()).toThrow(AgentExecError);
      expect(fs.readdirSync(elsewhere)).toEqual([]); // nothing created through the link
      // ancestor (.gantry itself) is a symlink → canonicality check catches it pre-mkdir
      fs.rmSync(path.join(operatorHome, ".gantry"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry"));
      expect(() => ensureAgentHome()).toThrow(AgentExecError);
      expect(fs.readdirSync(elsewhere)).toEqual([]); // no mkdir side effect either
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("credential failure leaves an existing marked home INTACT (validation precedes the wipe)", () => {
    const home = ensureAgentHome();
    fs.writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "leftover from last run");
    fs.rmSync(cred());
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    // The refusal happened BEFORE the wipe: the previous incarnation is untouched.
    expect(fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8")).toBe("leftover from last run");
  });

  it("REFUSES an empty or relative AGENT_ISOLATED_HOME (never the daemon cwd, never a silent fallback)", () => {
    vi.stubEnv("AGENT_ISOLATED_HOME", "");
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    vi.stubEnv("AGENT_ISOLATED_HOME", "relative/path");
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
  });

  it("REFUSES BEFORE WIPING: a marked home reached through a symlinked ancestor survives intact", () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-")));
    try {
      // A provisioner-shaped (marked) directory lives at the symlink TARGET; if validation
      // ran after the wipe, this rm -rf would reach through the redirected ancestor.
      const victim = path.join(elsewhere, "agent-home");
      fs.mkdirSync(victim, { recursive: true });
      fs.writeFileSync(path.join(victim, ".provisioned-by-gantry"), "gantry-agent-home v1\n");
      fs.writeFileSync(path.join(victim, "evidence.txt"), "must survive");
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry"));
      expect(() => ensureAgentHome()).toThrow(AgentExecError);
      expect(fs.readFileSync(path.join(victim, "evidence.txt"), "utf8")).toBe("must survive");
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("REFUSES to wipe when the marker is spoofed (a directory, or wrong content)", () => {
    const target = path.join(operatorHome, "spoofed");
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(target, ".provisioned-by-gantry")); // marker as a directory
    fs.writeFileSync(path.join(target, "keep.txt"), "operator data");
    vi.stubEnv("AGENT_ISOLATED_HOME", target);
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    fs.rmSync(path.join(target, ".provisioned-by-gantry"), { recursive: true });
    fs.writeFileSync(path.join(target, ".provisioned-by-gantry"), "not the provisioner content");
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("operator data"); // untouched
  });

  it("REFUSES a custom home whose PARENT symlinks into the repo (realpath ban, no mkdir side effect)", () => {
    const repoRoot = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
    fs.symlinkSync(repoRoot, path.join(operatorHome, "sneaky"));
    vi.stubEnv("AGENT_ISOLATED_HOME", path.join(operatorHome, "sneaky", "agent-home-x"));
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
    expect(fs.existsSync(path.join(repoRoot, "agent-home-x"))).toBe(false); // nothing created in the repo
  });

  it("REFUSES a home inside the repo or the worktrees allow-dir (credential must stay outside)", () => {
    const repoRoot = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
    const wtDir = path.resolve(repoRoot, "..", `${path.basename(repoRoot)}.worktrees`);
    for (const banned of [path.join(repoRoot, "agent-home"), path.join(wtDir, "lane-x", "home")]) {
      vi.stubEnv("AGENT_ISOLATED_HOME", banned);
      expect(() => ensureAgentHome(), banned).toThrow(AgentExecError);
    }
  });
});
