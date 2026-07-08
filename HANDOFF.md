# HANDOFF — GANTRY (harness dashboard + live build-agent) — 2026-07-08

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
- **Decompose agent** (READ-ONLY headless split of brief → 1..4 disjoint lanes,
  fail-closed validation) — promoted 2c900fb; live decomposed-run smoke PASS.
- **Handoff-respawn loop** (context-guard HANDOFF.md → fresh-agent respawn, fail-closed
  neutralization) — promoted 5f200e7; live respawn smoke PASS 2026-07-07.
- **Per-lane model routing** — promoted cf2090a 2026-07-08: `route-tier.ts` (route.py
  TOP/CHEAP regexes verbatim), `auto` ⇒ routeModel(brief) per lane, explicit tier ⇒
  force-all, per-lane plan.jsonl pricing, worker uses lane.model. No API change.
- Sandbox: `console/lib/sandbox/{agent-runner,worktree,agent-home,decompose,handoff}.ts`.
  Wired in `console/lib/server/daemon.ts`.
- Posture (operator-approved): DIRECT mode (agent runs as operator), FULL toolset incl.
  Bash, zero-MCP, credential-free env, worktree-cwd, timeout, audit. Gates:
  `ENABLE_AGENT_EXEC=1` + `AGENT_ALLOW_DIRECT=1`.

## To run GANTRY live (proven working)
Easiest: `gantry up` (live env owned by the CLI), `gantry run "<brief>"`, `gantry status`.
Manual equivalent:
```
cd /home/alter/HARNESS/console && npm run build
ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1 HARNESS_LIVE=1 \
  AGENT_CLI_PATH=/home/alter/.local/bin/claude \
  CONSOLE_BASE_URL=http://127.0.0.1:3000 HARNESS_REPO=/home/alter/HARNESS \
  npx next start -H 127.0.0.1 -p 3000        # or -H 100.72.193.64 for tailnet
```
`AGENT_CLI_PATH` must be the ABSOLUTE claude binary; `buildAgentArgs` passes
`--dangerously-skip-permissions`. Do NOT set `AGENT_HOME` (isolated per-lane homes are
the default; `AGENT_HOME=<path>` = explicit legacy override). Multi-lane: POST
`lanes:["b1","b2"]` (1..4) + `LANE_CONCURRENCY=2..4`. Decompose: `gantry run --decompose`.

## NEXT-PASS AGENDA (what to build after /clear)

1. **Decompose agent** — DONE 2026-07-07 (promoted 2c900fb + live smoke PASS).
2. **Console handoff-respawn loop** — DONE 2026-07-07 (promoted 5f200e7 + live respawn
   smoke PASS). Boundary (documented): dissimilar-content renames undetectable.
3. **Per-lane model routing** — DONE 2026-07-08 (promoted cf2090a; all gates green,
   opus judge PASS). Non-gating follow-up: live mixed-tier `--decompose` smoke
   (confirm mixed models in audit argv + usage envelopes); plan.jsonl serialization
   golden-test (accepted Medium).
4. **CLI tests** (accepted Medium at gantry-cli merge) — bin/gantry parser + API client
   against a mock server; install.sh shell asserts.
5. **Operator DoD leftovers** (dashboard rebuild) — phone approve over tailnet, ntfy
   tap deep-link, /graph showpiece capture. (Live run e2e: done repeatedly.)
6. **VPS drop-mode track** (when wanted) — agent Max-plan login, egress firewall,
   resource limits, agent-N accounts for multi-lane, threat-model §7 sign-off.

Low/background: haiku alias quirk (+ usage-extraction may pick wrong modelUsage key —
see decompose smoke note in NOTES.md); gantry SSE reconnect if runs get long; agent-home
hardening notes (git-identity cache, openat-anchored writes).

## Decisions already made (don't relitigate)
- Direct mode + Bash for the local build agent — intentional, gated, live-verified. Not a
  regression of web/'s no-Bash/OS-jail invariants (those stay for the VPS drop mode).
- Cross-review gate before every merge to main has caught real bugs each time — keep it.
- Throwaway smoke artifacts are cleaned; `main` never carries them. Promote to main stays
  human-gated + `ENABLE_PROMOTE_TO_MAIN`.

## Open / notes
- RUN-RECIPE GOTCHA: a live run against THIS repo flips the operator checkout to
  `integration` mid-run; reset-base returns to base only from a CLEAN tree. Dirty tree ⇒
  recover with `git switch <branch>` + delete `integration`. Smoke leftovers to clean:
  lane worktree+branch, integration branch, data/plans/plan-<id>.jsonl.
- Model alias quirk: `--model haiku` resolved to sonnet-5 in one run; sonnet/opus map fine.
