#!/usr/bin/env bash
# Safe-agent-sandbox CONFORMANCE TEST.
#
# Proves the isolation guarantees of the deployed sandbox actually HOLD on this host —
# the load-bearing deliverable of the substrate (a threat model is only as good as the
# test that proves it). Run on the provisioned VPS as the daemon user (`deploy`, NOPASSWD
# sudo). Read-only: it asserts, it does not change the host (it spawns ephemeral agent-uid
# probes that are denied/allowed and a transient cgroup scope). Exit 0 iff ALL checks pass.
#
#   sudo bash deploy/tier3/conformance.sh            # full suite
#   AGENT_USER=agent PROXY=http://127.0.0.1:3128 sudo bash deploy/tier3/conformance.sh
#
# Maps to the threat-model §6 gates: G1 privilege, G4 egress, G5 credential, G6 limits,
# G1/G9 tool allowlist + MCP isolation.
set -uo pipefail

AGENT_USER="${AGENT_USER:-agent}"
REPO="${HARNESS_REPO:-/opt/umbrella}"
WORKTREES="${WORKTREES:-/opt/umbrella.worktrees}"
PROXY="${PROXY:-http://127.0.0.1:3128}"
WRAPPER="${WRAPPER:-/opt/umbrella/deploy/agent-exec-wrapper.sh}"
ALLOW_HOST="${ALLOW_HOST:-https://api.anthropic.com/}"
DENY_HOST="${DENY_HOST:-https://example.com/}"
# The app binds the tailnet IP (not loopback), so default the capabilities URL to it.
# Override CAPS_URL for a different bind.
CAPS_URL="${CAPS_URL:-http://100.86.74.120:3000/api/agent/capabilities}"

pass=0; fail=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
sect() { printf '\n== %s ==\n' "$1"; }
# run a command AS the agent uid (the untrusted principal). nologin shell is fine — we exec directly.
asagent() { sudo -n -u "$AGENT_USER" -H "$@"; }

sect "G1 — privilege drop & FS confinement"
if id "$AGENT_USER" >/dev/null 2>&1; then
  uid=$(id -u "$AGENT_USER")
  [ "$uid" != 0 ] && ok "agent uid=$uid is not root" || bad "agent runs as root"
else bad "agent user '$AGENT_USER' does not exist"; fi
asagent test -w "$REPO" 2>/dev/null && bad "agent CAN write the repo ($REPO)" || ok "repo is read-only to the agent"
if [ -d "$WORKTREES" ]; then
  owner=$(stat -c '%U' "$WORKTREES")
  [ "$owner" = "deploy" ] || [ "$owner" = "root" ] && ok "worktrees parent owned by $owner (agent can't symlink-swap siblings)" \
    || bad "worktrees parent owned by $owner (agent-writable parent = TOCTOU surface)"
fi

sect "G5 — credential isolation"
if asagent env 2>/dev/null | grep -qiE 'ANTHROPIC_API_KEY|_API_KEY=|SECRET=|TOKEN=|PASSWORD='; then
  bad "a credential-named var is visible in the agent env"
else ok "no API key / credential-named var in the agent env (Max-plan session only)"; fi

sect "G4 — egress firewall (agent reaches ONLY the Anthropic API)"
code=$(asagent env HTTPS_PROXY="$PROXY" curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$ALLOW_HOST" 2>/dev/null)
[ -n "$code" ] && [ "$code" != "000" ] && ok "agent → Anthropic via proxy connects (HTTP $code)" \
  || bad "agent → Anthropic via proxy FAILED (got '${code:-none}')"
if asagent env HTTPS_PROXY="$PROXY" curl -sS --max-time 8 -o /dev/null "$DENY_HOST" 2>/dev/null; then
  bad "proxy ALLOWED a non-Anthropic host ($DENY_HOST)"
else ok "proxy denies non-Anthropic host (FQDN allowlist holds)"; fi
if asagent env NO_PROXY='*' curl -sS --max-time 6 -o /dev/null "$DENY_HOST" 2>/dev/null; then
  bad "agent bypassed the proxy with DIRECT egress (nft backstop failed)"
else ok "nft blocks direct agent egress (proxy is the only path out)"; fi
if asagent getent hosts example.com >/dev/null 2>&1; then
  bad "agent can resolve DNS directly (DNS-tunnel exfil channel open)"
else ok "agent cannot resolve DNS directly (proxy resolves names)"; fi
curl -sS --max-time 8 -o /dev/null "$DENY_HOST" 2>/dev/null && ok "deploy egress is unaffected (policy scoped to the agent uid)" \
  || bad "deploy egress is broken (policy is too broad)"

sect "G6 — resource limits / fail-closed wrapper"
[ -x "$WRAPPER" ] || bad "wrapper missing/not executable at $WRAPPER"
owner_mode=$(stat -c '%U %a' "$WRAPPER" 2>/dev/null)
[ "${owner_mode%% *}" = "root" ] && ok "wrapper is root-owned (agent can't edit its own limits): $owner_mode" \
  || bad "wrapper not root-owned ($owner_mode) — agent could rewrite its caps"
# fail-closed: with the user manager unreachable the wrapper MUST refuse (exit 78), never run uncapped.
asagent env XDG_RUNTIME_DIR=/nonexistent "$WRAPPER" --version >/dev/null 2>&1
rc=$?; [ "$rc" -eq 78 ] && ok "wrapper FAILS CLOSED (exit 78) when the cgroup scope is unavailable" \
  || bad "wrapper did not fail closed (exit $rc) — could run claude uncapped"

sect "G1/G9 — tool allowlist & MCP isolation (static surface)"
caps=$(curl -sS --max-time 6 "$CAPS_URL" 2>/dev/null)
if [ -n "$caps" ]; then
  echo "$caps" | grep -q '"bashEnabled":false' && ok "Bash is NOT in the agent allowlist" || bad "Bash appears enabled"
  echo "$caps" | grep -qE '"servers":\[\]' && echo "$caps" | grep -q '"strict":true' \
    && ok "MCP strict, zero servers (operator connectors isolated)" || bad "MCP not strict/zero"
else bad "could not read /api/agent/capabilities to assert tool/MCP surface"; fi

printf '\n== RESULT ==  \033[32m%d passed\033[0m / \033[31m%d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || { echo "CONFORMANCE: FAIL — the sandbox does not fully isolate; do NOT enable agent exec."; exit 1; }
echo "CONFORMANCE: PASS — privilege/egress/credential/limits/MCP isolation all hold."
# ponytail: add a real --strict-mcp-config runtime probe (spawn an agent, assert zero
#   mcp-logs created) once a throwaway-prompt harness exists; today MCP is asserted via the
#   capabilities contract + the egress allowlist (claude.ai/MCP hosts aren't reachable).
