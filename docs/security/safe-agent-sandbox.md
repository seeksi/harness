# Safe Agent Sandbox — substrate threat model

Consolidated threat model for the **extracted** safe-agent-sandbox substrate
(`web/lib/sandbox/`, `deploy/tier3/`). This is the single reference for the substrate as a
reusable unit; it CITES rather than duplicates the two prior models:

- [threat-model-agent-exec.md](threat-model-agent-exec.md) — AUTHORIZED (2026-06-24). The
  gate that defines the §6 G1–G9 checklist this substrate satisfies.
- [threat-model-harness-bridge.md](threat-model-harness-bridge.md) — AUTHORIZED
  (2026-06-24). Source of the inherited provenance / audit / timeout-kill / credential-
  isolation primitives the sandbox reuses.

- Status: substrate of an AUTHORIZED capability; the live gate stays
  `ENABLE_AGENT_EXEC` (default off).
- Subject code: `web/lib/sandbox/{agent-runner,worktree,index}.ts`,
  `deploy/tier3/*` (provisioner, wrapper, sudoers, egress proxy, nft, drop-in,
  conformance).

---

## 1. Trust boundary

**Untrusted autonomous agent ⟂ trusted daemon.** The headless Claude Code build agent is
an autonomous process that runs tools to write code — its *purpose* is open-ended
execution, so it is treated as untrusted code at runtime (agent-exec TB-1). The brief
flows toward its prompt, so **prompt injection is in scope** (TB-2): mitigations may not
assume a well-behaved prompt. The daemon (`deploy` user) is trusted and is the sole
credential holder; it builds the agent invocation, but everything the agent then does is
across the boundary. The agent's intended blast radius is **one lane worktree** (TB-3).

```
TRUSTED daemon (deploy)                    │  UNTRUSTED agent (agent uid)
  runAgentInSandbox(opts)  ── builds ──►   │   claude -p <prompt>  (shell:false, no Bash,
  server-minted slug + validated argv      │     zero MCP, minimal env, cwd=worktree)
  privilege drop via sudo -u agent  ───────┼──►  runs tools INSIDE the worktree only
  audit: lane/model/session/outcome        │     egress ONLY via loopback FQDN proxy
                                           │     cgroup + ulimit caps; killed on timeout
```

## 2. Guarantees

Defence in depth — each is independently enforced, so one failing does not collapse the box.

| # | Guarantee | Where enforced |
|---|-----------|----------------|
| Privilege drop | Agent runs as a dedicated low-priv `agent` OS account (nologin, not `deploy`/root) via `sudo -n -H -u agent`; sudo `env_reset` drops the daemon env two ways over. | `buildInvocation` + `sudoers.d-umbrella-agent` + `01-provision-agent-user.sh` |
| FS confinement | `cwd` = a containment-checked worktree (lexical + realpath symlink check) under a fixed allow-dir; the agent's only writable area is the worktrees dir; repo stays read-only to agent. | `worktree.ts` (`containedWorktree`) + provision perms |
| FQDN egress + nft backstop | All CLI HTTP(S) forced through a loopback FQDN-allowlist proxy (`api.anthropic.com`/`*.anthropic.com`); nft default-DROPs all direct agent egress incl. DNS, so the proxy is the only way out. | wrapper proxy env + `egress-proxy/` (tinyproxy) + `agent-egress.nft` |
| Zero MCP | `--strict-mcp-config` with no `--mcp-config` ⇒ claude loads ZERO MCP servers (account/global/project connectors all ignored). | `buildAgentArgs` |
| Credential isolation | No `ANTHROPIC_API_KEY`; Max-plan session lives only under the agent's own `0700` HOME; minimal env allowlist (PATH/HOME/LANG + SANDBOX_*); audit carries no prompt/token. | `agentEnv` + `buildInvocation` + provision (HOME 0700) |
| cgroup / ulimit limits | `systemd-run --user --scope` aggregate cap (MemoryMax / MemorySwapMax / TasksMax / CPUQuota) + per-process ulimits (no `-v`); **fails closed (exit 78)** if the scope is unavailable. | `agent-exec-wrapper.sh` |
| Default-off gate | `spawnAgent` refuses unless `ENABLE_AGENT_EXEC=1`; promote stays behind `ENABLE_PROMOTE_TO_MAIN` + human diff review. | `agent-runner.ts` + `umbrella-agent.conf` |
| Audit | Append-only row per run: `lane / model / session / outcome` — never the prompt or token; plus the agent's PostToolUse trace collected into the run record. | `spawnAgent` (`appendAudit`) + `relocateTrace` |

## 3. Interface — `runAgentInSandbox` + resourceLimits

The substrate's single public entrypoint (`web/lib/sandbox/index.ts`):

```ts
runAgentInSandbox({
  prompt: string,                 // opaque task brief — never audited/logged
  cwd: string,                    // absolute lane worktree (containment-validated)
  sessionId?: string,            // server-minted lane slug (provenance + audit `lane:`)
  model?: "haiku" | "sonnet" | "opus",
  allowedTools?: string[],       // validated against the exact allowlist (Bash unreachable)
  resourceLimits?: ResourceLimits,
}): Promise<{ exitCode, sessionId, usage, audit }>
```

`ResourceLimits` is validated + bounded by `validateLimits` (fail-closed) BEFORE it can
reach a shell-interpolated context, then plumbed to the OS-level wrapper as `SANDBOX_*`
env vars:

| field | regex / bound | env var | wrapper applies |
|-------|---------------|---------|------------------|
| `memoryMax` | `^\d+[KMGT]?$\|^\d+%$` | `SANDBOX_MEM_MAX` | `systemd-run -p MemoryMax=` |
| `tasksMax` | positive int ≤ 4096 | `SANDBOX_TASKS_MAX` | `systemd-run -p TasksMax=` |
| `cpuQuota` | `^\d+%$` | `SANDBOX_CPU_QUOTA` | `systemd-run -p CPUQuota=` |
| `cpuSeconds` | positive int ≤ 3600 | `SANDBOX_CPU_SECONDS` | `ulimit -t` |
| `wallMs` | positive int ≤ 3_600_000 | (in-process) | spawn timeout → SIGTERM/SIGKILL |

Any unset field leaves the wrapper on its historical default (MemoryMax=1500M,
TasksMax=256, CPUQuota=180%, ulimit -t 1500), so the TS validates+bounds and the wrapper
trusts the shape but still quotes every value into the systemd-run/ulimit args (defence in
depth). The wrapper is root-owned `0755` so the agent can never rewrite its own caps.

## 4. Guarantee → conformance check

`deploy/tier3/conformance.sh` is the load-bearing proof that the guarantees actually HOLD
on the provisioned host (a threat model is only as good as its test). Run as `deploy`;
exit 0 iff every check passes.

| Guarantee | conformance.sh check |
|-----------|----------------------|
| Privilege drop | `agent uid != 0` (G1) |
| FS confinement | `agent CANNOT write the repo`; `worktrees parent owned by deploy/root` (G1) |
| Credential isolation | `no API key / credential-named var in the agent env` (G5) |
| FQDN egress (allow) | `agent → Anthropic via proxy connects` (G4) |
| FQDN egress (deny) | `proxy denies non-Anthropic host` (G4) |
| nft backstop | `nft blocks direct agent egress`; `agent cannot resolve DNS directly`; `deploy egress unaffected` (G4) |
| cgroup / ulimit + fail-closed | `wrapper is root-owned`; `wrapper FAILS CLOSED (exit 78)` when the scope is unavailable (G6) |
| Zero MCP + tool allowlist | `Bash is NOT in the allowlist`; `MCP strict, zero servers` via `/api/agent/capabilities` (G1/G9) |
| Default-off gate / Audit | enforced in code + asserted by the daemon/sandbox unit tests (`lib/sandbox`, `lib/daemon`) |

The provisioner (`provision.sh --verify`) runs this suite at the end and refuses to claim
success if any check fails.

## 5. Residual risks

Carried forward from [GAPS.md](../../deploy/tier3/GAPS.md); none block the authorized gate
but each is a known ceiling with a stated upgrade path:

- **Per-lane FS isolation.** The worktrees dir is shared `agent:deploy` (2775); lanes are
  agent-owned but not mode-0700 from each other. One agent at a time today (single-slot
  daemon). Upgrade: per-lane `0700` subdirs / bind-mounts / containers when concurrent or
  multi-tenant lanes appear (relevant to task #16, the multi-lane factory).
- **SNI-vs-CONNECT proxy filtering.** The proxy filters on the CONNECT host line, not TLS
  SNI (no MITM/cert inspection). Bounded because nft pins egress to the proxy and the proxy
  dials the real allowlisted name. Upgrade: SNI-aware inspection if the allowlist must bind
  to TLS SNI.
- **Single shared proxy.** One `tinyproxy-agent` uid holds broad egress to `*.anthropic.com`
  (A2/A4 surface if compromised). Upgrade: per-lane proxy instances, or move the allowlist
  into nft + SNI so no proxy uid holds broad egress.
- **Aggregate cap is per-invocation.** Concurrent lanes would each get their own scope but
  share host RAM. Upgrade: a parent `umbrella-agent.slice` with a host-wide MemoryMax.
- **Poisoned code reaching `main`.** Mitigated by cross-review (Gate B) + human diff review
  at promote (G8); no automated poison detection beyond that.

skipped: per-lane container/nsjail isolation, add if the agent set grows or multi-tenant use appears.
skipped: SNI-aware egress, add when the allowlist must bind to TLS SNI not the CONNECT host.
