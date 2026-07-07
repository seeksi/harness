# HANDOFF — GANTRY (harness dashboard + live build-agent) — 2026-07-06

> Resume context. The product/dashboard is now named **GANTRY** (operator-picked
> 2026-07-06). Open this + NOTES.md + memory (agent-exec-gate, umbrella-vps-deploy)
> to continue. Repo: /home/alter/HARNESS, branch `main`.

## Where things stand (all on `main`, pushed to origin 2026-07-06)

DONE + verified:
- **Dashboard rebuild** (`console/` Next.js 16 app) shipped: fleet home, `/run/[id]`,
  `/deck`, `/graph/[projectId]`, launch console, ⌘K palette, ntfy, chime, `/brand`.
  Industrial-CRT identity (graphite + amber phosphor, green=live only). 306 tests green.
- **Live build-agent executor** wired + cross-reviewed + **live-verified end-to-end**
  (commit fe7486a). A real run built a file agent→wt-commit→Gate B→Gate D(trace)→Gate C
  (merge to integration), `main` untouched (promote gated). See memory [[agent-exec-gate]].
- Sandbox: `console/lib/sandbox/{agent-runner,worktree}.ts`. Wired in
  `console/lib/server/daemon.ts` (agent between wt-new and wt-commit + trace/Gate-D step).
- Posture (operator-approved): DIRECT mode (agent runs as operator), FULL toolset incl.
  Bash, zero-MCP, credential-free env, worktree-cwd, timeout, audit. Gates:
  `ENABLE_AGENT_EXEC=1` + `AGENT_ALLOW_DIRECT=1`.

## To run GANTRY live (proven working)
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
uses exactly that home, no provisioning). A stale SINGULAR `~/.gantry/agent-home` from the
pre-multi-lane build is not auto-removed — delete it once by hand. Multi-lane: pass
`lanes:["brief1","brief2"]` (1..4) to POST /api/runs and set `LANE_CONCURRENCY=2..4` for
overlapping builds (default 1 = sequential; VPS drop mode needs agent-N accounts first).

## NEXT-PASS AGENDA (what to build after /clear)

1. **Isolated agent HOME/config** — DONE 2026-07-06 (branch feat/agent-home-isolation).
   `console/lib/sandbox/agent-home.ts` `ensureAgentHome()`: direct-mode agents now get a
   minimal HOME at `~/.gantry/agent-home` (AGENT_ISOLATED_HOME to relocate) with ONLY
   `.claude/.credentials.json` (re-copied fresh each spawn, 0600/0700, symlink-refusing,
   fail-closed) + a one-time `.gitconfig` (fresh HOME has no git identity → commits died).
   Verified live: headless CLI auths from a cred-only HOME; project-level PostToolUse trace
   hook still fires (Gate D intact). Drop mode (sudo -H) untouched.

2. **Multi-lane concurrency** — DONE 2026-07-07 (branch feat/multi-lane, cross-review PASS
   Codex r3 + Claude r2). Console daemon runs 1..4 lanes per run: POST /api/runs takes
   optional `lanes:[briefs]` (each trimmed, ≤4000); planRun mints `lane-<sha16(runId)>-<i>`
   slugs (provenance from runId, never briefs). Execution: wt-new SERIAL → agent builds
   CONCURRENT (`LANE_CONCURRENCY` env, clamp 1..4, default 1 = sequential) → cross-lane
   session-id distinctness check → finalize-ALL lanes (wt-commit → Gate B → Gate D, lane
   order) → merge-ALL (Gate C, lane order); any lane failure fails the whole run before any
   merge. Per-lane isolated HOMEs `~/.gantry/agent-homes/<slug>` are reclaimed per run
   (removeAgentHome, same fail-closed bar as provisioning). Concurrent direct-mode lanes
   are an ACCEPTED posture (shared operator uid adds no new risk vs single-lane); drop mode
   keeps per-lane uids. Follow-ups (non-gating): decompose agent (brief → N disjoint
   lanes), handoff-respawn loop for console, per-lane model.

3. **`gantry` CLI command** (new). A CLI that invokes the harness. Decide scope with the user:
   - Minimal: `gantry run "<brief>" [--project <path>] [--model ...] [--live]` that drives the
     same daemon/harness.sh path the dashboard POST /api/runs uses (start a run, stream events to
     the terminal). Could shell the console server's API, or call the daemon/harness.sh directly.
   - Consider: `gantry up` (start the dashboard server with the right env), `gantry status`.
   - The daemon (`console/lib/server/daemon.ts`) + harness.sh are the engine; the CLI is a thin
     front-end. Reuse, don't reimplement. Cross-review before merge.

4. **Install script** — add `gantry` to `install.sh` (currently symlinks `.claude/skills/*` into
   `~/.claude/skills`). Add: symlink/install the `gantry` CLI onto PATH (e.g. `~/.local/bin/gantry`),
   and document the live-mode env vars. Keep it idempotent.

5. **Name rollout**: `/brand` page currently proposes PHOSPHOR/GANTRY/RUNBOARD — GANTRY is chosen;
   update the app wordmark/header ("HARNESS · mission control" → GANTRY) and `/brand` to reflect
   the pick, OR leave `/brand` as a design artifact. Confirm with user how far to rebrand the UI.

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
