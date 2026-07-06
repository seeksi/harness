// console/lib/sandbox/agent-home.ts
// Isolated HOME provisioning for the DIRECT-MODE build agent. Without this, the agent
// inherits the operator's real $HOME and therefore the operator's ~/.claude — global
// CLAUDE.md instructions, settings, agents, and MCP/deferred-tool wiring all leak into
// the agent's context and trace (noisy, and couples the agent to personal config).
//
// The fix: give the agent its own minimal HOME containing ONLY what it needs —
//   .claude/.credentials.json  the operator's Max-plan OAuth session (no API key), so
//                              the headless agent auths exactly like before
//   .gitconfig                 a git identity, because the agent must `git commit` in
//                              its worktree and a fresh HOME has none
// Everything else (its .claude.json onboarding state, projects/, sessions/) the claude
// CLI creates for itself on first run — verified live 2026-07-06, including that the
// repo's project-level PostToolUse trace hook still fires under a fresh HOME (Gate D
// intact; the hook is $CLAUDE_PROJECT_DIR-relative, not HOME-relative).
//
// The credential is RE-COPIED from the operator's live file on EVERY spawn, so each run
// starts from the freshest token and any divergence self-heals at the next spawn.
// Drop mode (AGENT_USER + sudo -H) is untouched: there HOME comes from the agent
// account's own passwd entry, which is already isolated by uid.

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { AgentExecError } from "@/lib/bridge/errors";

/** Refuse a path whose final component is a symlink (fail closed — same spirit as the
 * relocateTrace dest hardening: the direct-mode agent shares our uid and could plant a
 * link to redirect the credential copy). */
function assertRealDir(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new AgentExecError(`agent home path is not a real directory (symlink?): ${JSON.stringify(p)}`);
  }
}

/**
 * Provision (or refresh) the isolated agent HOME and return its absolute path.
 * Location: AGENT_ISOLATED_HOME if set, else ~/.gantry/agent-home — always OUTSIDE the
 * repo and worktrees so the credential can never be committed or swept into a trace.
 * Idempotent and cheap; called before every direct-mode spawn. Throws AgentExecError
 * (fail closed) if the operator credential is missing or the layout is tampered with.
 */
export function ensureAgentHome(): string {
  const home = path.resolve(process.env.AGENT_ISOLATED_HOME ?? path.join(os.homedir(), ".gantry", "agent-home"));
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  assertRealDir(home);
  assertRealDir(claudeDir);
  // mkdirSync's mode only applies to dirs it creates — pin 0700 on pre-existing ones too
  // (the dir holds a live session credential).
  fs.chmodSync(home, 0o700);
  fs.chmodSync(claudeDir, 0o700);

  // Refresh the Max-plan credential from the operator's live file. Atomic no-follow
  // write (tmp 'wx' + rename), mirroring relocateTrace: never write through a symlink
  // that could have been swapped in at the destination.
  const src = path.join(os.homedir(), ".claude", ".credentials.json");
  let cred: Buffer;
  try {
    cred = fs.readFileSync(src);
  } catch {
    throw new AgentExecError(
      "agent-home: operator credential not found (~/.claude/.credentials.json) — " +
        "the agent auths via the operator's Max-plan session; run `claude login` first"
    );
  }
  const dest = path.join(claudeDir, ".credentials.json");
  const tmp = path.join(claudeDir, `.credentials.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, cred, { flag: "wx", mode: 0o600 });
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup; the real error is the rename failure */
    }
    throw e;
  }

  // Git identity: the agent commits in its worktree; a fresh HOME has no ~/.gitconfig →
  // `git commit` dies with "Please tell me who you are". Resolve the operator's identity
  // once (daemon env → same answer the agent used to inherit) with a fixed fallback.
  // Written once, never clobbered — an operator can edit it.
  const gitcfg = path.join(home, ".gitconfig");
  if (!fs.existsSync(gitcfg)) {
    const ident = (key: string): string => {
      try {
        return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    };
    const name = ident("user.name") || "GANTRY Agent";
    const email = ident("user.email") || "agent@gantry.local";
    fs.writeFileSync(gitcfg, `[user]\n\tname = ${name}\n\temail = ${email}\n`, { flag: "wx", mode: 0o600 });
  }

  return home;
}

// ponytail: credential sharing is copy-at-spawn, not a live link. If a long run crosses
// the token's expiry, the agent's CLI refreshes ITS copy and the two files diverge until
// the next spawn re-copies; if Anthropic's refresh tokens are single-use-rotating, that
// refresh could invalidate the operator's session (rare: runs are timeout-capped well
// under token lifetime). skipped: shared-credential locking / refresh reconciliation;
// add if operator logouts ever correlate with long agent runs.
