# HANDOFF — Dashboard rebuild per DESIGN_SPEC.md (harness run, Batch A) — 2026-07-06T00:00Z

## Current state
- DESIGN_SPEC.md: complete, dual-signed 2026-07-06, committed to main (80c7989). It is the binding spec.
- Harness state machine: S0–S3 DONE for Batch A. Single subtask `foundation` built in worktree /home/alter/HARNESS.worktrees/foundation (branch feat/foundation) by an Opus agent: new `console/` Next.js 16 app — CRT tokens (amber voice, green=live only, Oxanium display face), provider-agnostic multi-run event contract + reducer, project discovery (named roots), SQLite persistence w/ 20-run retention, SSE with Last-Event-ID gapless replay, ntfy notifier, fleet home + launch console + ⌘K palette on fixture data. 44 vitest tests green, `npm run build` green, dev-serve verified.
- Gate A: clear ($2.81 est vs $5.00 ceiling, routed top/opus; plan.jsonl at repo root).
- Gate B (cross-review): round 1 BLOCK (3 must-fix: Last-Event-ID null→0 frame-0 drop; SSE client reconnect losing cursor; green on approve buttons). Fixed in place + 9 new resume tests; round 2 Codex verify: all RESOLVED, PASS.
- S4: `integration` branch created; feat/foundation merged clean (36 files, +5472).
- S4 Gate C IN PROGRESS: full suite running in background shell byv3rxmsr (console npm ci + vitest + build, then web vitest), output: /tmp/claude-1000/-home-alter-HARNESS/9831dd07-2651-4487-afb9-8eeb0ef93d9b/tasks/byv3rxmsr.output. Repo is currently ON the `integration` branch.
- NOTES.status.json: {"foundation": "reviewed"} (merged event emitted by harness.sh; set to "merged" once Gate C is green).

## Decisions
- Two-batch structure: greenfield views can't import an unpromoted contract, so Batch A = single foundational slug; Batch B (run-focus, deck, graph — parallel worktrees) + Batch C (polish-wire) come AFTER promote. Recorded in NOTES.md.
- Gate B tie-breaks (orchestrator): no app-level auth = accepted (tailnet is the §7 access boundary — document, don't build); persist/notifier unwired + non-wall-clock health = accepted ponytail scope, wiring lands with the Batch B live bridge.
- Codex re-review of fixes used the fix delta diff only (scratchpad foundation-fix.diff) — full-diff re-review unnecessary.

## Files touched
- DESIGN_SPEC.md — full signed spec (committed, main)
- NOTES.md — appended batch plan, checkpoint, Gate B round-1 findings (committed then appended more; append-only)
- NOTES.foundation.md — subtask spec (committed)
- NOTES.status.json — {"foundation": "reviewed"}
- plan.jsonl — Batch A budget plan
- console/** — entire new app (on feat/foundation + integration)
- /tmp scratchpad: foundation.diff, foundation-fix.diff (review artifacts, disposable)

## Next steps
1. Read Gate C result from byv3rxmsr output (or re-run: `cd console && npx vitest run && npm run build; cd ../web && npx vitest run` on integration). Red → HALT on integration, fix there; green → continue.
2. S5 on integration: eval-gate Layer 1 (regression HARD; see .claude/skills/eval-gate) + `harness.sh trace <session>` (traces in .claude/traces/; if missing for subagent sessions, warn and skip L2 per skill).
3. Set NOTES.status.json foundation→merged. S6: ask the human go/no-go, then `.claude/skills/harness/harness.sh promote` (--ff-only) and `harness.sh clean`, `reset-base`.
4. Batch B (off new main): S0 decompose 3 parallel slugs — run-focus (app/run/[id] route: phase rail focus-size, live feed, gate cards, budget meters, wired to store/SSE), deck (app/deck route: trace forensics explorer w/ search+filters, diff viewer, evals, burn charts), graph (app/graph/[projectId]: activity-driven progressive disclosure + showpiece full-graph, 60fps) — each owns disjoint console/ paths; write NOTES.<slug>.md files; route+budget; build in parallel worktrees; Gate B each; merge foundational-first (run-focus → deck → graph).
5. Batch B live-bridge follow-ups (from Gate B round 1, logged in NOTES.md): wire persist+notifier into the event path, wall-clock nowSec for health, events cap per run + LIMIT on eventsSince, fix N+1 in /api/projects, onApprove gate-id-aware phase transition.
6. Batch C: polish-wire slug (drawer overlays within run view, palette entries, chime, phone restack pass, 3 name proposals + wordmarks in Oxanium — spec §3).
7. DoD checklist in DESIGN_SPEC §8 is the batch-level definition of done (live run e2e, phone approval, ntfy deep-links, SSE kill test, capture-worthy showpiece).

## Dead ends / open questions
- Rejected: 5 parallel greenfield lanes in one batch (view lanes can't compile against a contract that exists only in a sibling worktree). Staged batches chosen instead.
- Open: eval-gate Layer 1 regression suite contents for this repo — check .claude/skills/eval-gate for the runner; capability evals are soft/record-only.
- Open: `harness.sh trace` needs a session id; build agents ran as subagents of this session — verify .claude/traces/ has a usable session file, else skip L2 with a warning (per skill preconditions).
- Note: web/ untouched and still green locally as of Batch A start; old Umbrella stays as reference until the console/ successor reaches DoD.
