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
