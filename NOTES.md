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
