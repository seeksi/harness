# Tier-3 GAPS — security-engineer self-review of this draft

Reviewing `deploy/tier3/*` against the §6 gate checklist in
`docs/security/threat-model-agent-exec.md`. Honest status, residual risk, and the
decisions the operator/council must make BEFORE cutover.

Legend: **covered** (artifact + verify) · **partial** (works, real ceiling) ·
**operator-action** (manual, documented not scripted) · **OPEN** (needs a decision).

| §6 item | Status | Artifact | Residual risk |
|---|---|---|---|
| **G1** dedicated low-priv `agent` user, FS-confined to worktrees | covered | `01-provision-agent-user.sh`, `sudoers.d-umbrella-agent` | worktrees dir is shared `agent:deploy` (2775) — lanes are not isolated from each other or from deploy. Per-lane 0700 is the upgrade. |
| **G1/G9** tool allowlist (Bash off vs vetted command allowlist) | **OPEN** | code default `Read,Edit,Write,Grep,Glob` | **DECISION REQUIRED — see below.** Code ships no-Bash; whether the lane-builder can do real work without Bash is unproven. |
| **G4** egress — agent reaches only Anthropic API | covered (council 2B: FQDN proxy) | `egress-proxy/` (tinyproxy unit + conf + filter) + `agent-egress.nft` backstop | proxy filters on the CONNECT host line, not TLS SNI (no MITM/cert check); a client lying about the host is still bounded because nft pins egress to the proxy and the proxy dials the real allowlisted name. Proxy uid holds broad egress to `*.anthropic.com`. |
| **G5** session outside others-readable FS; absent from env/audit/browser | covered (code) + operator-action (login) | provision (HOME 0700), RUNBOOK Step 5/7 | session sits in `agent`'s own HOME; root can still read it (unavoidable on a single host). Login is manual by design. |
| **G6** per-agent resource limits (cpu/mem/disk/pids) | covered (council 3B: cgroup scope) | `agent-exec-wrapper.sh` (systemd-run --user --scope MemoryMax/MemorySwapMax/TasksMax/CPUQuota) + ulimits + `AGENT_TIMEOUT_MS` | aggregate cap is per-INVOCATION scope; daemon is single-slot so one agent at a time, but concurrent lanes (future) would each get a scope and share host RAM — a parent slice is the upgrade. Fail-closed if the user scope is unavailable. |
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

### 2. Multi-lane concurrency (`LANE_CONCURRENCY > 1`) — gated on per-lane isolation
The daemon's build phase (`daemon.ts` `runLive`) can run N lane agents concurrently
(capped by `LANE_CONCURRENCY`), but the prod **default is 1 (sequential)** and must stay
there until per-lane isolation lands. Raising it above 1 on the current single-uid host is
**BLOCKED by cross-review**: all lanes share one `agent` uid + one `~/.claude`
session/cache (concurrent writers corrupt it), the same uid can write sibling worktrees
(no lane-to-lane FS isolation — see G1), and N×MemoryMax (1500M) exceeds host RAM (the
cgroup cap is per-invocation, not aggregate — see G6).

`LANE_CONCURRENCY > 1` REQUIRES, before it is enabled:
- a **per-lane OS user + HOME** (or a userns/landlock jail per lane) so each agent has its
  own `~/.claude` session/cache and cannot write another lane's worktree;
- a **parent `umbrella-agent.slice` aggregate cgroup cap** so N concurrent scopes share a
  host-wide `MemoryMax` (N×per-lane MemoryMax must not exceed host RAM);
- **raised tinyproxy `MaxClients`** so N simultaneous agents aren't throttled at the egress
  proxy.

Until then prod runs sequentially (default 1). The asyncPool + phased-merge machinery is
correct and stays; only the default is constrained.

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

skipped: per-lane FS isolation (per-lane user+HOME / userns), add to unblock LANE_CONCURRENCY>1 (Decision 2).
skipped: SNI-aware egress inspection, add if the allowlist must bind to TLS SNI not the CONNECT host.
skipped: parent umbrella-agent.slice (host-wide MemoryMax) + raised tinyproxy MaxClients, add to unblock LANE_CONCURRENCY>1 (Decision 2).
