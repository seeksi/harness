#!/usr/bin/env bash
# Tier-3 / G6 — agent-exec wrapper. AGENT_CLI_PATH points HERE (not at `claude`).
#
# Why a wrapper: agent-bridge.ts invokes `sudo -n -H -u agent -- $AGENT_CLI_PATH <args>`.
# By making AGENT_CLI_PATH this script we get a hook that runs AS the agent user, where
# we (a) apply per-process ulimit caps, (b) launch the real claude inside a transient
# cgroup SCOPE for AGGREGATE memory/pid/cpu caps, and (c) force egress through the
# loopback FQDN proxy. shell:false upstream still holds — this script is the single argv0
# the sudoers rule whitelists.
#
# Install path: /opt/umbrella/deploy/agent-exec-wrapper.sh  (root-owned, 0755, NOT
# agent-writable — the agent must never be able to edit its own limits/target/proxy).
#   DRAFT FOR REVIEW — do NOT run until sign-off (see RUNBOOK.md).
set -euo pipefail

# Absolute path to the REAL claude binary, installed during the Max-plan auth step
# (RUNBOOK §Max-plan auth). Pin it absolutely — do not rely on PATH.
#   Verify with: sudo -u agent -H bash -lc 'command -v claude'
REAL_CLAUDE="${REAL_CLAUDE:-/usr/local/bin/claude}"

# Loopback FQDN egress proxy (G4). The claude CLI must reach the Anthropic API ONLY via
# this proxy; nft (agent-egress.nft) drops any direct agent egress, so this is mandatory.
PROXY_PORT="${PROXY_PORT:-3128}"
PROXY_URL="http://127.0.0.1:${PROXY_PORT}"

# --- G6 resource caps from the validated SANDBOX_* contract ----------------------------
# lib/sandbox `validateLimits` already shape-checks + bounds these (MemoryMax/CPUQuota
# regex `^\d+[KMGT]?$|^\d+%$`, TasksMax/CPUSeconds positive ints) and they survive sudo
# env_reset via the sudoers `env_keep`. So we TRUST the shape and only DEFAULT-when-empty
# to the historical 2 GB-host values — but still quote them in every systemd-run/ulimit
# arg (defence in depth; never let an unquoted value split an arg). An unset OR empty var
# falls back to the default, so today's behavior is unchanged when the daemon sends none.
MEM="${SANDBOX_MEM_MAX:-1500M}"
TASKS="${SANDBOX_TASKS_MAX:-256}"
CPU_QUOTA="${SANDBOX_CPU_QUOTA:-180%}"
CPU_SECONDS="${SANDBOX_CPU_SECONDS:-1500}"

# --- G4 egress: route all CLI HTTP(S) through the loopback FQDN proxy -----------------
# The proxy holds the FQDN allowlist (api.anthropic.com …); nft prevents bypass.
export HTTPS_PROXY="$PROXY_URL" https_proxy="$PROXY_URL"
export HTTP_PROXY="$PROXY_URL"  http_proxy="$PROXY_URL"
export NO_PROXY="" no_proxy=""   # nothing bypasses the proxy

# --- G6 per-process ulimit caps (belt; the agent cannot raise them) -------------------
# NOTE: do NOT cap virtual address space (`ulimit -v`). Node/V8 RESERVES many GB of
# virtual memory at startup regardless of actual RSS, so a -v cap makes claude SIGABRT
# (exit 134, core dumped) before it runs. Real memory is capped by the cgroup MemoryMax
# in the systemd-run scope below — that is the correct knob, not ulimit -v.
ulimit -u 256              # max user processes (fork-bomb guard) for the agent uid
ulimit -t "$CPU_SECONDS"   # CPU seconds (default 1500 ≈ 25 min) — pairs with AGENT_TIMEOUT_MS wall clock
ulimit -f 1048576     # max file size (KB) = 1 GB — caps disk write per file
ulimit -c 0           # no core dumps (could contain session material)

if [ ! -x "$REAL_CLAUDE" ]; then
  echo "agent-exec-wrapper: real claude not found/executable at $REAL_CLAUDE" >&2
  exit 127
fi

# --- G6 aggregate caps via a transient cgroup scope (braces) --------------------------
# `systemd-run --user --scope` puts the WHOLE claude process tree in one cgroup with an
# AGGREGATE memory/pid/cpu ceiling — closing the gap ulimit leaves (ulimit is per-proc).
# Requires the agent's user manager + XDG_RUNTIME_DIR (provision enables linger).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# FAIL CLOSED: if the user-scope mechanism is unavailable, DIE — never run claude
# uncapped. Probe with a trivial scope; only exec the real run if all checks pass.
if ! command -v systemd-run >/dev/null 2>&1; then
  echo "agent-exec-wrapper: systemd-run missing — refusing to run claude uncapped (G6)" >&2
  exit 78  # EX_CONFIG
fi
if [ ! -d "$XDG_RUNTIME_DIR" ]; then
  echo "agent-exec-wrapper: no XDG_RUNTIME_DIR ($XDG_RUNTIME_DIR) — user manager not running; is linger enabled? Refusing (G6)" >&2
  exit 78
fi
if ! systemd-run --user --scope -q -- true >/dev/null 2>&1; then
  echo "agent-exec-wrapper: 'systemd-run --user --scope' unavailable — refusing to run claude uncapped (G6)" >&2
  exit 78
fi

exec systemd-run --user --scope -q \
  -p MemoryMax="$MEM" \
  -p MemorySwapMax=0 \
  -p TasksMax="$TASKS" \
  -p CPUQuota="$CPU_QUOTA" \
  -- "$REAL_CLAUDE" "$@"

# ponytail: caps DEFAULT to the 2 GB host values (1.5 G mem, no swap, 256 tasks, 1.8 CPU)
# and are overridden per-run by the validated SANDBOX_* env (lib/sandbox validateLimits).
# Ceiling: one shared scope per invocation; concurrent lanes (none today — daemon is
# single-slot) would each get their own scope but share host RAM. Upgrade path: a parent
# slice (umbrella-agent.slice) with a host-wide MemoryMax so concurrent agents can't
# collectively exhaust RAM.
#
# skipped: seccomp/landlock FS pinning, add if worktree-confinement needs kernel enforcement.
# skipped: parent slice host cap, add when >1 concurrent agent lane is introduced.
