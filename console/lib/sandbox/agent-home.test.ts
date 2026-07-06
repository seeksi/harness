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
  operatorHome = fs.mkdtempSync(path.join(os.tmpdir(), "op-home-"));
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

  it("RE-COPIES the credential on every call (fresh token each spawn, divergence self-heals)", () => {
    const home = ensureAgentHome();
    const dest = path.join(home, ".claude", ".credentials.json");
    // Simulate divergence: the agent's CLI refreshed its copy, then the operator's rotated.
    fs.writeFileSync(dest, '{"claudeAiOauth":"stale-agent-refresh"}');
    fs.writeFileSync(cred(), '{"claudeAiOauth":"fixture-token-v2"}');
    ensureAgentHome();
    expect(fs.readFileSync(dest, "utf8")).toBe('{"claudeAiOauth":"fixture-token-v2"}');
    expect(mode(dest)).toBe(0o600);
  });

  it("FAILS CLOSED when the operator credential is missing (no unauthed agent home)", () => {
    fs.rmSync(cred());
    expect(() => ensureAgentHome()).toThrow(AgentExecError);
  });

  it("never clobbers an operator-edited .gitconfig", () => {
    const home = ensureAgentHome();
    const gitcfg = path.join(home, ".gitconfig");
    fs.writeFileSync(gitcfg, "[user]\n\tname = Custom\n\temail = custom@example.com\n");
    ensureAgentHome();
    expect(fs.readFileSync(gitcfg, "utf8")).toContain("custom@example.com");
  });

  it("REFUSES a symlinked agent-home path (redirect hardening, fail closed)", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    try {
      fs.mkdirSync(path.join(operatorHome, ".gantry"), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(operatorHome, ".gantry", "agent-home"));
      expect(() => ensureAgentHome()).toThrow(AgentExecError);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
