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
