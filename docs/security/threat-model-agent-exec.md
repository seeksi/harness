# Threat Model — agent execution (headless Claude Code build agent)

- Status: **DRAFT / OPEN** — this is the gate. `ENABLE_AGENT_EXEC` stays unset and the
  daemon does not spawn agents until this model is reviewed and the **Gate checklist
  (§6)** is fully satisfied and signed off (§7).
- Date: 2026-06-24
- Scope owner: security-engineer (operator). Reviewers: TBD.
- Depends on / sibling: [harness-bridge threat model](threat-model-harness-bridge.md)
  (AUTHORIZED) — reuse its provenance, audit, timeout-kill, and credential-isolation
  primitives.
- Subject code: `web/lib/daemon/agent-bridge.ts`, `web/lib/daemon/registry.ts`,
  `web/lib/daemon/daemon.ts` (future interleave), `.claude/skills/parallel-build/wt.sh`.

---

## 1. Why this exists

The build agent is **headless Claude Code** spawned in a lane's worktree to write
code — i.e. an autonomous process that runs arbitrary tools (Edit/Write/Bash). This
is categorically higher-risk than `harness.sh` (which runs a fixed set of git/python
commands): the agent's *purpose* is open-ended code execution. `agent-bridge.ts`
exists as the secure, default-OFF foundation; this document defines what must be true
before `ENABLE_AGENT_EXEC=1`.

## 2. Assets

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | The host beyond the lane worktree (FS, other lanes, the daemon, `deploy` user) | agent escape = compromise of the box |
| A2 | The Max-plan **session credential** on the VPS | the agent runs under it; exfiltration = account takeover |
| A3 | The git repo + `main` | the agent writes code; a poisoned commit can reach review/merge |
| A4 | Network egress | an agent (or injected prompt) could exfiltrate data or pull malware |
| A5 | The audit trail (`audit` table) | tampering hides what an agent did |
| A6 | Host resources (2 GB RAM, CPU, disk) | a runaway agent can exhaust them |

## 3. Trust boundaries & assumptions

- **TB-1 The agent is UNTRUSTED at runtime.** Even with a benign task, its outputs and
  tool calls are not trusted; treat it like running untrusted code.
- **TB-2 The task prompt is attacker-influenceable** (the brief flows toward it) →
  **prompt injection** is in scope: a crafted brief could steer the agent to exfiltrate
  or escape. Mitigations cannot assume a well-behaved prompt.
- **TB-3 The worktree is the agent's intended blast radius.** `cwd` = the lane worktree;
  the agent must not read/write outside it.
- **TB-4 Server is the sole credential holder** (inherited): `ANTHROPIC_API_KEY` deleted;
  the agent authenticates via the Max-plan subscription session, which must never reach
  the browser or the audit.
- **TB-5 Tailscale is the perimeter** (inherited, TB-1 of the harness model).

## 4. Data flow

```
daemon (live, gated) ── spawnAgent(spec) ──► claude -p <prompt> (shell:false, detached)
   server-built spec     cwd = validated worktree (under the worktrees allow-dir)
   slug minted (registry)  argv: -p, --output-format json, --model, --allowedTools
        │                          │  agent runs tools INSIDE the worktree
        │                          │  PostToolUse trace-log hook → worktree .claude/traces/<sid>.jsonl
        ▼                          ▼
   audit (argv summary + outcome + session id; NEVER prompt/token)   stdout JSON → session id
```

## 5. STRIDE analysis

Severity is residual after the *current* (foundation) mitigation. "Pre-enable" = must
exist before `ENABLE_AGENT_EXEC=1`.

| ID | Threat (STRIDE) | Vector | Current mitigation (in code) | Residual | Required before enable |
|----|-----------------|--------|------------------------------|----------|------------------------|
| G1 | **Elevation** — agent escapes the worktree | agent writes/reads outside `cwd`; unrestricted Bash | `cwd` = containment-checked worktree (minted lane's entry under a FIXED allow-dir, lexical + **realpath** symlink check); **exact** tool allowlist (no Bash, no predicates); `shell:false`; argv server-built | **High** (cwd ≠ FS jail) | Dedicated low-priv `agent` user (not `deploy`/root); FS perms confining it to the worktrees dir; a vetted Bash **command allowlist** only |
| G2 | **Spoofing/Tampering** — argv/path injection | client string becomes a path/flag/prompt-shell | server-built argv; slug minted (registry); worktree path resolved + asserted under the allow-dir; `shell:false` | Low | Keep specs server-built; never pass brief text as a flag/path |
| G3 | **Elevation via prompt injection** — hostile brief steers the agent | brief → task prompt → malicious tool use | tool allowlist limits reachable actions; worktree `cwd` limits scope | **High** | Tool allowlist + egress limit (G4) bound the damage; treat prompt as untrusted (TB-2); human review of agent output before merge/promote |
| G4 | **Information disclosure** — exfiltration via network | agent/prompt makes outbound requests | none yet | **High** | **Egress firewall**: agent user may reach only Anthropic API endpoints; deny all other outbound |
| G5 | **Information disclosure** — Max-plan session token leak | token in env/FS readable by agent or echoed to client | `ANTHROPIC_API_KEY` absent; agent child gets a **minimal env allowlist** (PATH/HOME/LANG only — the server's full env is never forwarded); session id captured is shape-validated; audit records argv summary only (never prompt/token); browser path guarded by `assertNoCredential` | Med | Store the session credential outside the agent user's readable FS; confirm it never enters the agent env/output |
| G6 | **Denial of service** — runaway agent | infinite tool loop; resource exhaustion | per-run timeout → SIGTERM→SIGKILL on the **process group**; stdout buffer capped; single slot | Med | Per-agent CPU/mem/disk limits (cgroup/ulimit); Gate D trajectory check (`trace`) catches loops |
| G7 | **Repudiation** — no record of what an agent did | — | append-only `audit` row per spawn (lane + model + session + outcome); the agent's own tool-trace via the PostToolUse hook | Low | Persist/collect the worktree trace into the run record |
| G8 | **Tampering** — poisoned code reaches `main` | agent writes malicious code that passes gates | cross-review gate (Gate B) + promote stays human-gated + ff-only (harness model T2) | Med | Human review of the diff before promote; promote stays default-off |
| G9 | **Supply chain** — agent installs malicious deps | agent runs a package manager | tool allowlist (no Bash by default) | Med | If Bash is allowed, restrict package installs; lockfile review |

## 6. Gate checklist — ALL required before `ENABLE_AGENT_EXEC=1`

- [x] G1 — agent runs as a **dedicated low-priv `agent` user** (uid 1001, nologin), FS-confined to the worktrees dir. _Provisioned + verified on the VPS (2026-06-24): sudoers grants `deploy` ONLY the pinned wrapper as `agent` NOPASSWD; worktrees `2775 agent:deploy`; `agent` cannot write the repo; `AGENT_USER`/`AGENT_CLI_PATH` in the systemd drop-in._
- [x] G1/G9 — tool allowlist finalized: **Bash OFF** (`Read,Edit,Write,Grep,Glob` only; council decision 1A) — the harness commits the lane (`wt-commit`), not the agent. **`--strict-mcp-config`** also passed so the agent loads **zero** MCP servers; verified live (no MCP connections, account connectors isolated).
- [x] G4 — **egress firewall**: agent egress default-DROP except a loopback FQDN-allowlist proxy (`api.anthropic.com`, `*.anthropic.com`, `*.claude.com` for OAuth) with an nft proxy-bypass backstop. Verified live: Anthropic established; DataDog telemetry + `example.com` refused; direct egress + DNS blocked.
- [x] G5 — Max-plan **session** under `/home/agent/.claude` (`700` / `.credentials.json 600`); no `ANTHROPIC_API_KEY`/secret in the agent env or audit; `instrumentation.ts` strips credentials at boot. Verified live.
- [x] G6 — per-agent **resource limits**: `systemd-run --user --scope` cgroup cap (MemoryMax=1500M, TasksMax=256, CPUQuota=180%) + ulimits (no `-v`) + `AGENT_TIMEOUT_MS`. Wrapper **fails closed** (`exit 78`) if the scope is unavailable. Verified live.
- [x] G6 — `harness.sh trace` (Gate D) wired to the agent's worktree trace so loops are caught. _(daemon `runLive` relocates the worktree trace + runs Gate D before merge.)_
- [x] G7 — worktree trace collected into the run/audit record. _(relocated to repo `.claude/traces`; symlink/size-hardened.)_
- [x] G8 — promote stays default-off (`ENABLE_PROMOTE_TO_MAIN` flag); **human diff review** before any agent-built code reaches `main` (operator reviews the diff at each run's promote step).
- [x] Max-plan auth set up on the VPS: `claude auth login` as `agent` (subscription session, no API key). A real inference was verified end-to-end through the full hardened path (sudo-drop → cgroup scope → proxy → `api.anthropic.com`).
- [x] This document reviewed and signed off (§7).

Until every box is checked: `ENABLE_AGENT_EXEC` stays unset; `spawnAgent` refuses to run.

## 7. Sign-off

| Role | Name | Verdict | Date |
|------|------|---------|------|
| Security review | Claude (cross-model gate, Claude × Codex) | PASS | 2026-06-24 |
| Operator | Peter Vance | APPROVED | 2026-06-24 |

**Decision:** AUTHORIZED. All §6 gate items are satisfied and verified on the live VPS
(`ubuntu-2gb-ash-1`) — including a real inference exercising the full hardened path. Live
agent execution (`ENABLE_AGENT_EXEC=1`) is authorized. First run enables agent exec and
watches one lane build → cross-review → merge; promote (`ENABLE_PROMOTE_TO_MAIN=1`) is a
deliberate human-diff-reviewed step (G8). Rollback = re-comment the flags + restart.

---

_skipped: per-lane container/nsjail isolation — operator chose hardened-host
(dedicated user + worktree + egress firewall + limits); add containerization if the
agent set grows or multi-tenant use appears._
