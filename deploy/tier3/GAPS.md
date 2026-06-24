# Tier-3 GAPS — security-engineer self-review of this draft

Reviewing `deploy/tier3/*` against the §6 gate checklist in
`docs/security/threat-model-agent-exec.md`. Honest status, residual risk, and the
decisions the operator/council must make BEFORE cutover.

Legend: **covered** (artifact + verify) · **partial** (works, real ceiling) ·
**operator-action** (manual, documented not scripted) · **OPEN** (needs a decision).

| §6 item | Status | Artifact | Residual risk |
|---|---|---|---|
| **G1** dedicated low-priv `agent` user, FS-confined to worktrees | covered | `01-provision-agent-user.sh`, `sudoers.d-umbrella-agent` | single-lane: worktree is deploy-owned, ACL-granted to `agent`. |
| **G1 multi-lane** per-lane uid isolation (#17 17b) | covered (17b) | `01b-provision-lane-users.sh` (pool `agent-1..N-1`), `sudoers.d-umbrella-agent` (Runas pool), 17a `wt-new` ACL, `conformance-multilane.sh` | each lane = distinct nologin uid + private 0700 HOME + its own ACL-granted worktree; cross-lane ACL isolation PROVEN by `conformance-multilane.sh` (sibling denied; agent-created file not sibling-readable — default-ACL leak closed). Residual: root can read all (single host). |
| **G1/G9** tool allowlist (Bash off vs vetted command allowlist) | **OPEN** | code default `Read,Edit,Write,Grep,Glob` | **DECISION REQUIRED — see below.** Code ships no-Bash; whether the lane-builder can do real work without Bash is unproven. |
| **G4** egress — agent reaches only Anthropic API | covered (council 2B: FQDN proxy) | `egress-proxy/` (tinyproxy unit + conf + filter) + `agent-egress.nft` backstop | proxy filters on the CONNECT host line, not TLS SNI (no MITM/cert check); a client lying about the host is still bounded because nft pins egress to the proxy and the proxy dials the real allowlisted name. Proxy uid holds broad egress to `*.anthropic.com`. |
| **G5** session outside others-readable FS; absent from env/audit/browser | covered (code) + operator-action (login) | provision (HOME 0700), RUNBOOK Step 5/7 | session sits in `agent`'s own HOME; root can still read it (unavoidable on a single host). Login is manual by design. |
| **G6** per-agent resource limits (cpu/mem/disk/pids) | covered (council 3B: cgroup scope) | `agent-exec-wrapper.sh` (systemd-run --user --scope MemoryMax/MemorySwapMax/TasksMax/CPUQuota) + ulimits + `AGENT_TIMEOUT_MS` | per-INVOCATION scope. Per-lane MemoryMax default LOWERED to 500M (17b) so concurrency fits 2 GB. Fail-closed if the user scope is unavailable. |
| **G6 multi-lane** aggregate RAM across concurrent lanes (#17 17b) | partial (arithmetic bound, NOT a slice) | `agent-exec-wrapper.sh` (500M default + `harness.slice` hook), RUNBOOK 17c | HONEST FINDING: `systemd-run --user --scope --slice=` places the scope in the INVOKING USER's slice subtree, so it does NOT aggregate memory across DISTINCT lane uids — a per-user `harness.slice` is a per-user ceiling/forward-hook, not a host-wide guarantee. The REAL control is arithmetic: `LANE_CONCURRENCY ≤ floor(1.6G / per-lane MemoryMax)` (= 3 at 500M on 2 GB), enforced by the operator bound. True host-wide aggregate needs SYSTEM-scope-under-one-slice (root helper) or a shared-cgroup container — deferred. |
| **G6** trace gate (Gate D) wired | covered (code) | daemon `runLive` relocates trace + runs `trace` | none new — already authorized in code. |
| **G7** trace collected into run record | covered (code) | `relocateTrace` (symlink/size-hardened) | none new. |
| **G8** promote default-off + human diff review | covered | `umbrella-agent.conf` (flag commented), RUNBOOK cutover/rollback | relies on a human actually reading the diff; no automated poison-code detection beyond cross-review (Gate B). |
| **Max-plan auth** on the VPS (no API key) | operator-action | RUNBOOK Step 5 | manual interactive login; if it ever expires the agent fails closed (refused), not insecure. |
| **§7 sign-off** | **OPEN** | threat model §7 table still `_open_` | must be recorded before flipping `ENABLE_AGENT_EXEC`. |

## Decisions the operator / council must resolve before cutover

### 1. G1/G9 — the Claude Code TOOL ALLOWLIST (the load-bearing OPEN item)
`agent-bridge.ts` hard-codes `ALLOWED_TOOLS = {Read, Edit, Write, Grep, Glob}` and
`DEFAULT_TOOLS` is the same set — **Bash is NOT reachable** and the daemon never passes
a different allowlist (`planRun` sets no `allowedTools`, so the default applies). So as
shipped, the lane-builder agent can read/search/edit/write files but **cannot run any
command** — no `git commit`, no test run, no `npm`, no build.

This directly collides with the pipeline: `planRun` appends *"When your changes are
complete, commit them to the current branch."* and Gate B (`wt-verify`) FAILS the lane
unless it is committed + clean. **Without Bash the agent cannot commit, so every lane
fails Gate B.** This must be decided, not assumed:

- **Option A — Bash OFF (status quo).** Safest. Then the COMMIT must be done by the
  daemon/harness, not the agent (e.g. `wt-verify` or a new harness step commits the
  worktree after the agent returns). Requires a small code change outside this draft.
- **Option B — vetted Bash command allowlist.** Add `Bash` to `ALLOWED_TOOLS` AND
  configure Claude Code's permission rules so only specific commands run (e.g. allow
  `git add/commit/status/diff`, the project test cmd; DENY `curl/wget/ssh/npm install/
  pip/rm -rf/sudo`). This is a Claude Code settings + allowlist design task. Egress
  firewall (G4) is the backstop if the allowlist leaks.
- **Option C — full Bash.** Rejected — defeats G1/G3/G9; do not.

Recommendation: **Option A for first cutover** (no Bash; daemon does the commit), revisit
Option B once a curated git+test command allowlist is written and reviewed. Either way
this is a code/config decision the operator must sign off — the draft cannot pick it
unilaterally because it changes the daemon contract.

### 2. Multi-lane concurrency (`LANE_CONCURRENCY > 1`) — per-lane isolation NOW LANDED (17a+17b)
The daemon's build phase (`daemon.ts` `runLive`) can run N lane agents concurrently
(capped by `LANE_CONCURRENCY`); prod **default stays 1** until 17c validates on the host.
The three cross-review BLOCKERS are now addressed:
- **per-lane OS user + private HOME** — DONE (17b `01b-provision-lane-users.sh`: `agent-1..`
  nologin users, 0700 HOME for an own `~/.claude`); lane-to-lane FS isolation via 17a's
  per-lane ACL on a deploy-owned worktree (sibling denied, default-ACL leak closed) — PROVEN
  by `conformance-multilane.sh`.
- **aggregate RAM** — addressed by the per-lane MemoryMax default LOWERED to 500M + the
  operator bound `LANE_CONCURRENCY ≤ floor(1.6G / per-lane MemoryMax)` (= 3 on 2 GB). Honest:
  a per-user `harness.slice` does NOT give a host-wide aggregate (see G6-multilane row);
  the arithmetic bound is the real control.
- **tinyproxy `MaxClients`** — already `20` in `egress-proxy/tinyproxy.conf`, well above any
  RAM-bounded `LANE_CONCURRENCY` (≤3) × a few connections each; no change needed. Revisit only
  if the per-lane cap is dropped to allow many more lanes.

17c (RUNBOOK "MULTI-LANE CUTOVER") is the remaining operator sequence: provision pool →
bootstrap each user's Max-plan session → run `conformance-multilane.sh` → set
`LANE_CONCURRENCY` within the RAM bound. The asyncPool + phased-merge machinery is correct
and unchanged; only the prod default remains constrained until 17c validates.

## Resolved by council (this revision)

### G4 — egress: RESOLVED via FQDN proxy (council 2B)
The brittle Anthropic-CIDR nft pin is REPLACED by a loopback FQDN-allowlisting forward
proxy (`egress-proxy/`, tinyproxy): the agent's `HTTPS_PROXY` points at `127.0.0.1:3128`
(set in the wrapper), the proxy allows CONNECT only to `api.anthropic.com` / `*.anthropic.com`
on :443 (`FilterDefaultDeny Yes`), and `agent-egress.nft` is rewritten as a BACKSTOP that
default-DROPs all direct agent egress (incl. DNS) so the proxy can't be bypassed. Trust
model: proxy = the allowlist; nft = bypass-prevention. Remaining choice for the operator:
whether the proxy hostname allowlist may include telemetry hosts (kept DENIED by default —
prefer disabling CLI telemetry over widening). Residual: no SNI/cert inspection (see table).

### G6 — resource limits: RESOLVED via cgroup scope (council 3B)
ulimits are KEPT (per-process belt) AND the wrapper now launches claude inside a transient
cgroup scope (`systemd-run --user --scope` with MemoryMax=1500M, MemorySwapMax=0,
TasksMax=256, CPUQuota=180%) for an AGGREGATE cap. Provision enables `loginctl
enable-linger agent` so the agent has a persistent user manager + `/run/user/<uid>`. If the
user scope is unavailable the wrapper EXITS 78 and never runs claude uncapped (fail-closed),
verified in RUNBOOK Step 2.

## Things explicitly NOT done here (scope)
- No code changes to `agent-bridge.ts` / `daemon.ts` (the commit-without-Bash gap in
  Decision 1 is surfaced, not fixed — it needs operator sign-off on approach).
- No containerization (operator already chose hardened-host in the threat model §107).
- Nothing executed on the VPS; nothing committed.

skipped: SNI-aware egress inspection, add if the allowlist must bind to TLS SNI not the CONNECT host.
skipped: true host-wide aggregate RAM cap (system-scope under one slice / shared-cgroup container), add if the per-lane-cap × concurrency-bound proves insufficient under load.
