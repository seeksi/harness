#!/usr/bin/env bash
# Tier-3 — ONE-COMMAND provisioner for the safe-agent-sandbox substrate.
#
# Automates RUNBOOK.md Steps 1-4 + 6 (the install sequence) in order, idempotently.
# Run as `deploy` (NOPASSWD sudo) ON the provisioned VPS, from the repo root:
#   $ sudo -v   # warm the sudo cache (or rely on NOPASSWD)
#   $ bash deploy/tier3/provision.sh            # install everything
#   $ bash deploy/tier3/provision.sh --verify   # install, then run conformance.sh
#
# What it DOES (each step echoes what it did and re-runs safely):
#   1. agent user + linger          (delegates to 01-provision-agent-user.sh → G1)
#   2. wrapper install root:root 0755                                        (G6)
#   3. sudoers install 0440 + visudo -cf                                     (G1)
#   4. tinyproxy install + apparmor override + reload + service + nft        (G4)
#   6. systemd drop-in install + daemon-reload + restart                     (wiring)
#
# What it DELIBERATELY does NOT do (operator's deliberate steps — see RUNBOOK.md):
#   - Step 5: the MANUAL Max-plan login (`claude auth login` as agent). Printed, not run.
#   - The CUTOVER: it NEVER flips ENABLE_AGENT_EXEC / ENABLE_PROMOTE_TO_MAIN / HARNESS_LIVE.
#     Those stay commented in umbrella-agent.conf for a deliberate, signed-off cutover.
#
# It installs the EXISTING deploy/tier3 artifacts by path — it does not duplicate their
# content. If conformance fails (with --verify) it exits non-zero and refuses to claim
# success.
#   DRAFT FOR REVIEW — do NOT run until the operator signs off (see RUNBOOK.md).
set -euo pipefail

# --- HOST-SPECIFIC ASSUMPTIONS (adjust here if your host differs) ----------------------
# These mirror the RUNBOOK "Deploy facts". Change them in ONE place if the host layout,
# tinyproxy path, or apparmor profile name differs from the reference VPS.
REPO="${HARNESS_REPO:-/opt/umbrella}"                 # deploy repo root
TIER3="$REPO/deploy/tier3"                            # this dir, installed on the VPS
INSTALL_WRAPPER="$REPO/deploy/agent-exec-wrapper.sh"  # where AGENT_CLI_PATH points
TINYPROXY_BIN="/usr/bin/tinyproxy"                    # Ubuntu path (NOT /usr/sbin)
APPARMOR_PROFILE="/etc/apparmor.d/tinyproxy"          # distro profile name we override
AGENT_USER="agent"

VERIFY=0
[ "${1:-}" = "--verify" ] && VERIFY=1

say()  { echo "[provision] $*"; }
step() { echo; echo "=== $* ==="; }

# Fail early if the artifacts aren't where we expect (e.g. repo not copied to the VPS).
[ -d "$TIER3" ] || { echo "[provision] FATAL: $TIER3 not found — copy deploy/tier3 to the VPS first (RUNBOOK Prerequisites)" >&2; exit 1; }
for f in 01-provision-agent-user.sh agent-exec-wrapper.sh sudoers.d-umbrella-agent \
         umbrella-agent.conf agent-egress.nft conformance.sh \
         egress-proxy/tinyproxy.conf egress-proxy/anthropic-allow.filter \
         egress-proxy/apparmor-local-tinyproxy egress-proxy/umbrella-egress-proxy.service; do
  [ -f "$TIER3/$f" ] || { echo "[provision] FATAL: missing artifact $TIER3/$f" >&2; exit 1; }
done

# --- Step 1 — agent user + linger (G1) -------------------------------------------------
# Delegate to the existing idempotent script rather than re-implement the user/linger/perms.
step "Step 1 — agent user, HOME, worktrees, linger (G1)"
bash "$TIER3/01-provision-agent-user.sh"

# --- Step 2 — install the wrapper root:root 0755 (G6) ----------------------------------
step "Step 2 — install agent-exec-wrapper (root:root 0755, NOT agent-writable) (G6)"
sudo install -D -m 0755 -o root -g root "$TIER3/agent-exec-wrapper.sh" "$INSTALL_WRAPPER"
say "installed wrapper → $INSTALL_WRAPPER ($(stat -c '%U:%G %a' "$INSTALL_WRAPPER"))"

# --- Step 3 — install the sudoers fragment 0440 + validate (G1) ------------------------
step "Step 3 — install sudoers fragment (0440) + visudo -cf (G1)"
sudo install -m 0440 -o root -g root "$TIER3/sudoers.d-umbrella-agent" /etc/sudoers.d/umbrella-agent
# visudo -cf MUST pass or we leave a broken drop-in (sudo would refuse the WHOLE tree).
sudo visudo -cf /etc/sudoers.d/umbrella-agent
sudo visudo -c   # whole tree sanity
say "sudoers fragment installed + parsed OK"

# --- Step 4 — egress proxy (tinyproxy + apparmor) + nft backstop (G4) -------------------
step "Step 4a — egress proxy: tinyproxy install, config, apparmor override, service (G4)"
sudo apt-get install -y tinyproxy
[ -x "$TINYPROXY_BIN" ] || say "WARN: $TINYPROXY_BIN not found after install — the unit ExecStart pins this path; adjust if your distro differs"
sudo useradd --system --no-create-home --shell /usr/sbin/nologin tinyproxy-agent 2>/dev/null || true
sudo install -d -o tinyproxy-agent -g tinyproxy-agent -m 0750 /var/log/tinyproxy
sudo install -d -m 0755 /etc/tinyproxy
sudo install -m 0644 -o root -g root "$TIER3/egress-proxy/tinyproxy.conf"        /etc/tinyproxy/agent-proxy.conf
sudo install -m 0644 -o root -g root "$TIER3/egress-proxy/anthropic-allow.filter" /etc/tinyproxy/anthropic-allow.filter
sudo install -m 0644 -o root -g root "$TIER3/egress-proxy/umbrella-egress-proxy.service" /etc/systemd/system/umbrella-egress-proxy.service
# AppArmor: Ubuntu's tinyproxy profile DENIES our custom config/filter/log paths; the
# override re-allows them. Reload the profile so the override takes effect. Skip cleanly
# on hosts without apparmor (the profile won't exist there).
sudo install -m 0644 -o root -g root "$TIER3/egress-proxy/apparmor-local-tinyproxy" /etc/apparmor.d/local/tinyproxy
if [ -f "$APPARMOR_PROFILE" ] && command -v apparmor_parser >/dev/null 2>&1; then
  sudo apparmor_parser -r "$APPARMOR_PROFILE"
  say "reloaded apparmor profile $APPARMOR_PROFILE (custom paths allowed)"
else
  say "WARN: apparmor profile $APPARMOR_PROFILE absent — skipping reload (no apparmor confinement on this host)"
fi
sudo systemctl daemon-reload
sudo systemctl enable --now umbrella-egress-proxy
sudo systemctl restart umbrella-egress-proxy   # re-apply config on a re-run
say "egress proxy active:"; sudo ss -ltnp 2>/dev/null | grep '127.0.0.1:3128' || say "WARN: proxy not listening on 127.0.0.1:3128 — check 'journalctl -u umbrella-egress-proxy'"

step "Step 4b — nft egress backstop (agent uid → proxy only; deny direct egress) (G4)"
sudo nft -f "$TIER3/agent-egress.nft"   # self-contained own table; idempotent reload
sudo nft list table inet agent_egress >/dev/null && say "nft table inet agent_egress loaded"
say "REMINDER: persist nft across reboot via your /etc/nftables.conf include (RUNBOOK Step 4b)"

# --- Step 6 — systemd drop-in (env; cutover flags STAY commented) (wiring) --------------
step "Step 6 — systemd drop-in (AGENT_* env; ENABLE_* flags stay OFF) (wiring)"
sudo install -d /etc/systemd/system/umbrella.service.d
sudo install -m 0644 -o root -g root "$TIER3/umbrella-agent.conf" /etc/systemd/system/umbrella.service.d/agent.conf
sudo systemctl daemon-reload
sudo systemctl restart umbrella || say "WARN: 'systemctl restart umbrella' failed — is the base unit installed? (RUNBOOK Prerequisites)"
say "drop-in installed; verify with: systemctl show umbrella -p Environment (NO ENABLE_AGENT_EXEC yet)"

# --- DONE (install). Surface the MANUAL Step 5 + the cutover boundary. ------------------
step "Install sequence complete (Steps 1-4 + 6)"
cat <<EOF

OPERATOR — two deliberate manual steps remain (NOT scripted, by design):

  1) Step 5 (Max-plan auth, HUMAN/interactive — see RUNBOOK.md):
       # install the real claude CLI to /usr/local/bin/claude (per its docs), then:
       sudo -u $AGENT_USER -H HTTPS_PROXY=http://127.0.0.1:3128 /usr/local/bin/claude auth login
     ^ completes the subscription login; the session lands under the agent's private HOME.
       The credential must NEVER reach a script, git, or the daemon/browser path.

  2) CUTOVER (later, signed-off): uncomment ENABLE_AGENT_EXEC=1 (and ENABLE_PROMOTE_TO_MAIN=1)
     in /etc/systemd/system/umbrella.service.d/agent.conf, then daemon-reload + restart.
     This provisioner NEVER flips those — that stays your deliberate step.

EOF

# --- Optional: prove the substrate actually isolates (refuse success if not) ------------
if [ "$VERIFY" -eq 1 ]; then
  step "Verification — conformance.sh (must PASS or this provisioner FAILS)"
  # conformance.sh exits non-zero on any failed isolation check; -e propagates it so we
  # do NOT claim success on a host where the sandbox doesn't actually hold.
  sudo bash "$TIER3/conformance.sh"
  say "CONFORMANCE PASSED — substrate isolation verified."
else
  say "Run with --verify to execute conformance.sh now, or: sudo bash $TIER3/conformance.sh"
fi

say "DONE."

# ponytail: delegates Step 1 to 01-provision-agent-user.sh and installs the other existing
# artifacts by path (no content duplication). Ceiling: host-specific paths (REPO, the
# /usr/bin/tinyproxy binary, the $APPARMOR_PROFILE name) are pinned at the top — edit there
# for a different distro/layout. Upgrade path: a small per-host vars file sourced here once
# >1 host layout exists.
#
# skipped: Step 5 (interactive Max-plan login) + the ENABLE_* cutover, by design — those are
#          deliberate human/signed-off steps; provisioner only readies the host.
# skipped: nft reboot-persistence wiring, add when the host's nftables include layout is known.
