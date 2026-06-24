#!/usr/bin/env bash
# Tier-3 / G1 — provision the dedicated low-priv `agent` OS account.
#
# The agent (headless Claude Code) must NOT run as `deploy` or root. agent-bridge.ts
# launches it via `sudo -n -H -u agent -- <claude>`; this account is the real FS jail:
# its only writable area is the worktrees dir, so even if the agent escapes its cwd it
# cannot write the repo, the live tree, or another lane.
#
# Idempotent: safe to re-run. Echoes every action. Run as `deploy` (NOPASSWD sudo).
#   DRAFT FOR REVIEW — do NOT run until the operator signs off (see RUNBOOK.md).
set -euo pipefail

AGENT_USER="agent"
AGENT_HOME="/opt/umbrella/agent-home"     # AGENT_HOME — holds the Max-plan ~/.claude session
REPO="/opt/umbrella"                       # HARNESS_REPO
WORKTREES="/opt/umbrella.worktrees"        # sibling of REPO, per wt.sh layout

say() { echo "[provision] $*"; }

# 1. System user, nologin shell, own HOME. nologin is fine: `sudo -u` execs the binary
#    directly, it does not open a login shell. System account (no aging, no /etc/skel noise).
if id "$AGENT_USER" &>/dev/null; then
  say "user '$AGENT_USER' already exists — leaving as-is"
else
  sudo useradd --system --create-home --home-dir "$AGENT_HOME" \
       --shell /usr/sbin/nologin --comment "HARNESS build agent (low-priv)" "$AGENT_USER"
  say "created system user '$AGENT_USER' (home=$AGENT_HOME, shell=nologin)"
fi

# 2. HOME exists, owned by agent, private (0700). The Max-plan session lives under
#    $AGENT_HOME/.claude — G5 requires it readable ONLY by agent (not deploy/world).
sudo install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$AGENT_HOME"
say "ensured $AGENT_HOME (0700, owned by $AGENT_USER)"

# 3. Worktrees dir: created and owned by agent so `git worktree add` (run by deploy via
#    harness.sh) AND the agent's own writes land here. deploy creates worktrees, agent
#    writes inside them — both need access, so group = deploy, dir is group-writable +
#    setgid so children inherit the group.
#    ponytail: shared dir owned by agent, group deploy. Ceiling: deploy and agent both
#    write here, so neither is fully isolated from the other's worktrees. Upgrade path:
#    give each lane its own subdir mode 0700 owned by agent and have deploy create them
#    via a tiny setuid-agent helper, or move to per-lane bind-mounts / containers.
sudo install -d -o "$AGENT_USER" -g "deploy" -m 2775 "$WORKTREES"
say "ensured $WORKTREES (2775, owned by $AGENT_USER:deploy)"

# 3b. Enable LINGER so the agent gets a persistent systemd --user manager + an
#     XDG_RUNTIME_DIR (/run/user/<uid>) even with no login session. The wrapper runs
#     `systemd-run --user --scope` to apply the G6 AGGREGATE cgroup caps; without linger
#     there is no user bus and the wrapper FAILS CLOSED (refuses to run claude uncapped).
sudo loginctl enable-linger "$AGENT_USER"
say "enabled linger for '$AGENT_USER' (persistent --user manager for cgroup scopes)"
AGENT_UID="$(id -u "$AGENT_USER")"
# The runtime dir appears asynchronously once logind spins up the user manager. Wait briefly.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -d "/run/user/$AGENT_UID" ] && break
  sleep 1
done
if [ -d "/run/user/$AGENT_UID" ]; then
  say "XDG_RUNTIME_DIR present: /run/user/$AGENT_UID"
else
  say "WARN: /run/user/$AGENT_UID not present yet — verify 'systemd-run --user --scope' for agent (RUNBOOK Step 1)"
fi
# Confirm the user manager can actually create a scope (the exact mechanism the wrapper needs).
if sudo -u "$AGENT_USER" XDG_RUNTIME_DIR="/run/user/$AGENT_UID" systemd-run --user --scope -q -- true >/dev/null 2>&1; then
  say "verified: 'systemd-run --user --scope' works for $AGENT_USER (G6 cgroup caps available)"
else
  say "WARN: 'systemd-run --user --scope' did NOT work for $AGENT_USER — wrapper will fail-closed. Investigate before cutover."
fi

# 4. Repo readability: the agent reads the repo it builds from (shared git objects for
#    `git worktree`), but must NOT write it. Confirm repo is owned by deploy and only
#    group/other-readable — we do NOT chown the repo to agent.
if [ -d "$REPO/.git" ]; then
  say "repo $REPO present (owner: $(stat -c '%U' "$REPO")) — agent gets read via o+rx, NOT write"
  # Ensure world/group can traverse+read but not write the repo tree (no-op if already so).
  sudo find "$REPO" -type d -exec chmod o+rx {} + 2>/dev/null || true
else
  say "WARN: $REPO/.git not found — provision the deploy repo first"
fi

# 4b. $AGENT_HOME lives INSIDE $REPO, so the `find $REPO -type d -exec chmod o+rx`
#     above re-opened it (0700 → 0705). Re-assert 0700 LAST so the Max-plan session dir
#     is readable ONLY by agent (G5). Must come after the repo o+rx pass.
sudo chmod 0700 "$AGENT_HOME"
say "re-asserted $AGENT_HOME 0700 (G5 — undo the repo o+rx that reaches into it)"

# 5. Sanity echo of the resulting identity (operator verifies against the unit env).
say "agent uid/gid: $(id "$AGENT_USER")"
say "DONE. Next: install sudoers fragment, drop-in, wrapper, nft (see RUNBOOK.md)."

# skipped: per-lane 0700 isolation, add when multiple lanes run concurrently or multi-tenant.
# skipped: quota on $WORKTREES, add when disk-DoS (G6) needs a hard FS cap beyond ulimit fsize.
