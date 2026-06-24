#!/usr/bin/env bash
# Tier-3 / G1 (#17 chunk 17b) — provision the per-lane POOL users for concurrent lanes.
#
# Concurrent lanes are isolated by DISTINCT OS users (cross-review BLOCK on a shared uid:
# one `~/.claude` session + same-uid sibling-worktree writes corrupt/leak across lanes).
# laneUser(i) in lib/sandbox resolves: lane 0 → `agent` (the existing account, made by
# 01-provision-agent-user.sh), lane i>0 → `agent-i`. This script creates agent-1..agent-N-1
# so the daemon can raise LANE_CONCURRENCY past 1 (the 17c operator step, AFTER conformance).
#
# Each pool user is: a nologin SYSTEM user, with a PRIVATE 0700 HOME (umask 077), linger
# ENABLED (the wrapper's `systemd-run --user --scope` needs the per-user manager +
# XDG_RUNTIME_DIR), and NO ownership of the repo or worktrees — wt-new grants per-lane
# access at runtime via a POSIX ACL (17a). It also installs `acl` and ASSERTS setfacl
# actually works on the worktrees filesystem (17a's wt-new DIES without it).
#
# Idempotent: safe to re-run. Echoes every action. Run as `deploy` (NOPASSWD sudo).
#   DRAFT FOR REVIEW — do NOT run until the operator signs off (see RUNBOOK.md).
set -euo pipefail

# Pool size. Default 5 → users: agent (lane 0, pre-existing) + agent-1..agent-4 (lanes 1-4).
# Must match the daemon's laneUser(i) naming and bound LANE_CONCURRENCY (17c). Override:
#   MAX_LANES=3 bash 01b-provision-lane-users.sh
MAX_LANES="${MAX_LANES:-5}"

BASE_AGENT_USER="${AGENT_USER:-agent}"     # lane 0 (created by 01-provision-agent-user.sh)
WORKTREES="${WORKTREES:-/opt/umbrella.worktrees}"   # ACL-grant target at wt-new time

case "$MAX_LANES" in ''|*[!0-9]*) echo "[lane-provision] FATAL: MAX_LANES must be a positive integer" >&2; exit 1;; esac
[ "$MAX_LANES" -ge 1 ] || { echo "[lane-provision] FATAL: MAX_LANES must be >= 1" >&2; exit 1; }

say() { echo "[lane-provision] $*"; }

# --- 1. acl package + filesystem ACL support assertion ---------------------------------
# 17a's wt-new runs `setfacl` and FAILS CLOSED if it's missing or the FS isn't mounted
# with ACL support. ext4 has `acl` on by default, but PROVE it on THIS host's worktrees FS
# rather than assume — a silent failure here means every concurrent lane dies at wt-new.
if ! command -v setfacl >/dev/null 2>&1 || ! command -v getfacl >/dev/null 2>&1; then
  say "installing 'acl' package (setfacl/getfacl) — required by wt-new's per-lane ACL grant"
  sudo apt-get install -y acl
fi
command -v setfacl >/dev/null 2>&1 || { say "FATAL: setfacl still missing after install"; exit 1; }

# The worktrees PARENT must exist (01-provision-agent-user.sh creates it). Assert ACLs work
# on the filesystem that actually holds the lane checkouts — that's the FS wt-new touches.
[ -d "$WORKTREES" ] || { say "FATAL: $WORKTREES missing — run 01-provision-agent-user.sh first"; exit 1; }
_acltmp="$(sudo -n mktemp -d "$WORKTREES/.acltest.XXXXXX")" || { say "FATAL: cannot create ACL probe dir under $WORKTREES"; exit 1; }
if sudo -n setfacl -m "u:$BASE_AGENT_USER:rwX" -- "$_acltmp" 2>/dev/null \
   && sudo -n getfacl -- "$_acltmp" 2>/dev/null | grep -q "user:$BASE_AGENT_USER:"; then
  say "verified: setfacl/getfacl work on the worktrees filesystem ($WORKTREES) — wt-new's ACL grant will hold"
  sudo -n rmdir -- "$_acltmp" 2>/dev/null || true
else
  sudo -n rmdir -- "$_acltmp" 2>/dev/null || true
  say "FATAL: setfacl did NOT take on $WORKTREES — the filesystem is likely mounted WITHOUT 'acl'."
  say "       Fix: remount with the 'acl' option (ext4: 'mount -o remount,acl $WORKTREES'; persist in /etc/fstab),"
  say "       or move the worktrees parent to an ACL-capable filesystem. wt-new (17a) FAILS without this."
  exit 1
fi

# --- 2. Create agent-1 .. agent-{MAX_LANES-1} ------------------------------------------
# umask 077 so any path useradd creates is private; HOME re-asserted 0700 explicitly after.
if [ "$MAX_LANES" -eq 1 ]; then
  say "MAX_LANES=1 — only lane 0 ($BASE_AGENT_USER); no pool users to create (single-lane path unchanged)"
fi
i=1
while [ "$i" -lt "$MAX_LANES" ]; do
  u="${BASE_AGENT_USER}-${i}"
  home="/home/$u"
  if id "$u" &>/dev/null; then
    say "user '$u' already exists — leaving as-is"
  else
    # System account, nologin (sudo -u execs the binary directly, no login shell), own HOME.
    # NO membership in deploy/any privileged group — access to a lane comes ONLY via wt-new's
    # per-lane ACL, never group ownership.
    ( umask 077; sudo useradd --system --create-home --home-dir "$home" \
        --shell /usr/sbin/nologin --comment "HARNESS build agent lane $i (low-priv)" "$u" )
    say "created system user '$u' (home=$home, shell=nologin)"
  fi

  # HOME exists, owned by the lane user, PRIVATE 0700 — its own ~/.claude session (bootstrapped
  # by the operator in 17c) must be readable ONLY by this uid (G5), never by deploy/world/siblings.
  sudo install -d -o "$u" -g "$u" -m 0700 "$home"
  say "ensured $home (0700, owned by $u) — private ~/.claude lands here in 17c"

  # Enable LINGER: the wrapper runs `systemd-run --user --scope` for the G6 cgroup caps, which
  # needs a persistent per-user manager + /run/user/<uid>. Without it the wrapper FAILS CLOSED.
  sudo loginctl enable-linger "$u"
  uid="$(id -u "$u")"
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -d "/run/user/$uid" ] && break; sleep 1; done
  if [ -d "/run/user/$uid" ]; then
    say "enabled linger for '$u' — XDG_RUNTIME_DIR present: /run/user/$uid"
  else
    say "WARN: /run/user/$uid not present yet for '$u' — verify 'systemd-run --user --scope' before raising LANE_CONCURRENCY"
  fi
  # Confirm the exact mechanism the wrapper needs actually works for this lane user.
  if sudo -u "$u" XDG_RUNTIME_DIR="/run/user/$uid" systemd-run --user --scope -q -- true >/dev/null 2>&1; then
    say "verified: 'systemd-run --user --scope' works for $u (G6 cgroup caps available)"
  else
    say "WARN: 'systemd-run --user --scope' did NOT work for $u — wrapper will fail-closed for this lane. Investigate before cutover."
  fi
  i=$((i + 1))
done

# --- 3. Confirm NO pool user owns the repo or worktrees --------------------------------
# Per-lane access is ACL-granted by wt-new, NOT ownership. Assert the parent stays deploy-owned.
if [ -d "$WORKTREES" ]; then
  owner="$(stat -c '%U' "$WORKTREES")"
  say "worktrees parent $WORKTREES owned by '$owner' (per-lane access is ACL-granted at wt-new, not owned)"
fi

say "DONE. Pool: $BASE_AGENT_USER (lane 0) + $( [ "$MAX_LANES" -gt 1 ] && echo "${BASE_AGENT_USER}-1..${BASE_AGENT_USER}-$((MAX_LANES-1))" || echo "(none)" )."
say "Next (17c): bootstrap each user's Max-plan ~/.claude session, run conformance-multilane.sh, then raise LANE_CONCURRENCY."

# ponytail: pool size is fixed at provision time (MAX_LANES). Ceiling: adding a lane later
# means re-running this with a larger MAX_LANES (idempotent). Upgrade path: a per-host vars
# file shared with provision.sh once >1 host layout exists.
#
# skipped: per-user disk quota, add when disk-DoS across lanes needs a hard cap beyond ulimit fsize.
# skipped: cross-user aggregate RAM slice (see agent-exec-wrapper.sh harness.slice note) — relies
#          on the per-lane MemoryMax + LANE_CONCURRENCY bound instead (honest: --user scopes
#          do NOT aggregate across distinct users).
