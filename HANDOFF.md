# HANDOFF — GANTRY (harness dashboard + live build-agent) — 2026-07-07

> Resume context. The product/dashboard is named **GANTRY** (operator-picked
> 2026-07-06; UI rebranded 2026-07-07). Open this + NOTES.md + memory
> (agent-exec-gate, umbrella-vps-deploy) to continue. Repo: /home/alter/HARNESS,
> branch `main`.

## Where things stand (all on `main`, pushed to origin through ea03823, 2026-07-07)

DONE + verified:
- **Dashboard rebuild** (`console/` Next.js 16 app) shipped: fleet home, `/run/[id]`,
  `/deck`, `/graph/[projectId]`, launch console, ⌘K palette, ntfy, chime, `/brand`.
  Industrial-CRT identity (graphite + amber phosphor, green=live only). 351 tests green.
- **Live build-agent executor** wired + cross-reviewed + **live-verified end-to-end**:
  agent→wt-commit→Gate B→Gate D(trace)→Gate C (merge to integration), `main` untouched
  (promote gated). See memory [[agent-exec-gate]].
- **Isolated per-lane agent HOMEs** (`~/.gantry/agent-homes/<slug>`, provisioned per
  spawn, reclaimed per run) + **multi-lane concurrency** (1..4 lanes per run,
  `LANE_CONCURRENCY` clamp, finalize-ALL→merge-ALL, 2-lane live smoke PASS).
- **`gantry` CLI** (`bin/gantry` run/up/status, zero-dep Node ≥18 over the console API)
  + **install.sh** symlink install — cross-review PASS, live-verified twice.
- **GANTRY rebrand** in the UI (wordmark, tab title, /brand marks the pick).
- Sandbox: `console/lib/sandbox/{agent-runner,worktree,agent-home}.ts`. Wired in
  `console/lib/server/daemon.ts` (agent between wt-new and wt-commit + trace/Gate-D step).
- Posture (operator-approved): DIRECT mode (agent runs as operator), FULL toolset incl.
  Bash, zero-MCP, credential-free env, worktree-cwd, timeout, audit. Gates:
  `ENABLE_AGENT_EXEC=1` + `AGENT_ALLOW_DIRECT=1`.

## To run GANTRY live (proven working)
Easiest (2026-07-07): `gantry up` (live env owned by the CLI), `gantry run "<brief>"`,
`gantry status`. Manual equivalent:
```
cd /home/alter/HARNESS/console && npm run build
ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1 HARNESS_LIVE=1 \
  AGENT_CLI_PATH=/home/alter/.local/bin/claude \
  CONSOLE_BASE_URL=http://127.0.0.1:3000 HARNESS_REPO=/home/alter/HARNESS \
  npx next start -H 127.0.0.1 -p 3000        # or -H 100.72.193.64 for tailnet
```
Two operational must-haves the live smoke exposed (see [[agent-exec-gate]]):
`AGENT_CLI_PATH` must be the ABSOLUTE claude binary (minimal PATH doesn't find it);
`buildAgentArgs` passes `--dangerously-skip-permissions` (headless agent has no
approver → without it, plan mode → no work).
NOTE (2026-07-07): do NOT set `AGENT_HOME` anymore — unset, each lane's agent gets an
ISOLATED minimal HOME at `~/.gantry/agent-homes/<lane-slug>` (AGENT_ISOLATED_HOME overrides
the BASE dir) provisioned per spawn with only the Max-plan credential + a git identity, and
reclaimed at end of run. `AGENT_HOME=<path>` remains the explicit legacy override (agent
uses exactly that home, no provisioning). Multi-lane: pass
`lanes:["brief1","brief2"]` (1..4) to POST /api/runs and set `LANE_CONCURRENCY=2..4` for
overlapping builds (default 1 = sequential; VPS drop mode needs agent-N accounts first).

## NEXT-PASS AGENDA (what to build after /clear)

1. **Decompose agent** — DONE 2026-07-07 (harness batch, 3 lanes, promoted 2c900fb).
   `console/lib/sandbox/decompose.ts` `decomposeBrief()`: READ-ONLY headless claude
   (Read/Grep/Glob, zero-MCP, isolated home, audit, timeout) splits one brief into 1..4
   file-disjoint lane briefs before planRun; fail-closed validation (owns caps 32×256,
   prefix-disjointness, ≤4000 composed briefs, agent-content-free errors). Surfaces:
   POST /api/runs `decompose:true` (XOR lanes), `gantry run --decompose`, LaunchConsole
   toggle. Follow-ups: decompose-split approval flow (PhasePayload kind exists, unused);
   live smoke of a real decomposed run.
2. **Console handoff-respawn loop** — port web/ daemon's context-guard respawn
   (HANDOFF.md existence + exit 0 ⇒ respawn, cap 2, archive HANDOFF.<n>.md) into
   console runAgentInSandbox; needs the handoffFs seam web/lib/daemon/daemon.ts has.
3. **Per-lane model routing** — route-cost tier per lane instead of run-global model.
4. **CLI tests** (accepted Medium at gantry-cli merge) — bin/gantry parser + API client
   against a mock server; install.sh shell asserts (fake-HOME cases from 2026-07-07).
5. **Operator DoD leftovers** (dashboard rebuild) — phone approve over tailnet, ntfy
   tap deep-link, /graph showpiece capture. (Live run e2e: done repeatedly.)
6. **VPS drop-mode track** (when wanted) — agent Max-plan login, egress firewall,
   resource limits, agent-N accounts for multi-lane, threat-model §7 sign-off.

Low/background: haiku alias quirk; gantry SSE reconnect if runs get long; agent-home
hardening notes (git-identity cache, openat-anchored writes).

## Decisions already made (don't relitigate)
- Direct mode + Bash for the local build agent — intentional, gated, live-verified. Not a
  regression of web/'s no-Bash/OS-jail invariants (those stay for the VPS drop mode).
- Cross-review gate before every merge to main has caught real bugs each time — keep it.
- Throwaway smoke artifacts (SMOKE.md, lane worktrees, integration branch) are cleaned; `main`
  never carries them. Promote to main stays human-gated + `ENABLE_PROMOTE_TO_MAIN`.

## Open / notes
- `main` pushed to origin (2026-07-06, through 28ab173: isolated agent HOME). Isolated-home
  live smoke PASSED same day: clean one-line trace (no global-CLAUDE.md noise), 711-token
  agent context, gates A/B/D/C clear, artifacts cleaned. Note: the smoke agent didn't
  commit itself (daemon wt-commit fallback fired), so the .gitconfig identity path in the
  isolated home is still unexercised live.
- `data/` (repo-root plan dir) is now gitignored (runtime artifact).
- The dashboard binds tailnet IP for real use (100.72.193.64); localhost for local smoke.
- Model alias quirk: `--model haiku` resolved to sonnet-5 in one run; sonnet/opus map fine.
  Low priority; revisit if haiku routing matters.
- RUN-RECIPE GOTCHA: a run against THIS repo flips the operator checkout to `integration`
  mid-run; harness.sh reset-base switches back to base only from a CLEAN tree (by design —
  never migrates junk). Dirty tree ⇒ stranded on integration: recover with
  `git switch <branch>` (changes carry) + delete `integration`. Smoke leftovers to clean
  after a local run: lane worktree + branch, integration branch, data/plans/plan-<id>.jsonl.
