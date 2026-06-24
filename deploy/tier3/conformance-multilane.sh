#!/usr/bin/env bash
# Safe-agent-sandbox MULTI-LANE CONFORMANCE (#17 chunk 17b).
#
# Proves the PER-LANE isolation that LANE_CONCURRENCY>1 depends on actually HOLDS on this
# host. Run on the provisioned VPS as the daemon user (`deploy`, NOPASSWD sudo), AFTER
# 01-provision-agent-user.sh + 01b-provision-lane-users.sh. Read-only-ish: it creates two
# THROWAWAY dirs under the worktrees parent, applies 17a's exact wt-new ACL recipe, runs
# adversarial cross-lane probes, and removes them. Exit 0 iff ALL checks pass.
#
#   sudo bash deploy/tier3/conformance-multilane.sh
#   MAX_LANES=5 sudo bash deploy/tier3/conformance-multilane.sh
#
# Complements conformance.sh (single-user G1/G4/G5/G6/G9). This file adds:
#   (a) each pool user exists + is non-root
#   (b) the CROSS-LANE ACL ISOLATION test — the load-bearing proof:
#       grant agent-1 on dir A, agent-2 on dir B, then assert agent-2 canNOT read/traverse
#       A, deploy CAN read both, and a file CREATED by agent-1 in A is NOT readable by
#       agent-2 (the DEFAULT-ACL leak the cross-review caught — prove it's closed).
set -uo pipefail

MAX_LANES="${MAX_LANES:-5}"
BASE_AGENT_USER="${AGENT_USER:-agent}"
WORKTREES="${WORKTREES:-/opt/umbrella.worktrees}"
DEPLOY_USER="$(id -un)"

case "$MAX_LANES" in ''|*[!0-9]*) echo "FATAL: MAX_LANES must be a positive integer" >&2; exit 1;; esac

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
sect() { printf '\n== %s ==\n' "$1"; }
# run a command AS a given lane uid (the untrusted principal).
asuser() { local u="$1"; shift; sudo -n -u "$u" -H "$@"; }

sect "Pool users exist + non-root (MAX_LANES=$MAX_LANES)"
i=0
while [ "$i" -lt "$MAX_LANES" ]; do
  u=$([ "$i" -eq 0 ] && echo "$BASE_AGENT_USER" || echo "${BASE_AGENT_USER}-${i}")
  if id "$u" >/dev/null 2>&1; then
    uid=$(id -u "$u")
    [ "$uid" != 0 ] && ok "lane $i user '$u' exists, uid=$uid (not root)" || bad "lane $i user '$u' runs as root"
    # HOME should be private 0700 (its own ~/.claude session, G5) — skip lane 0 if home differs.
    home=$(getent passwd "$u" | cut -d: -f6)
    if [ -d "$home" ]; then
      mode=$(stat -c '%a' "$home")
      [ "$mode" = "700" ] && ok "  $u HOME $home is 0700 (private session)" || bad "  $u HOME $home is $mode (expected 700)"
    fi
  else
    bad "lane $i user '$u' does not exist — run 01b-provision-lane-users.sh"
  fi
  i=$((i + 1))
done

# Need at least two pool users for the cross-lane test (lane 1 and lane 2 = agent-1, agent-2).
LANE_A_USER="${BASE_AGENT_USER}-1"
LANE_B_USER="${BASE_AGENT_USER}-2"
if [ "$MAX_LANES" -lt 3 ] || ! id "$LANE_A_USER" >/dev/null 2>&1 || ! id "$LANE_B_USER" >/dev/null 2>&1; then
  printf '\n== CROSS-LANE ACL ISOLATION ==\n'
  bad "need $LANE_A_USER + $LANE_B_USER for the cross-lane test (MAX_LANES>=3) — skipping the load-bearing check"
  printf '\n== RESULT ==  \033[32m%d passed\033[0m / \033[31m%d failed\033[0m\n' "$pass" "$fail"
  echo "MULTI-LANE CONFORMANCE: FAIL — pool too small to prove cross-lane isolation."
  exit 1
fi

sect "CROSS-LANE ACL ISOLATION (17a wt-new recipe — prove siblings can't read each other)"
[ -d "$WORKTREES" ] || { bad "worktrees parent $WORKTREES missing"; }
DIR_A="$(sudo -n mktemp -d "$WORKTREES/.conftest-A.XXXXXX")" || { bad "cannot create probe dir A"; }
DIR_B="$(sudo -n mktemp -d "$WORKTREES/.conftest-B.XXXXXX")" || { bad "cannot create probe dir B"; }
# Always clean up the throwaway dirs, even on early exit.
cleanup() { [ -n "${DIR_A:-}" ] && sudo -n rm -rf -- "$DIR_A" 2>/dev/null; [ -n "${DIR_B:-}" ] && sudo -n rm -rf -- "$DIR_B" 2>/dev/null; }
trap cleanup EXIT

# Apply 17a's EXACT wt-new recipe to each dir, granting a DIFFERENT lane user on each.
# Order is load-bearing: chmod o-rwx FIRST so `setfacl -d` derives default:other::--- from
# the closed mode (else new files inherit other-read → the sibling-leak the cross-review caught).
apply_recipe() {
  local dir="$1" lane="$2" acl
  sudo -n chmod -R o-rwx -- "$dir" || { bad "chmod o-rwx of $dir failed"; return 1; }
  acl="u:$lane:rwX,u:$DEPLOY_USER:rwX,g::---,m::rwX,o::---"
  sudo -n setfacl -R    -m "$acl" -- "$dir" || { bad "setfacl access ACL on $dir failed (acl mount/pkg? — see 01b)"; return 1; }
  sudo -n setfacl -R -d -m "$acl" -- "$dir" || { bad "setfacl default ACL on $dir failed"; return 1; }
}
if apply_recipe "$DIR_A" "$LANE_A_USER" && apply_recipe "$DIR_B" "$LANE_B_USER"; then
  ok "applied wt-new ACL recipe: $LANE_A_USER→A, $LANE_B_USER→B"
else
  bad "could not apply the ACL recipe — cannot run isolation probes"
fi

# (1) The GRANTED lane CAN write its own dir.
if asuser "$LANE_A_USER" sh -c "echo hi > '$DIR_A/own.txt'" 2>/dev/null; then
  ok "$LANE_A_USER CAN write its own dir A (granted access works)"
else
  bad "$LANE_A_USER CANNOT write dir A — the grant is broken (pipeline would fail at build)"
fi

# (2) THE LEAK TEST: a file CREATED by agent-1 in A must NOT be readable by agent-2.
#     This is the default-ACL inheritance the cross-review BLOCKed. The file is agent-1-owned;
#     only the default:other::--- (from chmod-before-setfacl-d) keeps agent-2 out.
if asuser "$LANE_B_USER" cat "$DIR_A/own.txt" >/dev/null 2>&1; then
  bad "LEAK: $LANE_B_USER CAN read a file $LANE_A_USER created in dir A (default-ACL other-read leak OPEN)"
else
  ok "$LANE_B_USER CANNOT read $LANE_A_USER's file in dir A (default-ACL leak CLOSED)"
fi

# (3) Sibling denied: agent-2 cannot read/traverse dir A at all.
if asuser "$LANE_B_USER" ls "$DIR_A" >/dev/null 2>&1; then
  bad "$LANE_B_USER CAN list dir A (sibling traversal not denied)"
else
  ok "$LANE_B_USER CANNOT list/traverse dir A (sibling denied by o::---)"
fi
# And symmetrically agent-1 cannot read dir B.
if asuser "$LANE_A_USER" ls "$DIR_B" >/dev/null 2>&1; then
  bad "$LANE_A_USER CAN list dir B (sibling traversal not denied)"
else
  ok "$LANE_A_USER CANNOT list/traverse dir B (sibling denied by o::---)"
fi

# (4) deploy (the daemon) CAN read BOTH — wt-commit/wt-verify/relocateTrace run as deploy and
#     MUST reach lane files (incl. agent-created ones, via the default u:deploy ACL entry).
if [ -r "$DIR_A/own.txt" ] && cat "$DIR_A/own.txt" >/dev/null 2>&1; then
  ok "deploy ($DEPLOY_USER) CAN read $LANE_A_USER's file in dir A (daemon git steps unaffected)"
else
  bad "deploy CANNOT read $LANE_A_USER's file in dir A — wt-commit/verify/trace would break"
fi
if asuser "$LANE_B_USER" sh -c "echo hi > '$DIR_B/own.txt'" 2>/dev/null && [ -r "$DIR_B/own.txt" ]; then
  ok "deploy CAN read $LANE_B_USER's file in dir B (both lanes reachable by the daemon)"
else
  bad "deploy CANNOT read dir B contents — daemon access to lane B broken"
fi

printf '\n== RESULT ==  \033[32m%d passed\033[0m / \033[31m%d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo "MULTI-LANE CONFORMANCE: FAIL — per-lane isolation does NOT hold; keep LANE_CONCURRENCY=1."; exit 1; }
echo "MULTI-LANE CONFORMANCE: PASS — pool users isolated; cross-lane ACL holds; safe to raise LANE_CONCURRENCY (within the RAM bound)."

# ponytail: the cross-lane test uses throwaway dirs under the worktrees parent + the exact
# wt-new recipe, not a live worktree. Ceiling: it proves the ACL semantics, not a full
# concurrent build. Upgrade path: a two-lane live build smoke test once LANE_CONCURRENCY=2
# is first enabled (17c), asserting two real worktrees stay mutually unreadable.
#
# skipped: RAM-aggregate runtime assertion (start N agents, sum RSS ≤ 1.6G), add once a
#          throwaway-prompt harness exists — today the bound is enforced by arithmetic + the
#          per-lane MemoryMax default (see agent-exec-wrapper.sh / RUNBOOK 17c).
