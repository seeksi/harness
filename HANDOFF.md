# HANDOFF — Group C: DONE s4 — cross-review PASS, rebuilt+restarted :3001 (agent-exec, pid 343982), live smoke validated the fix twice, committing. See NOTES "Group C close — s4" for details. (Env gap fixed: launch needs HARNESS_SCRIPT_PATH absolute. Open: Gate-D trace-relocate fails for real agent-exec = tracehook subtask.) Prior s3 state below.

# HANDOFF — Group C: throwaway "won't start" daemon fix DONE (Gate C green); rebuild+restart+cross-review+commit remain — 2026-07-08 s3

## Current state
- **ROOT CAUSE (confirmed live):** the console daemon's `finally` (daemon.ts:578) ran ONLY
  `reset-base` (switches HEAD back to base) — it never deleted the `integration` branch or
  lane worktrees. Only a *successful* run's `promote` deletes integration. A throwaway smoke
  fails-closed → never promotes → each failed run leaves `integration` behind →
  the NEXT run's `integ-start` dies ("integration already exists — clean first",
  harness.sh:296) → run fails instantly and never shows on the fleet board (seam #3) → looks
  like "nothing starts." Reproduced: cleaned /tmp/c2-throwaway, POSTed a run (started clean:
  Gate A clear → Gate B raised → failed), and it re-left `integration` — the poisoning loop.
- **FIX IMPLEMENTED + Gate C GREEN (uncommitted, working tree):**
  - Failure-path cleanup ONLY: a `failed` flag (daemon.ts) set in the catch; in `finally`,
    after `reset-base`, `if (failed)` runs best-effort `runSub({cmd:"clean"})` (harness.sh
    clean = reclaim worktrees + wt clean + `git branch -d integration` + trace prune).
  - New `{cmd:"clean"}` in HarnessSubcommand + buildArgs (`["clean"]`, no client input).
  - Gate C: `cd console && npx vitest run` = **500 pass (38 files)**; eslint clean on touched
    files; `npx tsc --noEmit` = **11 errors = main baseline** (all pre-existing test-harness
    typings: harness-bridge.test.ts 188/205, daemon.test.ts 13/20, notifier.test.ts — NONE in
    touched production code); `npx next build` compiled OK.
- **Design decision (do not relitigate):** cleanup is FAILURE-path only. Success deliberately
  leaves `integration` for the operator to promote (gate route `promote-to-main` kind, behind
  ENABLE_PROMOTE_TO_MAIN=1) or clean manually. Auto-cleaning success would destroy the
  deliverable.
- **NOT done yet:** (1) rebuild + restart :3001 with **ENABLE_AGENT_EXEC=1**; (2) cross-review
  the diff; (3) commit. Server pid **263685** is still running the OLD build (no fix, no
  agent-exec) — cwd console/, HARNESS_REPO=/tmp/c2-throwaway, HARNESS_LIVE=1, ntfy
  gantry-smoke-c3. Restarting empties the broker ring (drops stale run 846a92b — fine, it's
  from an earlier session).
- **/tmp/c2-throwaway is CLEAN** (only `main`, no `integration`, no worktrees) — ready.

## Decisions
- Failure-path clean only (success leaves integration by design; promote path exists). See above.
- Reuse existing `harness.sh clean` via a new typed bridge subcommand rather than a bespoke
  teardown — no new git logic, best-effort, wrapped in try/catch so it never fails slot release.
- **Gate B REALITY (corrects the pre-fix message to the user):** `wt-verify` Gate B is
  pass/fail, NOT an interactive pause. A real agent that commits CLEARS Gate B → run proceeds
  to merge → done (integration left). A *raised* (approvable) Gate B only happens on FAILURE
  (no-op/dirty lane). The Approve POST records a decision but does NOT resume the harness (seam
  #2). So ENABLE_AGENT_EXEC=1 makes runs REAL (real commit/trace/graph) but Gate B will CLEAR on
  a successful agent — the phone-approve tap needs the /run/[id] deep link on a still-in-ring
  FAILED run, or the headless verify-c2-approve.mts path.

## Files touched (this session, uncommitted)
- console/lib/server/daemon.ts — `failed` flag + failure-path `runSub({cmd:"clean"})` after reset-base (with ponytail note re: multi-lane conflict).
- console/lib/bridge/harness-bridge.ts — `{cmd:"clean"}` added to HarnessSubcommand type + buildArgs case.
- console/lib/server/daemon.test.ts — 4 early-failure order asserts `["reset-base"]`→`["reset-base","clean"]`; agentfail test now asserts `toContain("clean")`.
- console/lib/bridge/harness-bridge.test.ts — buildArgs asserts for `reset-base` + `clean`.
- NOTES.md — "# Group C — throwaway run 'won't start' fix + agent-exec wiring (2026-07-08 s3)" checkpoint.
- (also uncommitted from prior s2c: app/page.tsx, lib/client/postGate.ts, components/run/gateActions.ts+test, components/run/RunFocus.tsx, components/FleetHome.tsx — the seam1/seam2 live-mode + approve-POST work.)

## Next steps
1. **Cross-review the diff** (`/cross-review` or cross-review skill) — mandatory before merge.
   Diff = the daemon fix + the uncommitted s2c seam work. Reconcile → fix rounds until PASS.
2. **Rebuild + restart :3001 with ENABLE_AGENT_EXEC=1.** Kill pid 263685, then from
   console/: `HARNESS_LIVE=1 HARNESS_REPO=/tmp/c2-throwaway HARNESS_BASE=main
   ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1 CONSOLE_BASE_URL=http://100.72.193.64:3001
   NTFY_URL=https://ntfy.sh NTFY_TOPIC=gantry-smoke-c3 npx next start -H 100.72.193.64 -p 3001`
   (AGENT_CLI_PATH from `which claude`; NO AGENT_HOME → isolated home). `npx next build` first
   (daemon.ts changed). Log to scratchpad/console-3001.log.
3. **Live smoke:** POST /api/runs {projectId:"c2-throwaway-8134eed7", brief:"..."} → confirm a
   REAL agent spawns, commits, Gate B CLEARS, run reaches done; then POST a *second* run and
   confirm integ-start no longer dies (the first run left integration on success — expect it to
   need manual clean OR reconsider whether the operator wants a throwaway that always fails to
   loop cleanly; the daemon fix guarantees FAILED runs self-heal).
4. **Commit** on feat/followups after cross-review PASS (do NOT push without operator say-so).
5. C3 push tap, C1 money-shot, ntfy middot fix (notifier.ts:53) still open (see prior HANDOFF s2c below in git history / NOTES).

## Dead ends / open questions
- ponytail ceiling (in-code): a multi-lane Gate-C conflict leaves the tree dirty on integration;
  `clean`'s safe `git branch -d` can't remove a dirty/current branch → that rarer case still
  needs manual `harness.sh clean`. Throwaway smoke is single-lane fail-at-B, unaffected.
- OPEN: does the operator want a throwaway that loops without any manual clean? Today a
  *successful* agent run leaves integration (by design). If pure repeatable smoke looping is the
  goal, either (a) keep agent no-op so every run fails+self-heals, or (b) add an opt-in
  "throwaway auto-clean on success" flag — NOT done (would violate the promote-on-success design
  for real repos). Decide before wiring a repeatable smoke.
- Push to origin still held for operator say-so.
