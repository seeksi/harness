// console/lib/sandbox/agent-home.ts
// Isolated HOME provisioning for the DIRECT-MODE build agent. Without this, the agent
// inherits the operator's real $HOME and therefore the operator's ~/.claude — global
// CLAUDE.md instructions, settings, agents, and MCP/deferred-tool wiring all leak into
// the agent's context and trace (noisy, and couples the agent to personal config).
//
// The isolated HOME is REBUILT FROM SCRATCH on every spawn (wipe + recreate, guarded by
// a marker file so a misconfigured path is never destroyed). That is the whole guarantee:
// a Bash-capable agent could plant persistent config in its own HOME during a run
// (~/.claude/CLAUDE.md, settings, .npmrc, even its .gitconfig) to contaminate LATER runs
// — a full rebuild makes every spawn start from exactly two provisioned artifacts:
//   .claude/.credentials.json  the operator's Max-plan OAuth session (no API key), so
//                              the headless agent auths exactly like before
//   .gitconfig                 a git identity, because the agent must `git commit` in
//                              its worktree and a fresh HOME has none
// Everything else (its .claude.json onboarding state, projects/, sessions/) the claude
// CLI creates for itself on first run — verified live 2026-07-06, including that the
// repo's project-level PostToolUse trace hook still fires under a fresh HOME (Gate D
// intact; the hook is $CLAUDE_PROJECT_DIR-relative, not HOME-relative).
//
// Ordering invariant: ALL validation (symlink pin, repo/worktrees ban against the REAL
// resolved path, marker authenticity) happens BEFORE the first destructive or creating
// filesystem operation. A refusal must leave the world exactly as it found it.
//
// Drop mode (AGENT_USER + sudo -H) is untouched: there HOME comes from the agent
// account's own passwd entry, which is already isolated by uid.

import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { AgentExecError } from "@/lib/bridge/errors";

// Wipe guard: the provisioner only ever wipes a directory carrying this marker (i.e. one
// IT created). The marker must be a regular non-symlink file with exactly this content —
// a pre-existing unmarked (or spoof-marked) dir at the target path fails closed, so a
// misconfigured AGENT_ISOLATED_HOME can never rm -rf an operator directory.
const MARKER = ".provisioned-by-gantry";
const MARKER_CONTENT = "gantry-agent-home v1\n";
// The operator credential is a small JSON; anything bigger is not the file we think it is.
const MAX_CRED_BYTES = 64 * 1024;

/** Resolve the isolated-home target: AGENT_ISOLATED_HOME (must be a non-empty absolute
 * path — a set-but-empty value is refused loudly rather than silently falling back, so a
 * typo'd `AGENT_ISOLATED_HOME= cmd` can never resolve anywhere surprising) or the
 * default ~/.gantry/agent-home. */
function resolveHome(): string {
  const raw = process.env.AGENT_ISOLATED_HOME;
  if (raw === undefined) return path.join(os.homedir(), ".gantry", "agent-home");
  if (raw === "" || !path.isAbsolute(raw)) {
    throw new AgentExecError(
      `AGENT_ISOLATED_HOME must be a non-empty absolute path (or unset for the default): ${JSON.stringify(raw)}`
    );
  }
  return path.resolve(raw);
}

/** Realpath of `p` resolved through its DEEPEST EXISTING ancestor — i.e. where the path
 * would actually land if created right now, even when `p` itself does not exist yet.
 * Used to enforce the repo/worktrees ban on the real destination BEFORE any mkdir. */
function realDestination(p: string): string {
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...[...tail].reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) throw new AgentExecError(`agent home path cannot be resolved: ${JSON.stringify(p)}`);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** The repo/worktrees ban, applied to BOTH the lexical path and the realpath destination
 * (so a symlinked parent cannot smuggle the agent home — and the credential — inside the
 * repo or a lane worktree). Same root derivation as worktree.ts, additionally derived
 * from the realpath'd repo root so the REAL sibling worktrees dir is banned even when it
 * does not exist yet or the repo root sits behind symlinked parents. */
function assertOutsideRepoAndWorktrees(home: string, realHome: string): void {
  const repoRoot = path.resolve(process.env.HARNESS_REPO ?? process.cwd());
  const roots = new Set([repoRoot]);
  try {
    roots.add(fs.realpathSync(repoRoot));
  } catch {
    /* lexical root already banned */
  }
  const banned = new Set<string>();
  for (const root of roots) {
    banned.add(root);
    const wtDir = path.resolve(root, "..", `${path.basename(root)}.worktrees`);
    banned.add(wtDir);
    try {
      banned.add(realDestination(wtDir));
    } catch {
      /* unresolvable: lexical entry already covers it */
    }
  }
  for (const target of [home, realHome]) {
    for (const b of banned) {
      if (target === b || target.startsWith(b + path.sep)) {
        throw new AgentExecError(`agent home must live outside the repo and worktrees: ${JSON.stringify(home)}`);
      }
    }
  }
}

/** The REAL destination the home must resolve to, or refuse. Custom AGENT_ISOLATED_HOME
 * must be fully canonical — no symlink in ANY component (pass the realpath'd form if the
 * ancestry legitimately contains one). The default path is pinned below the operator's
 * homedir: system-level symlinks above/at the homedir are tolerated (realpath'd anchor),
 * anything below it (e.g. an agent-planted ~/.gantry symlink) is refused. */
function expectedRealFor(home: string): string {
  const anchor = process.env.AGENT_ISOLATED_HOME !== undefined ? path.parse(home).root : os.homedir();
  return path.join(fs.realpathSync(anchor), path.relative(anchor, home));
}

/** Open + validate + read the operator credential entirely BEFORE any fs mutation.
 * O_NOFOLLOW and fstat ON THE OPEN FD (regular file, sane size) — the file cannot be
 * swapped for a symlink/special file between check and read (no TOCTOU). */
function readOperatorCredential(): Buffer {
  const src = path.join(os.homedir(), ".claude", ".credentials.json");
  let fd: number;
  try {
    fd = fs.openSync(src, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new AgentExecError("agent-home: operator credential is not a regular file (symlink?)");
    }
    throw new AgentExecError(
      "agent-home: operator credential not found (~/.claude/.credentials.json) — " +
        "the agent auths via the operator's Max-plan session; run `claude login` first"
    );
  }
  try {
    const sst = fs.fstatSync(fd);
    if (!sst.isFile()) {
      throw new AgentExecError("agent-home: operator credential is not a regular file");
    }
    if (sst.size > MAX_CRED_BYTES) {
      throw new AgentExecError(`agent-home: operator credential unexpectedly large (${sst.size} bytes)`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Provision the isolated agent HOME (full rebuild) and return its absolute path.
 * Called before every direct-mode spawn. Throws AgentExecError (fail closed) if the
 * operator credential is missing/irregular, the target's real destination is inside the
 * repo/worktrees, the path resolves through a symlink, or the target exists without an
 * authentic marker. On refusal nothing has been created, modified, or deleted.
 */
export function ensureAgentHome(): string {
  const home = resolveHome();

  // ALL validation before ANY mutation, in order: symlink canonicality (would this path
  // land where it lexically claims?), repo/worktrees ban on lexical + real destination,
  // credential readable (into memory), previous-incarnation marker authenticity.
  const realHome = realDestination(home);
  if (realHome !== expectedRealFor(home)) {
    throw new AgentExecError(
      `agent home resolves through a symlink (use the canonical path): ${JSON.stringify(home)}`
    );
  }
  assertOutsideRepoAndWorktrees(home, realHome);
  const credential = readOperatorCredential();

  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(home);
  } catch {
    /* fresh path */
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new AgentExecError(`agent home path is not a real directory (symlink?): ${JSON.stringify(home)}`);
    }
    const markerPath = path.join(home, MARKER);
    let mst: fs.Stats | undefined;
    try {
      mst = fs.lstatSync(markerPath);
    } catch {
      /* no marker */
    }
    if (
      !mst ||
      mst.isSymbolicLink() ||
      !mst.isFile() ||
      mst.size !== Buffer.byteLength(MARKER_CONTENT) || // size precheck: never slurp an oversized plant
      fs.readFileSync(markerPath, "utf8") !== MARKER_CONTENT
    ) {
      throw new AgentExecError(
        `refusing to wipe a directory this provisioner did not create (missing/invalid ${MARKER}): ` +
          `${JSON.stringify(home)} — delete it manually if it is a stale agent home`
      );
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700); // mkdirSync mode skips pre-existing ancestors' umask quirks
  if (fs.realpathSync(home) !== expectedRealFor(home)) {
    // Post-mkdir re-verify (belt and braces against a swap during provisioning).
    throw new AgentExecError(`agent home resolves through a symlink: ${JSON.stringify(home)}`);
  }

  fs.writeFileSync(path.join(home, MARKER), MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { mode: 0o700 });
  // The freshest operator token every spawn, validated + read before the wipe above.
  // Dest dir was created empty this call, so 'wx' (O_CREAT|O_EXCL, no-follow) suffices.
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), credential, { flag: "wx", mode: 0o600 });

  // Git identity, rewritten every spawn (the wipe removed any agent-tampered copy): the
  // agent commits in its worktree and a fresh HOME has no ~/.gitconfig. Resolve the
  // operator's identity (daemon env → same answer the agent used to inherit) with a
  // fixed fallback; values are flattened to one line so a crafted config value can't
  // inject extra gitconfig directives.
  const ident = (key: string): string => {
    try {
      return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  };
  const name = ident("user.name") || "GANTRY Agent";
  const email = ident("user.email") || "agent@gantry.local";
  fs.writeFileSync(path.join(home, ".gitconfig"), `[user]\n\tname = ${name}\n\temail = ${email}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  return home;
}

// ponytail: credential sharing is copy-at-spawn, not a live link. If a long run crosses
// the token's expiry, the agent's CLI refreshes ITS copy and the two files diverge until
// the next spawn re-copies; if Anthropic's refresh tokens are single-use-rotating, that
// refresh could invalidate the operator's session (rare: runs are timeout-capped well
// under token lifetime). skipped: shared-credential locking / refresh reconciliation;
// add if operator logouts ever correlate with long agent runs. Also skipped: per-lane
// homes — the full-wipe rebuild assumes ONE agent at a time (the daemon's single-slot
// invariant); multi-lane concurrency needs per-lane home dirs before it can ship.
