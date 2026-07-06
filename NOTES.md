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
