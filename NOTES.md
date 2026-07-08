# Group C close — cross-review PASS + rebuild/restart + live agent-exec smoke (2026-07-08 s4)
project: harness

## Done this session (feat/followups)
- CROSS-REVIEW (Claude×Codex, fresh-context): VERDICT PASS. Codex raised 2 High + 3 lower.
  Both Highs downgraded on verified evidence — `harness.sh clean` uses SAFE `git branch -d`
  (harness.sh:436): an ahead-of-base integration (real merged work) is never lost; `if(failed)`
  clean is correctly nested inside `if(live)`, after reset-base, in try/catch (never skips slot
  release). Fixed the one Medium: RunFocus.onPromote now posts `postGate(runId,"D","approved")`
  in live mode (parity with FleetHome; was silently dropping promote taps on the run-focus page).
  Re-verified: console vitest 500 pass, tsc=11 (baseline, 0 in touched prod), eslint clean.
- REBUILD + RESTART :3001 (agent-exec): `npx next build` clean → killed old pid 263685 →
  restarted with the HANDOFF step-2 env. **ENV GAP FOUND + FIXED:** HANDOFF's env line omitted
  `HARNESS_SCRIPT_PATH`; default is RELATIVE (`../.claude/skills/harness/harness.sh`,
  harness-bridge.ts:309) and spawn resolves it against `cwd=HARNESS_REPO=/tmp/c2-throwaway`
  (harness-bridge.ts:419) → `/tmp/.claude/...` ENOENT. Added
  `HARNESS_SCRIPT_PATH=/home/alter/HARNESS/.claude/skills/harness/harness.sh` to the launch env.
  Server now pid 343982 on 100.72.193.64:3001, live:true. Log: scratchpad/console-3001.log.
- LIVE SMOKE (2 real agent runs): agent-exec spawns a real Claude agent that commits
  (agent-exec works end-to-end up to Gate D). **THE FIX VALIDATED TWICE:** both runs fail-closed
  at Gate D → failure-path `clean` tears down `integration` + resets HEAD to main → next run's
  `integ-start` succeeds (re-created integration where the OLD build would have died). Poisoning
  loop BROKEN.

## Residual / new findings (NOT blocking the commit)
- Gate D trace-relocate FAILS for every real agent-exec run ("agent trace could not be
  relocated") → runs can't reach `done`. Root cause is the isolated-HOME trace path — this IS
  the `tracehook` subtask below ("PostToolUse trace hook work from any cwd"). Blocks a green
  end-to-end agent run; separate from the daemon fix.
- Stale lane worktrees/branches accumulate on failed runs (agent committed real work → safe
  `branch -d` preserves the unmerged lane). Does NOT poison the next run (unique slug per run;
  only a leftover `integration` blocks integ-start). Cosmetic sprawl in /tmp/c2-throwaway
  (feat/lane-1fb3100f9828986a-0, feat/lane-44ff96b85aca37f0-0 + worktrees) — manual
  `harness.sh clean` to tidy, or force-teardown enhancement (ponytail in daemon.ts).
- Cross-review follow-ups (Low): finalizeRun("done") inside the failure try (safe-delete makes
  it harmless); RunFocus/FleetHome `live` probe defaults false until /api/runs resolves
  (sub-second first-paint race, shared pre-existing pattern); FleetHome still inlines the
  live/fixture branch instead of `gateEffect` (different envelope shape, not a mechanical dedup).

## Next
1. COMMIT on feat/followups (cross-review PASS) — do NOT push (operator say-so).
2. tracehook subtask → unblocks a green agent-exec run to `done`.
3. Optionally tidy /tmp/c2-throwaway stale lane worktrees (`harness.sh clean`).

# Memory-integration follow-ups (trace hook cwd, provisional confirm CLI, README docs) — base: main
project: harness

## Subtasks
- slug: tracehook   spec: "make the PostToolUse trace hook work from any cwd"                    owns: .claude/settings.json, .claude/skills/eval-gate/trace-log.py   tier: cheap
- slug: memconfirm  spec: "operator CLI to list/confirm/reject pending provisional memory records" owns: web/lib/memory/pendingLedger.ts, web/lib/memory/pendingLedger.test.ts, web/scripts/memory-pending.mjs   tier: default
- slug: memdocs     spec: "README section documenting the memory-os integration"                  owns: README.md   tier: cheap

# Context-management hook (soft 60% / hard 75% / HANDOFF.md) — base: main
project: harness
checkpoint: 2026-07-05 (session checkpoint at soft limit — work in progress)

## Done + verified
- web/lib/contract/types.ts: CONTEXT_SOFT=0.6 / CONTEXT_HARD=0.75 exported.
- .claude/skills/context-guard/context-guard.py + SKILL.md: PostToolUse hook
  (soft -> additionalContext, hard -> decision:block w/ HANDOFF.md template,
  debounced sidecar .claude/context-guard/<session>.json). All 10 standalone
  stdin cases pass; registered in .claude/settings.json; confirmed firing live.
- web/lib/daemon/daemon.ts: CONTEXT_GUARD_PROMPT + buildLanePrompt (handoff
  inline cap 20k), HandoffFs seam (StartRunOptions.handoffFs, test-only),
  handoff-respawn loop in Phase 2 (trigger = HANDOFF.md existence + exit 0,
  cap CONTEXT_MAX_HANDOFFS default 2, archive to HANDOFF.<n>.md), usage SSE
  now emitted per attempt (old post-barrier emit removed).

## Next steps
1. daemon.test.ts: add respawn / cap / prompt-content / usage-accumulation cases.
2. MemoryGauge.tsx: rampColor stops -> CONTEXT_SOFT/CONTEXT_HARD + HANDOFF tag
   (data-testid lane-tier-<id>); update MemoryGauge.test.tsx (61% vivid, 76% neon+tag).
3. cd web && npx vitest run; graphify update .

## Decisions
- Respawn on HANDOFF.md existence, not usage ratio (post-hoc; finished = finished).
- No sandbox/** or harness.sh/harness-bridge changes (cross-review rule 5).
- Plan: /home/alter/.claude/plans/let-s-add-a-context-temporal-hennessy.md

status: COMPLETE 2026-07-05 — all next steps done (tests 277 pass, tsc+eslint clean, hook verified live). Uncommitted on main.

# Dashboard rebuild per DESIGN_SPEC.md (Umbrella successor) — base: main
project: harness

## Batch plan (staged; dependency spine: contract -> views)
- Batch A: foundation (this batch)
- Batch B (off promoted main): run-focus, deck, graph (parallel)
- Batch C: polish-wire (seams: drawer overlays, palette entries, chime, name proposals)

## Subtasks (Batch A)
- slug: foundation  spec: "console/ app skeleton: Next16 app, CRT tokens/fonts, provider-agnostic multi-run event contract+reducer+store, project discovery (named roots), SQLite persistence w/ 20-run retention, SSE endpoints, ntfy notifier, fleet home + launch console + palette on fixture data"  owns: console/**  tier: top

## Checkpoint (context-guard, session 61%)
- DESIGN_SPEC.md signed off 2026-07-06; committed to main this batch.
- Decomposition rationale: greenfield lanes cannot import an unpromoted contract; Batch A is single-slug by design.
- Next steps if respawned: S1 route+budget -> wt-new foundation -> background build agent (worktree ../HARNESS.worktrees/foundation, read console spec from DESIGN_SPEC.md + NOTES.foundation.md) -> S3 cross-review -> integ-merge -> evals -> human go/no-go -> promote -> Batch B.

## Gate B round 1 (foundation): BLOCK — 3 must-fix
1. stream/route.ts: Last-Event-ID null->0 coercion drops frame 0 (guard null, cursor=-1)
2. sse/client.ts: reconnect recreates EventSource, loses cursor (track lastEventId explicitly)
3. RunLane.tsx: approve buttons use green; token rule = amber interactions
+ add SSE resume tests (no-header->frame0; Last-Event-ID:N -> N+1). Follow-ups logged: events cap/LIMIT, N+1, auth-note, live-bridge wiring (persist+notifier+wall-clock health) -> Batch B.

## Batch A gates: ALL GREEN (2026-07-06)
- Gate C: console 44/44 + build clean; web 277 pass (integration).
- Gate D L1: judge PASS (spec conformance, independent test/build/serve re-run). L2: trace 9831dd07 clean, 94 calls, no anomalies.
- Awaiting S6 human go/no-go to promote integration -> main.

## Subtasks (Batch B — off main b0482f6, parallel worktrees)
- slug: run-focus    spec: "app/run/[id] steering view: focus-size phase rail top-left, live feed, gate cards, budget/context meters, deep-linkable, phone restack"  owns: console/app/run/**, console/components/run/**  tier: TBD
- slug: deck         spec: "app/deck observability route: trace forensics explorer (search+filters run/lane/agent/type), tool-call detail w/ full args/outputs/timing, diff viewer, eval results, burn/eval charts"  owns: console/app/deck/**, console/components/deck/**  tier: TBD
- slug: graph        spec: "app/graph/[projectId]: activity-driven progressive-disclosure workflow graph + full-swarm showpiece toggle, pan/zoom, 60fps, capture-worthy"  owns: console/app/graph/**, console/components/graph/**  tier: TBD
- slug: live-bridge  spec: "real event producer: POST /api/runs spawns harness.sh w/ typed argv (port web harness-bridge security pattern), events -> persist + SSE broadcast + ntfy hooks, wall-clock health nowSec, events cap + eventsSince LIMIT, /api/projects N+1 fix, gate-id-aware approve"  owns: console/lib/server/**, console/app/api/**, console/lib/bridge/**, console/components/RunLane.tsx, console/components/FleetHome.tsx  tier: TBD
note: deck router said cheap; orchestrator held default (search/filter/virtualization/path-validation logic). Priced default in plan.jsonl.

## Batch B Gate B progress
- run-focus: BLOCK r1 (stale machine, green promote card, blind gate stub) -> fixed -> BLOCK r2 (closed-stream escalation, SSR clock) -> fixed -> PASS r3. 75 tests. reviewed.
- deck: BLOCK r1 (traces-dir symlink escape, DiffViewer id/path contract break, green misuse x2, raw panel unvirtualized, hook lines unsearchable). Fix agent running. Ruling: chart amber stays (interface voice per spec).
- graph: BLOCK r1 (model.ts binary-diff unreviewable, basename/projectId mismatch, Date.now render, canvas font/fillText perf, green connecting). Fix agent running. Ruling: amber activity nodes stay.
- live-bridge: Codex BLOCK r1 (8 High: wt-new user argv, full env inherit, audit swallowed, replay/subscribe gap, ring overflow, plan-file TOCTOU, GateD sans promote flag, gate route sans HARNESS_LIVE). Claude review pending; reconcile then fix.

## Batch B Gate B outcomes (final per lane)
- run-focus: PASS r3. deck: PASS by reconciliation r2 (traces-dir realpath ancestry + contract + token + virtualization fixed; Codex residual "Project.id is a path" ruled follow-up — id shape lives in lib/server/discovery.ts, another lane's file; stale fileEvents LOW fixed). graph: PASS r3 (NUL-byte binary root-caused; clock-pinning + ghost-labels fixed; model.ts verified clean text).
- live-bridge: r2 6/9 resolved; r3 in flight (gap-reseed from persistence for evicted runs, byte-capped stdout reader, eslint actually installed+passing).
- Follow-ups (Batch C): make Project.id opaque in discovery.ts; readline ponytail note; deck DetailPane session row polish.

## Batch B S4/S5 (2026-07-06)
- S4: 4 lanes merged clean, zero conflicts (live-bridge -> run-focus -> deck -> graph). Gate C: console 200/200 (24 files) + build + lint; web 277 pass.
- Gate D L2: trace dc1819a5 flags EXPLOSION 981>200. Assessment: false positive — aggregate orchestrator session (2 batches, 22 subagents, 13 codex reviews); no LOOP (run=1), no THRASH (Bash 33%). Carried to S6 human checkpoint as tie-break, not self-dismissed. Per-lane Batch A trace was clean (94 calls).
- Accepted ceiling (documented in-code): stdout line cap counts UTF-16 code units (~4x byte slack, still hard-bounded; 8KiB field caps downstream).

## Batch B S6: GO (human, 2026-07-06) — trace EXPLOSION accepted as FP (session aggregation; human tie-break). Judge blocker (fleet->run nav) + third wall fixed on integration, re-verified 203/203.

## Subtasks (Batch C — off main 3bf12a9)
- slug: polish-wire  spec: "cross-view seams: deck drill-through from run focus (?run= + palette entries), desk chime on gate-raise (mutable, pref-respecting), phone restack pass on deck/graph, /brand page w/ 3 name proposals as Oxanium wordmarks, Project.id made opaque in discovery (+dependents), ntfy deep-link base URL config"  owns: console/** (cross-cutting, single lane)  tier: default

## Batch C Gate B r1 (polish-wire): Codex BLOCK — projectId still rendered raw in RunFocus/CommandPalette (legacy path leak), client basename fallback keeps path-parsing client-side, chime.ts imports server notifier module (boundary), roster exact-only slug breaks legacy links, weak chime baseline test. Claude review pending; reconcile then fix round.

## Batch C S4/S5: merged clean; Gate C console 244/244 + build + lint, web 277. Trace: EXPLOSION:1493 on aggregate session — same FP class human accepted at Batch B checkpoint (run=1, no dominance); carried forward. Judge (scoped) running.

## Batch C S6: GO (human, 2026-07-06). Judge PASS, all gates green. Rebuild complete on promote.
status: DASHBOARD REBUILD COMPLETE — Batches A+B+C promoted. Remaining: operator DoD (live run e2e, phone approve, ntfy tap, showpiece capture), name pick on /brand.

## agent-exec-wire Gate B r1: Codex BLOCK (6 findings)
1. HIGH daemon: agent nonzero/null exitCode ignored -> failed agent still committed/merged. Throw unless exitCode===0 before wt-commit.
2. HIGH daemon: mintSession(child stdout) launders child value into provenance. Validate as data, don't mint child output; trace/relocate re-validate shape; fail closed if untrustworthy.
3. HIGH sandbox: session via regex over all stdout -> spoofable. JSON-parse final result, read top-level session_id.
4. HIGH daemon: missing session/trace -> Gate D silently skipped, still merges (agent suppresses trace). If agent ran+exit0, require relocated trace + Gate D, else fail closed.
5. HIGH sandbox: audit swallowed + no mandatory pre-spawn audit. Fail-closed pre-spawn audit (same pattern live-bridge already adopted).
6. MED/LOW tests: cover nonzero-exit/null-session/relocate=false fail-closed; timeout test needs pid for process-group kill.
Claude review pending; reconcile then fix.

# Isolated agent HOME (HANDOFF agenda #1) — base: main, branch feat/agent-home-isolation
project: harness
checkpoint: 2026-07-06 (context-guard soft limit; implementation done, tests green)

## Investigation results (verified live, scratchpad probes)
- Headless claude 2.1.202 auths fine from a HOME containing ONLY .claude/.credentials.json (Max plan, no API key).
- CLI self-provisions .claude.json/projects/sessions in the fresh HOME; credential untouched on a normal run.
- Project-level PostToolUse hooks ($CLAUDE_PROJECT_DIR-relative) STILL FIRE under fresh HOME -> Gate D trace pipeline intact.
- Gap found: fresh HOME has no ~/.gitconfig -> agent `git commit` would die; provisioner writes one.

## Done (on feat/agent-home-isolation)
- NEW console/lib/sandbox/agent-home.ts: ensureAgentHome() -> AGENT_ISOLATED_HOME ?? ~/.gantry/agent-home;
  0700 dirs, symlink-refusal, credential RE-COPIED each spawn (0600, tmp+wx+rename), one-time .gitconfig
  (operator identity via `git config --get`, fallback GANTRY Agent <agent@gantry.local>), fail closed if
  operator cred missing. ponytail note: copy-at-spawn divergence ceiling documented in-file.
- agent-runner.ts: spawnAgent provisions isolated home in DIRECT mode when AGENT_HOME unset (AGENT_HOME set =
  explicit legacy override; drop mode untouched — sudo -H owns HOME). Provision failure fails closed (audit "error",
  no spawn). buildInvocation/agentEnv take optional isolatedHome param. index.ts re-exports ensureAgentHome.
- Tests: agent-home.test.ts (6 cases) + 3 spawnAgent isolated-home cases; agent-runner.test.ts beforeEach now stubs
  AGENT_HOME (keeps legacy-path tests off the real fs). Sandbox suite 64/64 green.

## Next steps
1. Full console suite (npx vitest run) + tsc + eslint + next build.
2. Update HANDOFF.md: agenda #1 done; run recipe drops AGENT_HOME=/home/alter (isolated is the new default).
3. Update memory agent-exec-gate (isolated HOME shipped note).
4. cross-review skill on the diff (spawn boundary rule), then merge branch -> main.
5. Optional operator live smoke: run a real GANTRY run and confirm trace no longer carries global CLAUDE.md noise.

## Isolated agent HOME — cross-review rounds r2/r3 (2026-07-06 session 2)
- r2 gates: sandbox 66/66, full 318, lint+build clean. Codex r2 (thread 019f39ce-fb6e-7642-8be7-0bf01fa168ea): BLOCK, 6 findings
  (validation after wipe/mkdir; marker accepts any dirent; cred lstat→read TOCTOU; symlinked parent bypasses repo ban via realpath;
  empty AGENT_ISOLATED_HOME silently fell back; test asserted the fallback). All 6 fixed.
- r3 gates: 69/69 sandbox, 321 full. Codex r3 (thread 019f39d6-2f0d-7860-b1b0-e1063f22f425): BLOCK, 5 High + 1 Med
  (custom-home symlinked parent still trusted; fresh-home mkdir through symlinked .gantry before pin; cred validated after wipe;
  worktrees ban misses real sibling when repoRoot behind symlinks + wtDir absent; provisioning-failure audit best-effort; tests lack
  no-mutation asserts). Fixes applied (r4 working tree):
  - expectedRealFor(): custom paths must be FULLY canonical (anchor=fs root); default anchored at realpath(homedir). Checked via
    realDestination() (deepest-existing-ancestor realpath) BEFORE any mutation.
  - readOperatorCredential(): O_NOFOLLOW+fstat-on-fd, read into memory BEFORE the wipe. Refusals now leave world untouched.
  - Ban set derived from realpath(repoRoot) too (real sibling wtDir banned even when absent).
  - Tests: fixtures realpath'd (macOS /tmp), no-mutation asserts, cred-failure-preserves-marked-home case. 70/70, full 322, lint+build green.
- RECONCILIATION RULING (carry to human): Codex r3 finding 5 (provisioning-failure "error" audit is best-effort) NOT fixed —
  repo pattern reserves fatal audit for the pre-spawn "spawn" row (T7 no-unaudited-RUN); all refusal paths (refused/invalid-args)
  are deliberately best-effort, shipped through prior PASSed reviews. Downgrade Med follow-up, flag at merge.
- NOTE: marker format changed to content "gantry-agent-home v1\n" — a stale ~/.gantry/agent-home provisioned by the OLD build (empty
  marker) will refuse; operator deletes it once (error message says so).

## Isolated agent HOME — rounds r4–r6, PASS (2026-07-06 session 3)
- r4 (reply-mode on r3 thread): BLOCK, 3 High + 1 Med. Dispositions:
  1. provisioning-failure audit best-effort → FIXED fatal-with-cause: audit("error") written fatally; if appendAudit throws,
     reject AgentExecError reporting both, original provisioning error as `cause`. (Moots the r3 reconciliation ruling above.)
  2. AGENT_HOME="" treated as unset → FIXED: set-but-empty refused with AgentExecError in direct mode; provisioning gate is
     `=== undefined`. Tests delete the var via vi.stubEnv(name, undefined) (works in vitest 4).
  3. expectedRealFor homedir anchor tolerates symlinked homedir ancestors → DISPUTED via spec amendment ("refuse symlinked
     ancestors BELOW the trust anchor"; agent can't re-point /home; Fedora/macOS system symlinks legit). Codex accepted.
  4. marker read-before-size-check → FIXED: size precheck vs Buffer.byteLength(MARKER_CONTENT) before content compare.
- r5: BLOCK, 1 High — the "" refusal fired before the direct/drop branch, breaking drop mode's "AGENT_HOME never consulted"
  contract → FIXED: refusal + provisioning gate both scoped inside `!(spec.user ?? AGENT_USER)`. Drop-mode regression test added.
- r6: **PASS.** Final gates: sandbox 72/72, full console 324/324, eslint clean, next build clean.
- Merged to main; HANDOFF.fix-round.md deleted. Open (unchanged): haiku alias quirk; copy-at-spawn refresh-rotation ceiling
  (ponytail note in agent-home.ts); per-lane homes required before multi-lane.

## Multi-lane concurrency — design checkpoint (2026-07-06 session 3, feat/multi-lane)
DECISIONS (made inline, consistent with approved posture — don't relitigate):
- Concurrent DIRECT-mode lanes accepted: agent already runs as operator w/ Bash (cwd is soft
  confinement), so sibling-worktree readability adds no NEW risk vs the approved single-lane
  posture. Drop mode keeps per-lane uids (laneUser(i) already in console agent-runner).
- Per-lane isolated homes (prereq from agent-home.ts ponytail): ensureAgentHome(slug) →
  <base>/<slug>, base = ~/.gantry/agent-homes (NEW plural path) or AGENT_ISOLATED_HOME
  (reinterpreted as BASE dir). Each lane home has own marker, wiped+rebuilt per spawn.
  Slug validated as path component. Old ~/.gantry/agent-home (singular) goes stale —
  operator deletes once.
- Daemon: RunPlan{runId, planFile, model, lanes:[{slug, brief}]}; slugs lane-<sha16>-<i>.
  planRun takes laneBriefs[]. writePlanFile: one plan.jsonl line per lane (budget.py reads
  batch). POST /api/runs accepts optional lanes:[briefs] (1..4, each ≤ cap); absent ⇒ [brief].
- Execution shape (ported from web/lib/daemon/daemon.ts): budget → integ-start → wt-new
  SERIAL per lane → builds CONCURRENT via asyncPool(LANE_CONCURRENCY, allSettled semantics)
  → if ANY lane rejected/nonzero: fail whole run BEFORE any merge → finalize SERIAL in lane
  order per lane {wt-commit → wt-verify(B) → mintSession+relocate+trace(D) → integ-merge(C)}.
  All harness.sh git ops stay serial; only agent builds run concurrently.
- LANE_CONCURRENCY env, default 1 (safe, mirrors web/ cross-review ruling), clamp 1..4.
  Operator raises locally; VPS drop mode needs agent-N accounts to exist first.
- OUT OF SCOPE this pass (follow-ups): decompose agent (brief → N disjoint lanes via LLM),
  handoff-respawn loop (console runAgentInSandbox lacks handoffFs seam), per-lane model.
FILES: sandbox/agent-home.ts(+test) slug param; sandbox/agent-runner.ts(+test) pass
spec.slug; server/daemon.ts(+test) lanes machinery; app/api/runs/route.ts(+test) lanes[].
Then gates → cross-review (fresh Codex thread, new diff) → merge.

## Multi-lane — implementation checkpoint (2026-07-06 session 4, feat/multi-lane)
DONE (uncommitted, tests green 339/339 from `cd console && npx vitest run`):
- daemon.ts reworked per checkpoint: RunPlan{runId,planFile,model,lanes:[{slug,brief}]};
  planRun(runId,routing,laneBriefs) slugs `lane-<sha16>-<i>`; writePlanFile one line/lane;
  laneConcurrency() env read at RUN START (deliberate deviation from web's module-load
  const — testable without reimport; clamp 1..4); asyncPool ported verbatim (allSettled
  drain). Live block: wt-new SERIAL → builds CONCURRENT (nonzero-exit throws INSIDE worker
  so pool check only inspects rejections; usage emitted per lane w/ laneId; user:laneUser(i)
  for drop mode) → any-rejection ⇒ HarnessExitError BEFORE any commit/merge → finalize+merge
  SERIAL per lane {wt-commit → wt-verify(B) → GateD fail-closed(session+relocate+trace) →
  integ-merge(C)}. ENABLE_AGENT_EXEC unset ⇒ agentRan=false, GateD skipped, flow unchanged.
- StartRunInput.laneBriefs?: string[] (absent ⇒ [brief]; brief stays display summary).
- route.ts: lanes[] optional 1..4, trimmed, non-empty, ≤BRIEF_MAX each; ALLOWED_FIELDS+=lanes.
- daemon.test.ts: planRun rewritten (2 cases incl. slug-never-from-brief), sessionId regex
  → lane-<hash>-0, + 4 multi-lane cases (happy-path event order per lane; one-lane-fails
  blocks ALL commits/merges; default sequential equivalence; CONCURRENCY=2 overlap via
  deadlock-if-sequential barrier). NEW app/api/runs/route.test.ts (8 cases, mocks daemon+
  discovery).
NEXT: eslint + next build → cross-review (FRESH Codex thread, diff = git diff main --
console/ + this checkpoint as spec) → one commit → merge main → push → update HANDOFF.md
agenda + agent-exec-gate memory (per-lane homes ~/.gantry/agent-homes/<slug>, stale
singular dir, LANE_CONCURRENCY env) → delete HANDOFF.multi-lane.md → offer 2-lane smoke.

## Multi-lane — cross-review r2 checkpoint (2026-07-07 session 5)
r1 fix round DONE (all 7 dispositions from HANDOFF.multi-lane.md applied): daemon phase
split (finalize-ALL then merge-ALL), planRun re-asserts 1..4 non-empty briefs, undefined-
only laneBriefs fallback, cross-lane session-id distinctness (fail closed pre-commit),
cleanupHome seam (default removeAgentHome) best-effort per planned lane in finally (plan
hoisted; TS note: plan narrowing doesn't cross the asyncPool closure — model captured),
route.ts validates TRIMMED lane length. Tests +11: planRun throws, phase-split zero-merge,
dupe sessions, clamp abc/99, cleanup-per-lane-even-throwing, removeAgentHome×4, route trim.
Codex r2 (thread 019f3b5d-405d-7362-bf02-abd120f52686): r1 findings RESOLVED; BLOCK w/ 1
NEW High — removeAgentHome lacked the repo/worktrees ban ensureAgentHome has → FIXED
(assertOutsideRepoAndWorktrees before existence probe, symmetric; + fixture-repo test w/
authentic marker surviving). Gates: 350/350. Claude r2 subagent review in flight.
NEXT: Claude r2 verdict → reconcile → eslint+build → Codex r3 (same thread, regenerated
diff at scratchpad multi-lane-r2.diff path pattern) until PASS → then HANDOFF step 6
(commit/merge/push/docs/memory/delete HANDOFF.multi-lane.md) + step 7 (offer smoke).

status: COMPLETE 2026-07-07 — Claude r2 PASS (3 Lows: [] end-to-end test ADDED; stale
singular home = operator note; laneConcurrency comment wording FIXED). Codex r3 PASS.
Final gates 351/351 + eslint + next build clean. Merged feat/multi-lane → main.
Follow-ups logged (non-gating, decision 7): laneUser/BASE_AGENT_USER module-load const
untestable without reimport; ensureAgentHome sync execFileSync git-config per spawn
(cache identity someday); openat-anchored writes if posture tightens; stale singular
~/.gantry/agent-home — operator deletes once; decompose agent / handoff-respawn loop /
per-lane model remain out-of-scope follow-ups.
smoke: 2-lane live smoke PASSED 2026-07-07 (LANE_CONCURRENCY=2, run 0b0ddc6b, done in 9s;
both lane homes overlapped then reclaimed; gates A/B×2/D×2/C×2 clear; main untouched;
artifacts + stale singular ~/.gantry/agent-home cleaned).

# gantry CLI (agenda #3) + install.sh (#4) — base: main b12ada1, branch feat/gantry-cli
project: harness
checkpoint: 2026-07-07 (context-guard soft limit; implementation done, verification starting)

## Scope (user-confirmed via AskUserQuestion)
- Commands: run + up + status. Backend: API client, single-file zero-dep Node script
  (bin/gantry, node>=18 global fetch) over the console HTTP API — reuse, don't reimplement.

## Done (uncommitted on feat/gantry-cli)
- NEW bin/gantry (executable): `run "<brief>" [--lane ...]... [--project id|name]
  [--model auto|haiku|sonnet|opus] [--url] [--no-follow]` → resolves project via
  /api/projects (id|name match; single project auto; cwd-basename fallback), POSTs
  /api/runs w/ CSRF headers (x-harness-request:1, sec-fetch-site, origin from base URL),
  then tails /api/fleet/stream SSE filtered to runId; exits on health lifecycle
  (done→0, failed→1); renders phase/gate/subtask/usage/health, skips trace+sync.
  `up [--host --port --lanes 1..4 --fixture]` → realpath(argv[1])/../.. = repo,
  spawns `npx next start` in console/ w/ live env (HARNESS_LIVE, ENABLE_AGENT_EXEC,
  AGENT_ALLOW_DIRECT, AGENT_CLI_PATH resolved from PATH via findClaude, LANE_CONCURRENCY,
  deletes AGENT_HOME); refuses if console/.next missing. `status` → GET /api/runs +
  /api/projects. ponytail noted in-file: no SSE auto-reconnect (exit w/ hint).
- install.sh: symlink bin/gantry → ~/.local/bin/gantry (idempotent, uninstall removes
  only if it points at this repo), PATH warning, quickstart+env-vars doc heredoc.

## Facts learned (for the CLI)
- currentSlot() returns runId string | null. Terminal signal = health envelope w/
  payload.lifecycle "done"|"failed" (daemon.ts:464,471). /api/projects exposes only
  {id,name,agentCount,recentRuns} — path deliberately server-side.
- Phase labels 1..6: decompose/build/route-cost/cross-review/merge/eval+promote.

## Next steps
1. Verify: bin/gantry usage/status error paths; `bin/gantry up` (bg) → status → live
   1-lane run streaming to done → clean smoke artifacts (worktree, lane+integration
   branches, plan file, SMOKE file) → kill server. Also test install.sh idempotency.
2. cross-review skill on the diff (mandatory before merge) → fix rounds until PASS.
3. Merge feat/gantry-cli → main, push. Update HANDOFF.md agenda #3+#4 DONE + NOTES
   status line + memory (agent-exec-gate or new gantry-cli note if durable).

status: COMPLETE 2026-07-07 — cross-review r1 BLOCK (Codex+Claude, 13 dispositions:
CJS rewrite, LIVE_ENV fixture scrub, AGENT_CLI_PATH validation, install.sh clobber/
readlink guards, ...) → r2 Codex BLOCK (parseArgs needs 18.3 → hand-rolled parser;
stream-connect wrap) / Claude PASS (5 Lows all fixed: findClaude isFile, running-not-
red, LIVE_ENV full set, URL validation) → Codex r3 PASS. Verified live twice end-to-
end (up → status → 1-lane run to done exit 0, artifacts cleaned, reset-base returned
to main from clean tree). install.sh verified: idempotent×2, uninstall, refusals,
symlinked-repo. Merged → main 5168d7c (push pending operator approval). Follow-up (Medium, accepted): no
automated CLI tests. Won't-fix Low: client brief pre-check. ponytail: no SSE reconnect.

# Decompose agent (HANDOFF agenda #1) — base: main d02e82c
project: harness

## Subtasks
- slug: decompose  spec: "LLM decompose step: sandbox decomposeBrief() (read-only headless claude -> validated disjoint lanes JSON) + daemon wiring (StartRunInput.decompose before planRun) + route field"  owns: console/lib/sandbox/decompose.ts, console/lib/sandbox/decompose.test.ts, console/lib/sandbox/index.ts, console/lib/server/daemon.ts, console/lib/server/daemon.test.ts, console/app/api/runs/route.ts, console/app/api/runs/route.test.ts  tier: top
- slug: cli        spec: "gantry run --decompose flag (POST decompose:true, mutually exclusive with --lane) + usage text"  owns: bin/gantry  tier: cheap
- slug: ui         spec: "LaunchConsole decompose toggle -> LaunchPayload.decompose -> FleetHome live POST body"  owns: console/components/LaunchConsole.tsx, console/components/LaunchConsole.test.tsx, console/components/FleetHome.tsx, console/components/FleetHome.test.tsx  tier: default

## Design decisions (S0, don't relitigate)
- TS spine (decompose.ts <- daemon.ts <- route.ts) is ONE lane: worktree lanes off base
  cannot import an unmerged module (Batch-A/C precedent). cli + ui are HTTP/client-side,
  truly disjoint.
- decompose.ts: spawn pattern mirrors agent-runner (buildInvocation/ensureAgentHome
  reused; NO weakening of containedWorktree — decompose cwd is the repo root, validated
  against HARNESS_REPO resolution like worktree.ts:30). Read-only toolset Read,Grep,Glob;
  --strict-mcp-config; --dangerously-skip-permissions; --output-format json; timeout;
  audit rows (cmd:"agent", lane:decomp-<sha16(runId)>); gate ENABLE_AGENT_EXEC=1 (a
  decompose request without agent-exec fails the run loudly).
- Agent output contract: ONLY JSON {"lanes":[{"brief":str,"owns":[paths]}]} parsed from
  claude result envelope (type:"result", top-level result field; strip ``` fences).
  Validate: 1..4 lanes; briefs non-empty; owns relative, no "..", no abs, pairwise
  disjoint INCLUDING prefix containment (a/b vs a/b/c = overlap). Composed lane brief =
  brief + "\nOWNS — modify ONLY these paths:" + owns list; cap <= 4000 (route BRIEF_MAX).
  Fail closed on any violation (HarnessExitError path in daemon).
- Daemon: decompose runs BEFORE planRun (laneBriefs = composed); phase-1 envelope
  (PHASE_LABELS[1]="decompose": status active -> done; PhasePayload.approval kind
  "decompose-split" exists but approval flow is OUT OF SCOPE this pass — follow-up);
  decompose + explicit laneBriefs together = route 422 (mutually exclusive); seam
  StartRunOptions.decomposeFn (test-only, mirrors runAgent); cleanupHome(decompSlug)
  in finally alongside lane homes.
- CLI/UI post {decompose:true}; server ignores absent field (back-compat).

## Decompose-agent batch — checkpoint (2026-07-07, session at context soft limit)
- Gate A: $1.454 vs 5.0 ceiling, clear. Worktrees decompose/cli/ui off d02e82c.
- cli lane: built + cross-review r1 — Codex BLOCK 1 High (usage synopsis implied --lane
  and --decompose combinable) → FIXED in place ([--lane <brief>... | --decompose]),
  re-verified (node --check, exclusivity exit 1 pre-network). VERDICT PASS.
  Claude-only Low follow-up (non-gating): run-start message doesn't say decompose mode.
  wt-commit + wt-verify done → status reviewed.
- ui lane: build agent DONE, all green (359 tests/34 files, eslint clean, next build ok,
  tsc: 8 PRE-EXISTING errors identical on main — VERIFY that claim vs main before Gate C;
  agent's files add zero new). Test convention note: repo uses .test.ts pure-function
  tests (vitest include **/*.test.ts, no jsdom) — agent exported buildLaunchPayload/
  buildRunsPostBody helpers and tested those. AWAITING cross-review (S3).
- decompose lane (opus, TS spine): build agent STILL RUNNING in background.
- ui cross-review r1: Codex BLOCK 3 High — #1 reopen-reset real (Claude had it Low;
  stricter won) → FIXED (setDecompose(false) in the open effect); #2/#3 "missing tests"
  REFUTED with evidence: test files were UNTRACKED so `git diff main` hid them (8 cases
  exist covering exactly the demanded assertions). Claude Lows: fixture comment reworded;
  RTL interaction tests + typed POST body = accepted follow-ups (no jsdom in repo).
  Re-verified 359/359 + eslint; tsc 11 errors = main's 11 exactly (pre-existing, NOT this
  batch; ui agent's "8" was miscounted). VERDICT PASS → wt-commit + wt-verify clear.
  LESSON for remaining reviews: diff untracked files too (git add -N or status check).
- decompose lane: first agent hit its own context guard at 76% — decompose.ts complete,
  wiring/tests remain; it left step-by-step HANDOFF.decompose.md IN the worktree; respawn
  1/2 launched with NOTES.decompose.md + that handoff as opening context.
- decompose lane r1 reviews (Claude subagent + Codex thread 019f3e99-2389-7670-8229-6ca5e96eca90):
  BLOCK. Reconciled dispositions: (1) High BOTH: unbounded owns → 4000-cap breach +
  O(n²) DoS → FIX (MAX_OWNS_PER_LANE=32, MAX_OWN_PATH_LEN=256, fail-closed fit check);
  (2) High Codex-only: AGENT_HOME override reachable → DISPUTED w/ spec amendment
  (override is the operator escape hatch shipped via agent-home r4–r6 PASS; consistency
  across all direct-mode spawns incl. Bash-capable build agents; decompose is read-only) —
  put to Codex r2; (3) Med: raw agent values in error msgs → FIX (redact, 80-char excerpt);
  (4) Med: win32-absolute/backslash owns paths pass POSIX isAbsolute → FIX; (5) Low:
  phase-1 stuck active on decompose failure → FIX (terminal envelope); Low dead ??
  fallback = PRE-EXISTING on main, skip; Low injection-amplification planner→builder =
  ACCEPTED inherent (containment unchanged). Fix agent running (opus). Next: Codex r2
  reply on same thread w/ fix diff + amendment → Claude re-check → PASS → wt-commit.
  Build verify note: worktree node_modules is a symlink to main's (gitignored, keep);
  next build needs a real copy (Turbopack refuses symlink) — verified green once by
  fix-1 agent via cp; re-verify build on integration instead.
- decompose lane r2/r3: Codex r2 accepted 1,2(dispute),4; REFUTED the excerpt redaction
  (any agent content in logs) → excerpt() deleted, errors carry lane index + rule name
  only (overlap: entry indices). 394/394 + eslint clean. Codex r3 PASS, no new findings.
  VERDICT PASS → wt-commit + wt-verify clear. All three lanes reviewed.
- S4: 3 lanes merged clean, zero conflicts (decompose → ui → cli). Gate C on integration:
  402/402 (35 files), eslint clean, tsc 11 = main baseline, next build clean, gantry
  node --check OK. S5: Gate D L2 trace 6becbb2f clean (200 calls, longest identical run 1,
  no anomalies). Judge (opus, scoped, independent) running. Next: judge verdict → S6 human
  go/no-go → promote → S7 (cost vs $1.454, clean, HANDOFF.md agenda update, memory,
  delete batch files incl. HANDOFF.decompose-batch.md).
- S5 judge (opus, independent): PASS all 5 spec surfaces + both high-risk invariants
  (agent-content-free errors; blocked+cleanup on decompose failure). 402/402 + lint
  re-verified. ALL GATES GREEN (A budget, B ×3 cross-review PASS, C merge+suite,
  D trace clean + judge PASS). Awaiting S6 human go/no-go to promote → main.

status: COMPLETE 2026-07-07 — decompose-agent batch promoted to main 2c900fb (ff).
Gates: A $1.454/5.0; B cross-review PASS ×3 (cli r1, ui r1 w/ 2 refuted, decompose r3);
C 402/402 + lint + build, zero-conflict merges; D trace clean + judge PASS. Actual
subagent spend ~735k tokens across 8 agents (2 builds + 1 resume + 1 fix, 3 reviews,
1 judge) + 5 Codex calls. Follow-ups: decompose-split approval flow; live decomposed-run
smoke; ui RTL interaction tests (no jsdom); typed POST body contract.

smoke: PASS 2026-07-07 — live decomposed run (gantry up --lanes 2 localhost, gantry run
--decompose --model sonnet, run 8c5d9494..., 23s). Phase-1 decompose active→done (audit
cmd:decompose slug:decomp-af97e4c21648e76f spawn→exit 0); split into 2 truly disjoint
lanes (lane-0 committed ONLY SMOKE-DECOMP-A.md, lane-1 ONLY SMOKE-DECOMP-B.md); gates
A, B×2, D×2, C×2 all clear; both merged to integration; reset-base returned checkout to
main from clean tree; per-lane + decomp agent homes reclaimed (~/.gantry/agent-homes/
empty). Artifacts cleaned post-run: 2 lane worktrees+branches, integration branch,
data/plans/plan-af97e4c21648e76f.jsonl. main untouched (97848f2, clean). Quirk (low,
same family as haiku alias): audit argv says model:sonnet but snapshot usage reports
claude-haiku-4-5 for both lanes (738 in/14-20 out) — usage-extraction may pick the
wrong modelUsage key from the result envelope; revisit if model attribution matters.

# Console handoff-respawn loop (HANDOFF agenda #2) — base: main 97848f2
project: harness

## Subtasks
- slug: handoff  spec: "Port web/ context-guard handoff-respawn into console daemon build phase: sandbox handoff module (HandoffFs, guard prompt, clamps) + attempt loop around the runAgent seam"  owns: console/lib/sandbox/handoff.ts, console/lib/sandbox/handoff.test.ts, console/lib/sandbox/index.ts, console/lib/server/daemon.ts, console/lib/server/daemon.test.ts  tier: top
- slug: cli      spec: "Add CONTEXT_MAX_HANDOFFS to bin/gantry LIVE_ENV force-clear list"  owns: bin/gantry  tier: cheap

## Design decisions (S0, don't relitigate)
- Loop placement: daemon.ts build worker (inside the asyncPool callback) around the
  existing runAgent seam — runAgentInSandbox stays a one-shot primitive (mirrors web/
  placement; StartRunOptions.runAgent + new TEST-ONLY handoffFs seam drive it in tests,
  mirroring decomposeFn).
- New console/lib/sandbox/handoff.ts: HandoffFs {read,archive,sweep}, defaultHandoffFs,
  CONTEXT_GUARD_PROMPT, buildLanePrompt(brief, handoff?) composing over buildAgentPrompt,
  HANDOFF_INLINE_CAP=20_000 (head-truncate), MAX_HANDOFFS from CONTEXT_MAX_HANDOFFS
  (default 2, clamp 0..5; 0 disables). Re-export via sandbox/index.ts.
- TRACKED-FILE HAZARD (differs from web/): THIS repo tracks HANDOFF.md at root, so every
  lane worktree already contains it. Trigger is NOT bare existence: read(slug) returns
  content ONLY if `git -C <wt> status --porcelain -- HANDOFF.md` is non-empty (agent
  wrote/modified it). Tracked-and-unchanged => null.
- Archive moves the file OUT of the worktree to data/handoffs/<slug>.HANDOFF.<n>.md
  (repo-root data/ is gitignored) so wt-commit never commits handoff artifacts and a
  stale file can't retrigger. If HANDOFF.md was tracked-and-modified, restore baseline
  after the move (`git checkout -- HANDOFF.md`). Archive failure throws => lane fails
  (never merge a polluted lane).
- Post-loop sweep ALWAYS runs before returning (even at cap / nonzero exit): any
  agent-written HANDOFF.md is archived out so it can never reach wt-commit.
- Respawn trigger: exitCode===0 && attempt<MAX_HANDOFFS && read()!==null. Same worktree
  carries continuity. Isolated per-lane home IS re-provisioned per attempt (ensureAgentHome
  runs inside the spawn path per spawn — decided: keep; home holds only credential+gitconfig,
  wipe+recreate per attempt is deterministic and weakens nothing).
- Per-attempt: usage envelope emitted per attempt (builder verifies fleetReducer cost
  accumulation); audit row per attempt comes free (runAgentInSandbox audits per spawn).
  Gate D + cross-lane distinctness use the LAST attempt's sessionId (web/ parity).
- cli lane: CONTEXT_MAX_HANDOFFS joins gantry up's force-cleared LIVE_ENV set (live env
  is CLI-owned; inherited shell vars must not silently change the respawn cap).

## Checkpoint (context-guard 61%, orchestrator session 2026-07-07)
- Decompose live smoke: PASS (see smoke: line above) — agenda #1 fully closed.
- This batch (agenda #2): S0 done (subtasks handoff+cli, decisions above), Gate A clear
  $0.646/5.0. Next: wt-new handoff + cli -> background build agents (opus for handoff,
  haiku for cli, each pointed at its NOTES.<slug>.md in its worktree) -> S3 cross-review
  per lane -> integ-start/merge -> Gate C suite -> S5 eval+trace -> S6 human go/no-go
  (operator must explicitly approve promote; do NOT push to main without say-so).
- Server from smoke is DOWN; smoke artifacts cleaned; tree had only NOTES.* additions.

- cli lane: build (haiku, 1-line LIVE_ENV add) + cross-review r1 — Codex: NO findings
  (risk Low); Claude: Lows only (no --max-handoffs tuning flag, no CLI tests — both
  pre-accepted follow-ups). VERDICT PASS → wt-commit + wt-verify clear. reviewed.

checkpoint 2026-07-07T19:55-07:00 (session 362f9480, post-/clear resume): fix agent
(accecd550a67fa2b4) had auto-resumed in background and COMPLETED all r1 dispositions 1-8
(433 tests green, eslint clean, tsc 11-baseline) — verified independently. r2 dispatched:
Codex reply on thread 019f3ecc-2660-7e01-a169-3915b23021a1 ⇒ BLOCK, 1 NEW High:
staged rename (git mv HANDOFF.md OTHER.md) leaves rename TARGET staged ⇒ handoff content
committable; Claude re-check agent ac9df77a3049d8d97 ⇒ PASS (same rename issue rated Low,
"no new capability"), + Medium TOCTOU lstat→open needs O_NOFOLLOW+fstat, + Low empty-""
handoff respawns with no inline, + Low utf8 mojibake at byte-cap tail (ACCEPTED, cosmetic).
Stricter-wins ⇒ fixing: rename-target neutralization (porcelain -z parse, archive-out +
restore), O_NOFOLLOW bounded read, ""⇒null in read(). Then r3 on same Codex thread +
Claude recheck via SendMessage. r2 diff snapshot: scratchpad/handoff-r2.diff.

## Checkpoint 2026-07-07 ~22:30 (session 2, post-Gate-B)
- handoff lane r2 fixes DONE in worktree + committed (feat/handoff a0b9062): rename-target
  neutralization (targets before restoreBaseline, `.renamed-<i>.md` archive, `:(literal)`
  pathspec), O_NOFOLLOW fd read (TOCTOU), empty-"" neutralize→null.
- r3 Codex BLOCK (wildcard pathspec: target named `*` reverts WHOLE worktree — reproduced
  live) → fixed `:(literal)` + sanitized errors + regression test.
- r4 Codex BLOCK (symlink-ancestor escape via crafted `update-index --cacheinfo` R pairing —
  reproduced live) → fixed realpathSync(parent) containment guard, sanitized throw + test.
  Claude fresh agent (af1bdce31475d0508) r4 PASS w/ Low (status.renames=false) → fixed
  `-c status.renames=true`.
- r5 verdicts: Codex PASS (thread 019f3ecc-2660-7e01-a169-3915b23021a1), Claude PASS (delta
  matrix traced). Verify: 437 vitest green, eslint clean, tsc = 11 baseline.
- wt-commit handoff done, Gate B CLEAR ("lane feat/handoff committed and clean").
- NOTE: run harness.sh from /home/alter/HARNESS (repo root), NOT from a worktree (wt_path
  derives from cwd's toplevel).
- Diffs: scratchpad b10cf205-*/handoff-r{3,4,5}.diff. Session tasks #2-#4 = integ+GateC,
  S5 eval-gate, S6/S7 human-gate+closeout (steps 6-7 of session-1 HANDOFF).
- NEXT: integ-start; integ-merge handoff (spine first) then cli; Gate C on integration
  (vitest+eslint+tsc-11+next build+node --check bin/gantry).
- S5 (session 2): Gate C on integration ALL GREEN (437 vitest, eslint clean, tsc 11-baseline,
  next build compiled, node --check bin/gantry OK; merges 5f200e7+a47dfde zero-conflict).
  Gate D traces clean (both orchestrator sessions). S5 judge (opus, independent,
  ad2308950575a636d): PASS all 5 handoff surfaces + both high-risk invariants + cli spec;
  only pre-accepted Lows. AWAITING S6 HUMAN GO/NO-GO → promote.
status: COMPLETE 2026-07-07 — handoff-respawn batch promoted to main 5f200e7 (ff). r2→r5
cross-review found 2 more real Codex Highs (wildcard `:(literal)` pathspec revert;
symlink-ancestor escape via crafted index entry) — both live-reproduced BEFORE fixing,
both regression-tested; final verdicts Codex PASS + Claude PASS. Gates B/C/D clear, S5
opus judge PASS (all 5 surfaces + both invariants). Cost: Max-plan orchestrator + ~5
Codex calls (r2-r5 thread) + 3 review/judge subagents (~250k tok session 2) + 1 r1 fix
agent (session 1) — vs $0.646 route-cost estimate (plan-only; actual spend Max-plan
subscription + Codex calls).

smoke: respawn live smoke PASSED 2026-07-07 (gantry up --lanes 1 localhost, run
89a238e6..., 45s, --model sonnet). Attempt 1 created SMOKE-RESPAWN.md ("part one"),
wrote HANDOFF.md, exit 0 → daemon archived to data/handoffs/lane-a1bf46e509cfcf29-0
.HANDOFF.0.md, restored baseline, respawned → attempt 2 appended "part two" per the
inline handoff. Two usage envelopes (1008/1121 tok). Lane commit = ONLY SMOKE-RESPAWN.md
(+2 lines); HANDOFF.md on integration byte-identical to main (zero pollution). Gates
A/B/D/C clear, run done exit 0, homes reclaimed, checkout back on clean main. Artifacts
cleaned (worktree, lane+integration branches, plan file, handoff archive). Agenda #2
follow-up closed.

# Per-lane model routing (HANDOFF agenda #3) — base: main
project: harness

## Subtasks
- slug: routing  spec: "per-lane model routing: new route-tier module (route.py keyword heuristic ported) + daemon per-lane model (LaneStep.model, planRun routes auto per brief, writePlanFile per-lane tier/rate, build worker uses lane.model)"  owns: console/lib/server/route-tier.ts, console/lib/server/route-tier.test.ts, console/lib/server/daemon.ts, console/lib/server/daemon.test.ts  tier: top
- slug: cli      spec: "gantry usage text: document --model auto as tier-routed per lane"  owns: bin/gantry  tier: cheap
- slug: ui       spec: "LaunchConsole auto option label says tier routed per lane"  owns: console/components/LaunchConsole.tsx, console/components/LaunchConsole.test.tsx  tier: cheap

## Design decisions (S0, don't relitigate)
- Routing is a SERVER-SIDE deterministic keyword heuristic — port route.py's TOP/CHEAP
  regexes verbatim into console/lib/server/route-tier.ts (doctrine parity, cite source;
  top→opus, cheap→haiku, default→sonnet). NEVER agent-proposed: the decompose agent's
  output contract is UNCHANGED — a child-proposed tier would be child-controlled input
  steering spend (same family as the usage.model clamp, daemon.ts:80).
- Semantics: routing==="auto" ⇒ lane.model = routeModel(lane.brief) PER LANE (this is
  the feature); explicit haiku|sonnet|opus ⇒ run-global force, all lanes that model
  (operator override preserved, byte-identical to today). Decomposed lane briefs flow
  through planRun like any others ⇒ auto-routed per lane.
- LaneStep.model added; RunPlan.model KEPT as the run-global value (decompose agent
  model + the explicit-override source). writePlanFile prices per lane: tier =
  MODEL_TIER[lane.model], rate = TIER_RATE_USD_PER_MTOK[lane.model] — Gate A budgets
  the actual mix. Build worker passes lane.model to runAgent (the run-global `model`
  capture goes away).
- NO new API surface: POST /api/runs fields unchanged (auto is already the default);
  no HUD/contract change — per-spawn audit row (argv model:) + per-lane usage envelope
  already expose the routed/actual model. ponytail: HUD lane-tier badge if wanted later.
- cli + ui lanes are text-only operator visibility (auto ≠ "sonnet default" anymore).
- Router note: route.py said default for cli/ui (spec phrasing); orchestrator held CHEAP
  (literal one-line label edits) — inverse of the deck precedent, same rationale class.

## Checkpoint (context-guard 61%, S1 done 2026-07-07 ~23:45)
- Respawn smoke PASSED + cleaned (see smoke: line above); server DOWN.
- S0 done (subtasks routing/cli/ui + decisions above); NOTES.<slug>.md ×3 +
  NOTES.status.json written. Gate A CLEAR: $0.421/5.0 (routing top $0.397, cli+ui cheap).
- NEXT: wt-new ×3 → build agents (opus for routing, haiku for cli+ui, each pointed at
  NOTES.<slug>.md copied into its worktree; symlink console/node_modules into worktrees
  needing tests) → S3 cross-review per lane → integ-start/merge → Gate C → S5 → S6 human.
- S2 launched: worktrees routing/cli/ui off c3ef92e; 3 background build agents in flight
  (routing=opus, cli=haiku, ui=haiku). node_modules symlinked into routing+ui worktrees.
  If resuming: check `git -C ../HARNESS.worktrees/<slug> diff --stat` for build output,
  then S3 cross-review per lane (fresh Codex context: diff + one-line spec ONLY).
- cli+ui lanes: built to spec (cli +2 usage lines; ui 1-line label, suite 437 green) →
  cross-review r1 PASS both (Codex thread 019f406b-62cd-7872-9ed0-62d4368e2aa4: no
  findings; Claude: non-gating Low — texts describe routing-lane behavior, resolved by
  merge order routing-first) → wt-commit + wt-verify clear. Both reviewed. routing lane
  (opus) still building.
- routing lane Gate B (2026-07-08, post-/clear session): built by opus agent (448 vitest
  green incl. 11 new, eslint clean, tsc 11-baseline). Claude self-review PASS (2 Lows:
  brief-steered spend bounded by Gate A + 4-lane cap, documented in-code; writePlanFile
  seam-level assert). Codex r1 (fresh thread 019f4072-ee6b-7763-bdd8-f98c1f6daa57):
  BLOCK — 1 High "startRun tests violate pure-function vitest constraint" REFUTED with
  evidence (spec line means no-jsdom; pre-existing suite has 39 startRun tests + ~30
  identical env mutations, global afterEach deletes ENABLE_AGENT_EXEC at line 21);
  1 Medium plan.jsonl serialization not golden-tested = same finding as Claude's Low,
  kept as Medium follow-up (export-for-test or golden-file), non-gating. Codex r2 reply:
  PASS, no High+ held. VERDICT PASS → wt-commit + wt-verify clear. All 3 lanes reviewed.
- S4: 3 lanes merged zero-conflict (routing → cli → ui); repo-root untracked
  NOTES.{routing,cli,ui}.md spec copies moved to scratchpad first (identical copies rode
  the lane commits; merge refused to overwrite untracked). Gate C on integration ALL
  GREEN: 448/448 vitest (37 files), eslint clean, tsc 11 = main baseline, next build
  compiled, node --check bin/gantry OK.
- S5: Gate D traces CLEAN on BOTH orchestrator sessions (411b6ec8 prior + 89b735a6
  current, longest identical run 1, no anomalies — no EXPLOSION FP this round; short
  post-/clear sessions). Opus judge (independent, scoped) dispatched.
- S5 judge (opus, independent): PASS. Regex parity byte-identical to route.py:14,16;
  daemon wiring conforms (LaneStep.model, RunPlan.model run-global, per-lane pricing,
  worker lane.model, decompose-under-auto stays sonnet); no API surface change;
  invariant A (briefs steer spend only, provenance all server-derived from runId) and
  B (decompose.ts untouched, no tier field parsed) both verified; gates re-run
  independently (448 vitest + eslint clean). Lows: TIER_RATE flat blended rate =
  pre-existing ponytail; untracked NOTES.* outside the diff. ALL GATES GREEN
  (A $0.421/5.0, B ×3 PASS, C suite+build, D traces clean + judge PASS).

status: COMPLETE 2026-07-08 — per-lane routing batch promoted to main cf2090a (ff),
S6 human GO (promote + push). Gates: A $0.421/5.0; B cross-review PASS ×3 (cli+ui r1
no findings, routing r2 after 1 refuted High + 1 Medium follow-up); C 448/448 + eslint
+ tsc 11-baseline + next build + gantry check, zero-conflict merges; D traces clean ×2
+ opus judge PASS (route.py regex parity byte-identical; briefs-steer-spend-only and
decompose-contract-unchanged invariants both verified). Batch spanned 2 sessions via
context-guard HANDOFF respawn. Follow-ups (non-gating): plan.jsonl serialization
golden-test (Medium, accepted); ~~live mixed-tier --decompose smoke~~ (done, below);
HUD lane-tier badge ponytail.

smoke: mixed-tier live smoke PASSED 2026-07-08 (gantry up --lanes 2 localhost, gantry
run --decompose, model auto, run c0c24c3a..., ~100s). Audit rows prove the mix in ONE
run: decompose slug decomp-c0c24c3af6908364 model:sonnet (run-global under auto);
lane-0 (docs task) model:haiku; lane-1 (review/security task) model:opus. Per-lane
usage envelopes emitted (lane-1 908 tok; lane-0 530k tok $0.0978 — cache-inclusive,
non-gating oddity: the haiku docs lane burned far more than the opus lane). Gates
A/B×2/D×2/C×2 clear, run done exit 0, reset-base returned clean main, agent homes
reclaimed. Artifacts cleaned: 2 lane worktrees+branches, integration, data/plans/*
(incl. 6 stale plan files from prior runs), server down. Routing follow-up CLOSED.

# CLI tests (HANDOFF agenda #4) — base: main d0bff05
project: harness

## Subtasks
- slug: clitest    spec: "make bin/gantry requirable (require.main guard + test-only module.exports of parseArgs/baseUrl/csrfHeaders/api/resolveProject/renderEvent/findClaude — ZERO behavior change as a CLI) + vitest coverage: parser (long options, defaults, unknown-option/missing-value errors, positionals, --lane repeat, --decompose XOR --lane), baseUrl/csrfHeaders, and api/resolveProject/cmdStatus/followRun against an in-test node:http mock server (incl. SSE stream: filtered runId, done→0 / failed→1 lifecycle exit, malformed-JSON event skip)"  owns: bin/gantry, console/lib/cli/gantry-cli.test.ts  tier: default
- slug: installsh  spec: "tests/install.test.sh: bash asserts for install.sh against a TMPDIR fake repo + fake ~/.local/bin (fresh install symlink target, idempotent×2, uninstall removes only own symlink, refuses clobbering foreign non-gantry file, symlinked-repo canonicalization); install.sh itself read-only"  owns: tests/install.test.sh  tier: cheap

## Design decisions (S0, don't relitigate)
- Test seam: bin/gantry gets `if (require.main === module) main();` + module.exports of
  the pure/units above. Test-only export — argv behavior byte-identical. NO rewrite to
  ESM, NO extraction into lib files (single-file zero-dep CJS stance stays).
- CLI tests ride the EXISTING console vitest suite (console/lib/cli/gantry-cli.test.ts,
  createRequire(import.meta.url) → absolute path to repo-root bin/gantry). Reuses the
  installed harness; Gate C command unchanged for the vitest half. No jsdom (repo rule).
- Mock server = node:http on an ephemeral port inside the test file (listen(0)),
  torn down per suite. SSE = plain chunked text/event-stream response. process.exit
  in followRun: assert via injected/spied exit if needed — but do NOT refactor
  followRun's exit semantics; spy on process.exit in-test (vitest vi.spyOn).
- installsh lane: NEW tests/install.test.sh, plain bash + set -euo pipefail, no bats
  dep. HOME + repo faked under mktemp -d; PATH-warning case not asserted (cosmetic).
  Gate C gains one step: `bash tests/install.test.sh` (documented here; cheap, <2s).
- Router says cheap for clitest (\btest\b keyword); orchestrator holds DEFAULT —
  mock-server/SSE/exit-code logic + edits to a shipped CLI (same rationale class as
  the deck/cli precedents). installsh stays cheap.
- Lanes are file-disjoint (bin/gantry + new console test file vs new tests/ script).

## Checkpoint — S2 launched (2026-07-08, post-/clear resume)
- Gate A CLEAR $0.212/5.0 (plan.jsonl repo root). Worktrees clitest + installsh off
  main d0bff05 (`../HARNESS.worktrees/{clitest,installsh}`). NOTES.<slug>.md spec
  copied into each; console/node_modules + root node_modules symlinked into clitest
  worktree (vitest/eslint). 2 background build agents in flight: clitest=sonnet
  (bin/gantry test seam + console/lib/cli/gantry-cli.test.ts), installsh=haiku
  (tests/install.test.sh). NOTES.{clitest,installsh}.md also written at repo root
  (untracked spec copies; delete at S7 alongside plan.jsonl).
- If resuming: check `git -C ../HARNESS.worktrees/<slug> status --porcelain` +
  `diff --stat` for build output, then S3 cross-review per lane (fresh Codex context:
  one-line spec + `git -C <wt> diff main` INCLUDING untracked new files — `git add -N`
  first so the new test files show). Reconcile strict-biased → wt-commit + wt-verify.

## S2/S3 progress (2026-07-08, post-/clear session)
- BOTH build agents DONE. installsh (haiku): tests/install.test.sh built + indep-verified
  (19 PASS). Cross-review Codex (thread 019f40b1-2bc0-7212-8681-f110e4f974a1) BLOCK, 5
  findings — RECONCILED + FIXED by me directly (contained bash file): (1) High `|| true`
  masked exit codes → run_install() captures rc, asserts exit 0 on install/idempotent/
  uninstall/symlinked (non-zero only for clobber); (2) High weak canonicalization assert
  → strengthened + uninstall-via-symlink check; (3) Med `[ ! -e ]` passes dangling symlink
  → added `&& [ ! -L ]`; (4) Med test coupling → per-scenario subdirs under one TMP_BASE
  (idempotency stays sequential by design); (5) Low temp-dir leak (also my self-review) →
  single TMP_BASE removed on EXIT. Re-verified: 26 PASS 0 fail, run2 exit 0 self-clean.
  NEEDS: Codex r2 re-review of fixed file → then wt-commit + wt-verify.
- clitest (sonnet): bin/gantry test seam (require.main guard + module.exports of 9 units,
  agent says no hoist needed — all were top-level) + console/lib/cli/gantry-cli.test.ts
  (382 lines). Agent reported 481 vitest (448+33), node --check OK, eslint clean. bin/gantry
  diff = +8/-4 (12 lines). node --check OK confirmed by me. run-guard tests use spawnSync on
  real binary (guards live in unexported main). ponytail: cmdUp/cmdRun/findClaude-PATH-scan
  not unit-tested (argv[1]/spawn deps). NEEDS: indep vitest re-run + Codex cross-review →
  reconcile → wt-commit + wt-verify.
- THEN S4 integ-start + integ-merge clitest then installsh; Gate C on integration adds
  `bash tests/install.test.sh` step. S5 trace+judge. S6 human. S7 cleanup (delete repo-root
  NOTES.{clitest,installsh}.md + plan.jsonl, status line, HANDOFF agenda #4 DONE).

## S3→S4→GateC DONE (2026-07-08, resume session) — at S5
- clitest indep re-verify: 483/483 vitest, eslint clean, node --check OK. Seam diff = only
  `require.main` guard + `module.exports` of 9 units (byte-identical CLI). Codex r2 (thread
  019f422c) BLOCK×3 → fixed (cwd-indep GANTRY_BIN; follow-mode tests record mock hits) →
  r3 BLOCK×2 NEW (failed→1 still false-green via stream-drop/unknown since cmdRun maps every
  non-"done" to exit 1; followedStream proved only URL not SSE-Accept branch) — BOTH CONFIRMED
  vs bin/gantry (followRun:225 "unknown", cmdRun:238). FIXED: (A) stream held OPEN after
  terminal frame (no res.end) so child can only exit by recognizing the frame — MUTATION-TESTED
  (broke lifecycle check → failed→1 now TIMES OUT, done→0 also fails; then restored bin/gantry
  byte-identical); (B) hit recorded inside validated SSE branch as marker "SSE /api/fleet/stream".
  → Codex r4 PASS. Claude self-review (code-read + mutation) concurs → clitest cross-review PASS.
- clitest wt-commit: rm node_modules SYMLINK first → commit 7233dbf = ONLY bin/gantry (+8/-4) +
  gantry-cli.test.ts (508 ln). Gate B CLEAR. installsh Gate B re-confirmed (636e2f5, 1 file).
- S4: integ-start (branch `integration`) + integ-merge clitest then installsh — zero conflict.
  NOTES/HANDOFF tracked-mods carried over uncommitted; untracked NOTES.{clitest,installsh}.md +
  plan.jsonl NOT on either lane branch (verified) → no merge balk.
- Gate C on integration ALL GREEN: vitest 483/483, eslint clean, tsc=11 baseline (NEW error
  TS7006 in gantry-cli.test.ts:340 `mock.calls.map(args=>...)` implicit-any → annotated
  `(args: unknown[])`, committed integration f149661 — pure type fix, no logic change),
  next build OK, node --check bin/gantry OK, `bash tests/install.test.sh` 29 PASS exit 0,
  live-argv `node bin/gantry` no-arg → usage exit 2 (designed; proves require.main guard runs
  main() when executed but not on require).
- NEXT (S5): harness.sh trace <orchestrator session ids>; scoped opus judge (surfaces = S0
  decisions + NOTES.{clitest,installsh}.md; high-risk: bin/gantry byte-identical + exports
  test-only; installsh canonicalization direction). Then S6 human go/no-go → promote → S7 cleanup.

status: COMPLETE 2026-07-08 — agenda #4 CLI tests promoted to main f149661 (ff), S6 human GO
(promote; push held for separate say-so). Gates: A $0.212/5.0; B cross-review PASS ×2 (clitest
Codex r4 after r2 BLOCK×3 + r3 BLOCK×2 — the r3 High "failed→1 false-green via stream-drop"
was live MUTATION-TESTED then fixed by holding the mock SSE stream open; installsh Codex r3
PASS prior session); C 483/483 vitest + eslint + tsc 11-baseline + next build + node --check
bin/gantry + install.test.sh 29/0 exit 0 + live-argv usage exit 2, zero-conflict merges; D
both orchestrator traces clean (1291d2b1 + 16c1ac7d, no anomalies) + opus judge PASS (bin/gantry
byte-identical, exports test-only, installsh canonicalization direction sound, follow-mode not
false-green). One Gate-C fix on integration (f149661): tsc noImplicitAny annotation on
mock.calls map arg (pure type, no logic change). Promote auto-cleaned both lane worktrees +
feat/clitest + feat/installsh + integration branches. Follow-up (non-gating, ponytail in test):
cmdUp / findClaude-PATH-scan branch not unit-tested (argv[1]/spawn deps).

# Non-gating follow-ups batch (post-agenda) — base: main ffb18be, branch feat/followups
project: harness
checkpoint: 2026-07-08 (context-guard soft limit; group-A code changes done, gates not yet run)

## Scope (from HANDOFF "Low/background" + accepted follow-ups). Group A = code I land direct;
   B = operator-gated (draft only); C = live-smoke (needs running server + creds).
Group A (DONE in working tree, direct edits, NOT yet gated/committed):
1. SSE reconnect — bin/gantry followRun: was one-shot→exit-hint. Now resumes across drops via
   ?lastEventId= (tracks last `id:` seq; server replay is exclusive so gapless/dup-free), bounded
   MAX_RECONNECTS=5 + linear backoff (300ms base, 3s cap), reset on any frame. STREAM_END
   ("__console_end") recognized → stop (finite fixture). never-opened stream = fast fail (no
   retry storm). Header ponytail note updated. node --check OK.
2. usage modelUsage key fix — agent-runner.ts parseAgentUsage: entries[0] → DOMINANT entry by
   total token volume (fixes haiku side-call mis-attribution). `>` keeps single-entry + tie=insertion
   order deterministic. +1 test (multi-model opus-dominant).
3. plan.jsonl golden-test — daemon.ts: extracted pure `serializePlanFile(plan)` (exported),
   writePlanFile calls it. +2 tests (mixed-tier haiku/opus golden bytes; single sonnet).
4. findClaude tests — gantry-cli.test.ts: +6 (abs-exec return, non-abs die, missing/non-exec die,
   dir-trap die, PATH scan w/ symlink realpath + empty-seg skip, no-claude die) + 2 SSE reconnect
   (resume-from-id happy; give-up-after-budget). Trailing ponytail reworded (only cmdUp undriven).
FILES TOUCHED: bin/gantry, console/lib/sandbox/agent-runner.ts (+.test.ts),
  console/lib/server/daemon.ts (+.test.ts), console/lib/cli/gantry-cli.test.ts.
NEXT: cd console && npx vitest run (expect 483 + 2 usage + 2 plan + 8 cli = 495-ish) + eslint +
  tsc 11-baseline + next build + node --check bin/gantry. Then cross-review the diff (single
  branch, small) → fix → commit → human go/no-go → push. THEN group B drafts (VPS drop-mode
  scripts+threat-model §7; ntfy deep-link verify) + group C live smokes queued for operator session.
Group B/C NOT started. HANDOFF agenda items #5 (operator DoD: phone approve, ntfy tap, graph
  showpiece) + #6 (VPS drop-mode) remain — mostly operator-hands; I prep review-ready drafts.

## Group A cross-review — r1 BLOCK → fixed → r2 (2026-07-08, resume session)
- Gate C re-confirmed green before review: 494 vitest, eslint clean, tsc 11=baseline, node --check OK.
- Cross-review r1: Codex (thread 019f4267-4d62-7bb2-8887-95b6845aa351) BLOCK 1 High + 1 Med + 1 Low;
  Claude self-review CONCURS on all three (traced the High against the live server stream route).
  - HIGH (bin/gantry followRun): reconnect budget `failures=0` reset was nested inside `if(idLine)`
    → only id-bearing frames refilled it. But the LIVE server (app/api/fleet/stream/route.ts) sends
    id-less frames on a healthy connection: `: open`, `: ping`/15s, and id-less `sync` resync frames.
    So a quiet run behind a flaky proxy (only pings between drops) could exhaust MAX_RECONNECTS and
    return "unknown" (→cmdRun exit 1) prematurely while the server is alive — contradicting the code's
    own "reset whenever any frame arrives" header note + "consecutive SILENT reconnects" knob comment.
    FIX: moved `failures=0` to fire on EVERY complete frame (event/sync/comment); `if(idLine)` now only
    advances the resume cursor. A truly silent server sends nothing → still exhausts the budget (the
    existing give-up test, res.end() with no frame, still passes hits=6→unknown).
  - MED (test guard for the High): added gantry-cli.test.ts test — 6 ping-then-drop cycles (>MAX_RECONNECTS)
    then a terminal frame on the 7th; resolves "done" ONLY if id-less pings reset the budget (old code
    → "unknown" at 6). Fast: failures oscillates 0→1 so backoff stays 300ms (~1.8s total).
  - LOW (tie coverage): added agent-runner.test.ts test — two model entries, EQUAL total tokens →
    asserts first-inserted (sonnet) wins, locking the `>`-not-`>=` insertion-order contract.
- Affected 3 test files: 151 pass (+2 new). Full Gate C after fix: 496 vitest, eslint clean, tsc 11=baseline.
- Cross-review r2: Codex (same thread) PASS — all 3 r1 findings resolved, no new findings. Claude concurs.
  VERDICT: PASS. Group A cross-review CLOSED.
status: Group A cross-review PASS 2026-07-08; committed to feat/followups (one commit). NEXT: human
  go/no-go → merge feat/followups → main → push held for operator say-so (main also unpushed since
  f149661 — confirm push scope with operator). THEN Group B drafts (VPS drop-mode #6 + ntfy deep-link
  #5 verify) + Group C live smokes (operator session). Do NOT merge/push without say-so.

## Group B — CLOSED 2026-07-08 (already-landed; docs reconciled, operator go)
Investigated on "start Group B": the HANDOFF listed B as NOT started, but its substantive work was
already delivered + live-validated by the #15/#16a/#17b/#17c workstreams. No duplicate drafting done.
- #6 VPS drop-mode: egress-firewall (`deploy/tier3/agent-egress.nft` + `egress-proxy/`), resource-limit
  (`agent-exec-wrapper.sh` cgroup scope), agent-N-account (`01b-provision-lane-users.sh`) all committed;
  threat-model-agent-exec §7 signed off PASS/APPROVED 2026-06-24; `ENABLE_AGENT_EXEC=1` live on VPS,
  `conformance-multilane.sh` 17/17 PASS (`docs/HANDOFF-17c.md`). NOTHING to draft.
- #5 ntfy deep-link: VERIFIED CORRECT. `notifier.ts:37 deepLink()` uses CONSOLE_BASE_URL (alias
  NTFY_DEEPLINK_BASE), abs-link passthrough, runRoute(runId) fallback, relative degrade — no hardcoded
  host; `notifier.test.ts` covers both base-env paths + Click header. No code change.
- Doc fix (only genuine stale artifact): `deploy/tier3/GAPS.md` was the pre-completion draft-review; added
  a dated SUPERSEDED banner + flipped its two stale `OPEN` cells (§7, G1/G9 Bash/commit) to RESOLVED with
  evidence (Bash in DEFAULT_TOOLS agent-runner.ts:139 + daemon wt-commit daemon.ts:532). Doc-only, no code.
Remaining truly-open = operator-hands only: Group C live smokes (graph showpiece, phone-approve, ntfy tap).

## Group C live smokes — IN PROGRESS 2026-07-08 (workstation console, tailnet 100.72.193.64)
Session walking operator through GROUP-C-CHECKLIST.md against the live workstation console.
- Env found: console live on :3000 (HARNESS_LIVE=1 ENABLE_AGENT_EXEC=1 LANE_CONCURRENCY=1),
  no active run, no NTFY_* envs, CONSOLE_BASE_URL=127.0.0.1:3000 (not phone-reachable).
- C1 DONE (partial): drove Playwright → /graph/harness-57f84330 → "Show full swarm" = 7 agent
  nodes, renders clean but IDLE (0 edges, no run). Captures in scratchpad/graph-swarm-c1*.png.
  Did NOT overwrite curated graph-swarm.png. Re-shoot during a live run for the money shot.
- KEY FINDING: server notifier notify() fires ONLY in daemon ingest path (daemon.ts:339);
  fixture mode (HARNESS_LIVE unset) is CLIENT-SIDE optimistic → does NOT fire ntfy and gate
  approve is local, not a real POST. So pure fixture = hollow C2 + no C3.
- PLAN (corrected): smoke C2/C3 via DRY daemon run = HARNESS_LIVE=1 + ENABLE_AGENT_EXEC UNSET
  (daemon.ts:424 agentRan=false) → real ingest/notify/gate paths, NO real agent/creds. gantry
  up forces ENABLE_AGENT_EXEC=1 so launch next start directly with custom env on :3001, tailnet
  host, NTFY_URL/NTFY_TOPIC set + CONSOLE_BASE_URL=http://100.72.193.64:3001.
- Operator chose: fixture-on-3001 (superseded by dry-daemon per finding above) + ntfy ready
  (awaiting topic name). NEXT: get topic → launch :3001 dry-daemon → gantry run --url :3001 →
  watch raised gate + ntfy push → operator approves from phone → re-capture C1 live.

### Session 2 (2026-07-08 resume) — C2 model corrected + C2/C3 both server-confirmed
- **C2 was NOT actually blocked.** The prior "need the daemon to PARK at a *waiting* gate"
  premise was the wrong model. The gate POST route (app/api/runs/[id]/gate/route.ts) is
  DECOUPLED from daemon pausing — its own ponytail (lines 9-10) says daemon-pause-at-gate is a
  future step. The route only needs a run SNAPSHOT that contains a gate with status "raised";
  it records the operator verdict as a persisted+broadcast `gate` envelope (appendEvent+publish),
  NOT a snapshot mutation. A dry-run that fails closed at wt-verify STILL leaves Gate B "raised"
  in its snapshot — exactly an approvable gate. So the failed dry-run WAS the vehicle all along.
- **Approvable run already in console.db: `55af2784b4a9841d411f3036`** — gates
  [A:clear, B:raised], run page 200 on :3001. This is the operator's real phone-approve target.
- **C2 approve path: SERVER-CONFIRMED (PASS ✓).** Seeded a throwaway run w/ raised Gate B via
  upsertRun, POSTed `{gateId:B,status:approved}` THROUGH live :3001 (real CSRF: x-harness-request
  + Origin=Host) → 200 {ok:true}, decision persisted as gate event, publish() broadcast ran.
  Seed deleted after; 55af left pristine. Helper: console/scripts/verify-c2-approve.mts (untracked).
- **C3 re-fired fresh (PASS ✓ server-side).** Called REAL notifier.notify() (run-failed) via
  console/scripts/fire-c3-push.mts w/ live env → posted:true to topic gantry-smoke-c3, deep-link
  http://100.72.193.64:3001/run/e9e460ed64c2abb3dceaf19f, retained 12h. Helper untracked.
- **DISCOVERED BUG (middot confirmed real, NOT curl display):** ntfy push landed with Title
  "Run failed � HARNESS" — the `·` (U+00B7) in notifier.ts:53 Title HEADER is byte-mangled
  (HTTP headers are latin-1; fetch sends UTF-8 → replacement char on phone). Message BODY middot
  renders fine (UTF-8 body). One-line fix: ASCII separator in the Title header. FOLLOW-UP, unfixed.
- **REMAINING = operator physical taps only:** (C3) tap ntfy push → opens e9e460 run page;
  (C2) open 55af run page on phone → tap approve on Gate B. (C1 money-shot) still needs a live
  agent run vs a THROWAWAY repo. When taps confirmed → record "Group C — DONE".

### Session 2b — operator hit UI bugs approving; ROOT-CAUSED 3 seams (C2 UI NOT actually usable as-is)
Operator report: "approve/reject don't work on VECTOR; no gates on harness-c2verify or HANGAR, they stay stuck."
Traced all of it — the earlier "open 55af run page and approve" plan is WRONG (RunFocus approve is optimistic-only). The real seams:
1. **Fixture bleeds into LIVE mode.** app/page.tsx:14 ALWAYS `foldFleet(fixtureEnvelopes())` into the
   fleet-home initial state, even when HARNESS_LIVE=1. So the browser shows demo lanes vector
   (run-dropship, has raised Gate B), hangar (run-console, healthy), ledger (run-memoryos) alongside
   live runs. Clicking Approve on VECTOR → FleetHome.onApprove sees live=true → postGate(run-dropship…)
   → POST /api/runs/run-dropship/gate → **404** (no such live run) → fire-and-forget error swallowed →
   "button does nothing." EMPIRICALLY CONFIRMED: curl approve run-dropship & run-console → 404; 55af → 200.
2. **RunFocus (/run/[id]) approve is OPTIMISTIC-ONLY.** components/run/RunFocus.tsx:98-105 onApprove =
   emitAll(buildGateApproveEnvelopes) — NO `live` check, NO server POST (comment: "so a live bridge can
   route these later" = never wired). So approving on the run-focus PAGE never hits the server. Only
   FleetHome.onApprove has the live→postGate branch. ⇒ the ONLY real-POST approve UI is the fleet home lane.
3. **No active live run is ever parked at a raised gate.** Daemon fails closed (doesn't pause), so a
   real run finalizes (ended_at set) → likely not an activeLane → 55af (failed) probably doesn't render
   as an approvable fleet-home lane. NEEDS CHECK: activeLanes/laneOrder selectors — does a finalized
   run with a raised gate show a lane? If not, there is NO UI path to really-approve 55af.
- **harness-c2verify phantom = MY verify-c2-approve.mts seed.** I upsertRun'd c2verifyseed (unfinalized,
  Gate B raised) then POSTed approved; the approved event published to the :3001 broker's in-memory ring.
  I deleted the DB row but the broker still replays the event → shows as a STUCK run whose gate already
  flipped to approved (hence "no gates"). Cosmetic; evict by RESTARTING :3001 (broker re-seeds from DB, clean).
- **DB truth:** console.db has ONE project harness-57f84330, 15 runs. Runs with B:raised = 55af, ab5991, e3b141
  (all outcome=failed). NO vector/hangar/harness-c2verify rows (those are fixture + broker-phantom).
- **CLEAN C2-UI VEHICLE (proposed, not yet done):** seed a PERSISTENT, UNFINALIZED live run (no ended_at)
  under a clear project (e.g. harness-c2-smoke) with a raised Gate B, LEFT un-approved → it renders as an
  ACTIVE fleet-home lane with a working Approve → phone taps → real postGate → 200. Approve path is 100%
  real (only gate-raise seeded, same envelope the daemon uses). Then delete seed + restart :3001.
- **REAL FIX (code, needs go + rebuild + cross-review):** (a) app/page.tsx — don't fold fixture when
  HARNESS_LIVE=1 (one-liner; fixture is the demo fallback). (b) wire RunFocus.onApprove/onReject to
  postGate in live mode (parity with FleetHome). Both are `next build` + :3001 restart. NOT a smoke edit.
- NEXT (this session): confirm activeLanes shows a finalized-run gate lane; decide with operator between
  quick seed-vehicle vs the code fix; clean the phantom. Nothing committed/pushed.

# Group C — throwaway run "won't start" fix + agent-exec wiring (2026-07-08 s3)
ROOT CAUSE: daemon finally (daemon.ts:578) calls ONLY reset-base (switches HEAD to base);
never deletes the `integration` branch or lane worktrees. Only promote (success) deletes
integration. Throwaway smokes fail-closed → never promote → each failed run leaves
integration → next run's `integ-start` dies ("integration already exists — clean first",
harness.sh:296) → looks like nothing starts (seam #3: failed run never shows on fleet board).
Confirmed live: cleaned /tmp/c2-throwaway → POST /api/runs started clean (Gate A clear,
Gate B raised) → failed → left integration again (reproduced the poisoning).

DECISION: failure-path cleanup ONLY. Success intentionally leaves integration (operator
promotes via gate route promote-to-main kind behind ENABLE_PROMOTE_TO_MAIN, or manual clean).
FIX (in progress): add {cmd:"clean"} to HarnessSubcommand+buildArgs; daemon finally, on a
`failed` flag, best-effort runSub({cmd:"clean"}) AFTER reset-base. Update daemon.test.ts
order asserts (failure cases gain trailing "clean").
ponytail ceiling: multi-lane Gate-C conflict leaves tree dirty on integration; clean's safe
`git branch -d` can't remove current/dirty branch → still needs manual clean (rare; throwaway
smoke is single-lane fail-at-B so unaffected).

Gate B REALITY (corrects prior msg): wt-verify Gate B is pass/fail, NOT an interactive pause.
Real agent that commits CLEARS Gate B → run proceeds to merge → done (integration left).
A raised (approvable) Gate B only happens on failure (no-op/dirty). Approve POST records a
decision but does NOT resume the harness (seam #2, RunFocus was optimistic-only, now wired to
POST). So ENABLE_AGENT_EXEC=1 makes runs REAL (real commit/trace/graph) but Gate B will CLEAR
on success — the phone-approve tap needs the deep-link on a still-in-ring failed run, or the
headless verify-c2-approve.mts path.

ENABLE_AGENT_EXEC=1 wiring: restart :3001 (pid 263685) with agent-exec on (real agent vs
/tmp/c2-throwaway). Restart empties broker ring (loses stale 846a92b). Rebuild needed (next
start on built app) for the daemon.ts change.

## tracehook Gate-D fix — s5 (2026-07-08 14:0x)
- IMPLEMENTED in console/lib/sandbox/agent-runner.ts + tests. Full suite 508→ (agent-runner 71) pass, tsc=11 baseline, eslint clean. NOT committed, NOT smoke-tested live yet.
- Change: buildAgentArgs appends `--settings <json>` injecting the harness's OWN eval-gate PostToolUse trace hook (absolute TRACE_HOOK_PATH); buildInvocation gained `projectDir?` → sets CLAUDE_PROJECT_DIR=worktree cwd (direct: spawnEnv; drop: --preserve-env); spawnAgent passes cwd. Byte-identical when projectDir omitted.
- HARDENING (from cross-review): traceHookCommand() validates TRACE_HOOK_PATH is shell-safe-absolute (/^\/[A-Za-z0-9_./-]+$/) AND statSync().isFile() — fails CLOSED with AgentExecError before spawn. Closes the AGENT_TRACE_HOOK_PATH override to injection.
- CROSS-REVIEW (Claude×Codex, sandbox mandatory): round1 BLOCK (2 High). Fixes applied. round2: #1 injection RESOLVED; #2 cwd-resolution → I converted silent-miss to LOUD throw + documented HARNESS_REPO operator contract; residual (existing-but-WRONG hook at bad cwd) is BENIGN (CLAUDE_PROJECT_DIR directs output; missing-hook fails closed → never a false PASS). Downgraded #2 to fails-safe Medium; awaiting operator tie-break before commit.
- REMAINING: (1) operator OK on #2 tie-break; (2) rebuild+restart :3001 (kill pid 343982, env MUST include HARNESS_SCRIPT_PATH + ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1 AGENT_CLI_PATH); (3) live smoke POST run to projectId harness-57f84330, CSRF x-harness-request:1 + origin; confirm Gate D PASSES + trace lands in <worktree>/.claude/traces + copied to /tmp/c2-throwaway/.claude/traces; (4) commit on feat/followups (NO push); (5) force-teardown leftover lane worktrees.

## tracehook — s5-resume (2026-07-08, post-/clear) — STEP 1 DONE
- FIXED the HARNESS_REPO collision (HANDOFF resume step 1). agent-runner.ts: replaced the
  TRACE_HOOK_PATH const (was `process.env.HARNESS_REPO ?? cwd/..`) with resolveTraceHookPath():
  AGENT_TRACE_HOOK_PATH override → HARNESS_SCRIPT_PATH sibling (dirname/../eval-gate/trace-log.py)
  → cwd/.. fallback. HARNESS_REPO no longer consulted for the hook path (it points at the TARGET
  repo /tmp/c2-throwaway → would fail closed on every live run). Updated the const comment + all 3
  traceHookCommand() error strings (HARNESS_REPO→HARNESS_SCRIPT_PATH).
- TESTS: +2 in agent-runner.test.ts (HARNESS_SCRIPT_PATH sibling resolution; HARNESS_REPO-ignored
  collision regression — worktreePath aligned to <HARNESS_REPO>.worktrees so containedWorktree
  doesn't mask the assertion). agent-runner file 73 pass.
- VERIFY: full console suite 511 pass, tsc 11 (baseline, 0 in touched files), eslint clean on both files.
- IN PROGRESS: step 2 cross-review of the delta (Codex fresh + Claude self). diff snapshot at
  scratchpad/tracehook-delta.diff. Then steps 3-7 (rebuild/restart :3001 w/ HARNESS_SCRIPT_PATH+
  AGENT_TRACE_HOOK_PATH guard, live smoke, verify trace, commit no-push, cleanup).

## tracehook — s7 (2026-07-08, post-/clear resume) — CONTAINMENT TESTS + VERIFY DONE, cross-review CLOSED
- CONTAINMENT HARDENING now fully tested (HANDOFF step 1). Added 4 tests to agent-runner.test.ts
  in NEW describe "buildAgentArgs — trace-hook CONTAINMENT": (a) hook INSIDE target repo → THROWS;
  (b) hook INSIDE a lane worktree → THROWS; (c) shell-safe ASCII SYMLINK whose realpath lands in
  the worktrees dir → THROWS (realpath catches it, passes charset+isFile first); (d) false-reject
  guard: hook in a SIBLING harness repo (disjoint from target repo+worktrees) → ACCEPTED, command
  embeds it. Pattern mirrors the relocateTrace DESTINATION-containment setup (mkdtempSync realpath'd,
  stub HARNESS_REPO, vi.resetModules + re-import; laneSpec worktreePath aligned to
  <HARNESS_REPO>.worktrees so containedWorktree doesn't mask the hook-containment throw).
- VERIFY (step 2): agent-runner.test.ts 77 pass; FULL console suite 515 pass (38 files);
  tsc 11 = baseline (0 in lib/sandbox); eslint clean on the 3 touched files. GREEN.
- CROSS-REVIEW CLOSED (step 3): the isAgentWritablePath containment guard + these 4 regression
  tests resolve Codex #1 (override accepts worktree-controlled abs path) + #2 (statSync follows a
  symlink → worktree) + #3 (no regression test). Self-reconciled VERDICT = **PASS** (evidence
  concrete: (a)/(b) cover #1, (c) covers #2 realpath-follow, (d) proves no false-reject of the legit
  harness-repo hook). Operator tie-break (s6 AskUserQuestion) "add realpath containment" satisfied.
- REMAINING (steps 4-8, live smoke + commit): rebuild+restart :3001 (RE-CHECK old pid — was 343982
  in s5, likely dead: `pgrep -af "next start"`) with env ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1
  AGENT_CLI_PATH=/home/alter/.local/bin/claude HARNESS_LIVE=1 HARNESS_BASE=main
  HARNESS_REPO=/tmp/c2-throwaway HARNESS_SCRIPT_PATH=<repo>/.claude/skills/harness/harness.sh
  NTFY_URL/NTFY_TOPIC + belt-and-suspenders AGENT_TRACE_HOOK_PATH=<repo>/.claude/skills/eval-gate/
  trace-log.py; POST run to projectId harness-57f84330 (CSRF x-harness-request:1 + origin
  http://100.72.193.64:3001); confirm Gate D reaches `done`; verify trace lands in <worktree>/
  .claude/traces + copied to /tmp/c2-throwaway/.claude/traces; COMMIT on feat/followups (NO push);
  harness.sh clean + force-remove leftover lane worktrees. CODE IS COMMIT-READY (cross-review PASS).
