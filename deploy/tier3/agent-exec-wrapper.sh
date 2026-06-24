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
# — but still quote them in every systemd-run/ulimit arg (defence in depth; never let an
# unquoted value split an arg). An unset OR empty var falls back to the default, so the
# daemon can override per-run while the fail-safe default is the multi-lane-safe value.
#
# RAM SAFETY (#17 17b): the per-lane MemoryMax default is 500M, NOT the old 1.5G. On a
# 2 GB host the WORST CASE is LANE_CONCURRENCY concurrent agents each in their OWN per-USER
# cgroup scope (different uids → different cgroup subtrees → the scopes do NOT aggregate;
# see the harness.slice note at the bottom). So the only real aggregate control is
# arithmetic:  LANE_CONCURRENCY × per-lane MemoryMax ≤ ~1.6G (leave ~400M for the host +
# daemon). 500M × 3 lanes = 1.5G ≤ 1.6G. The operator MUST keep
#   LANE_CONCURRENCY ≤ floor(1.6G / per-lane MemoryMax)   (= 3 at the 500M default)
# This is documented in RUNBOOK.md (17c) and GAPS.md.
MEM="${SANDBOX_MEM_MAX:-500M}"
TASKS="${SANDBOX_TASKS_MAX:-256}"
CPU_QUOTA="${SANDBOX_CPU_QUOTA:-180%}"
CPU_SECONDS="${SANDBOX_CPU_SECONDS:-1500}"

# Optional system-level ceiling slice. `harness.slice` (a system slice with MemoryMax=1600M,
# installed by the 17b provisioner as a documented CEILING) is named here so the scope runs
# UNDER it. HONEST CAVEAT: `systemd-run --user --scope --slice=` places the scope in the
# invoking USER's slice subtree (user-<uid>.slice/…), so a slice referenced this way does
# NOT aggregate memory across DIFFERENT users — it is a per-user ceiling, not a host-wide
# one. We therefore do NOT rely on it for the cross-lane aggregate guarantee (the per-lane
# cap × concurrency bound above is the real control). It is wired as best-effort belt for
# the single-user (lane-0) case and as a forward hook. Unset HARNESS_SLICE to omit it.
HARNESS_SLICE="${HARNESS_SLICE:-harness.slice}"

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

# Build the optional --slice arg only when HARNESS_SLICE is non-empty. Per-user scopes do
# NOT aggregate across users (see note above), so this is a per-user ceiling/forward-hook,
# not the cross-lane guarantee — the per-lane MemoryMax + LANE_CONCURRENCY bound is that.
SLICE_ARG=()
[ -n "$HARNESS_SLICE" ] && SLICE_ARG=(--slice="$HARNESS_SLICE")

exec systemd-run --user --scope -q \
  "${SLICE_ARG[@]}" \
  -p MemoryMax="$MEM" \
  -p MemorySwapMax=0 \
  -p TasksMax="$TASKS" \
  -p CPUQuota="$CPU_QUOTA" \
  -- "$REAL_CLAUDE" "$@"

# ponytail: caps DEFAULT to the MULTI-LANE-SAFE 500M mem (no swap, 256 tasks, 1.8 CPU) and
# are overridden per-run by the validated SANDBOX_* env (lib/sandbox validateLimits). The
# real cross-lane RAM control is ARITHMETIC: LANE_CONCURRENCY × per-lane MemoryMax ≤ ~1.6G
# (= 3 lanes at 500M on a 2 GB host), enforced by the operator bound, NOT by a slice.
# Ceiling: `harness.slice` is wired (--slice=) but `systemd-run --user --scope` places the
# scope in the INVOKING USER's slice subtree, so it does NOT aggregate across distinct lane
# uids — it is a per-user ceiling/forward-hook only, not a host-wide guarantee. Upgrade
# path for a true host-wide aggregate: run the scopes as SYSTEM scopes under one shared
# system slice (needs a privileged transient-unit path, e.g. `systemd-run --scope
# --slice=harness.slice` via a root helper), or move lanes into one container/pod with a
# shared memory cgroup.
#
# skipped: seccomp/landlock FS pinning, add if worktree-confinement needs kernel enforcement.
# skipped: true host-wide aggregate RAM cap (system-slice scopes), add if the per-lane-cap ×
#          concurrency-bound proves insufficient under real concurrent load.
