---
name: harness
description: Top-level orchestrator that runs the full four-phase agent harness end to end — decompose a task, route+budget-gate it (Phase 4), build each subtask in an isolated worktree gated by a cross-review PASS (Phases 1-2), merge sequentially through an integration branch, run evals + a trajectory check (Phase 3), then fast-forward to main. Use on "run the harness", "full pipeline", "build this end to end", or to drive cross-review / parallel-build / eval-gate / route-cost as one flow. Also runs under /loop (loop mode): each tick advances the state machine one step, with harness.sh loop-tick as the deterministic stop rule.
---

# The Harness (orchestrator over the four phases)

You own the two *subjective* steps — decomposition and the cross-review
reconcile/verdict — and delegate the *mechanical* steps to `harness.sh` (which
only sequences the phase scripts + integration-branch git transitions).
Reimplement nothing. Rationale: `docs/adr/0002-skill-rationale.md`.

## Autonomy policy

Run the batch **autonomously**. Halt automatically only on a real gate failure
(over budget, cross-review BLOCK, integration suite red, eval red, trace anomaly).
Require **exactly one** human go/no-go: immediately before promoting to `main`
(`harness.sh promote`) — the only irreversible, shared-state step.

## State machine

```
S0 DECOMPOSE      [you]      write NOTES.md + NOTES.status.json + one NOTES.<slug>.md per subtask
                             (below). Refuse if two subtasks write the same file.
S1 ROUTE+BUDGET   [script]   route.py per subtask -> tier; you write plan.jsonl; harness.sh budget.
                             GATE A: exit 1 -> HALT (report total vs ceiling). Nothing irreversible yet.
S2 BUILD/slug     [you+script] harness.sh wt-new <slug>; implement in the worktree on the routed model.
S3 VERIFY/slug    [you+script] build + the subtask's tests + app-runs; then cross-review the worktree diff.
                             GATE B: verdict BLOCK -> HALT this slug, fix in place, re-review. Other
                             slugs keep going. Never merge a BLOCKed branch.
S4 MERGE          [script]   harness.sh integ-start; per slug (foundational first) harness.sh
                             integ-merge <slug>; run the FULL suite on integration each time.
                             GATE C: suite red / unresolved conflict -> HALT on integration (main untouched).
S5 EVAL+TRACE     [you+script] on integration: regression (HARD) + planning/judge (HARD) + capability
                             (soft, record); harness.sh trace <session>.
                             GATE D: any HARD eval red OR trace exit 1 -> HOLD on integration; report
                             the failing eval / trace flag + session file. Do not delete integration.
S6 PROMOTE        [CHECKPOINT] all gates green -> ask the human go/no-go -> harness.sh promote (--ff-only).
S7 ACCOUNT+CLEAN  [script]   note actual cost vs the S1 estimate (read /cost); harness.sh clean.
```

## Loop mode (/loop as the tick, eval-gate as Eval + Trace)

For long batches, run the state machine under `/loop` so each wake-up advances
it **one step** instead of one giant turn: `/loop /harness <task>` (self-paced
via ScheduleWakeup) or `/loop 10m /harness <task>` (fixed interval). The seven
loop parts map to existing pieces — nothing reinvented:

| Part      | Owner |
|-----------|-------|
| State     | `NOTES.status.json` (subtask state) + `NOTES.loop.json` (loop ledger) |
| Target    | the NOTES.md decomposition — every subtask `merged`, Gates A–D green |
| Observe   | tick start: read `NOTES.status.json` + the last eval/trace result |
| Action    | advance exactly ONE state-machine step (S2–S5) for the next eligible slug |
| Eval      | eval-gate Layer 1 — the S5 regression/judge suites (HARD) |
| Trace     | eval-gate Layer 2 — `harness.sh trace <session>` |
| Stop Rule | `harness.sh loop-tick` — deterministic; NEVER model self-judgment |

At S0, alongside the other NOTES files, write **`NOTES.loop.json`** (repo root,
volatile like NOTES.status.json):
```
{"target":"<one line>","iteration":0,"max_iterations":10,"stall":0,"max_stall":2,"last_fp":"","stop":""}
```

Every tick, in this order:
1. `harness.sh loop-tick` FIRST. **Exit 1 → the loop is over: do NOT schedule
   the next wake-up.** Read `stop` from the ledger: `target-reached` → report
   and ask the S6 human go/no-go (the loop never auto-promotes);
   `max-iterations` / `stalled` → HALT and report the stuck slug + gate.
2. Observe: `NOTES.status.json` → pick the next eligible slug/step.
3. Act: one step only — one build, one review, one merge, or the S5 eval+trace pass.
4. Dynamic mode only: ScheduleWakeup with the same /loop prompt.

`stall` counts consecutive ticks with an unchanged `NOTES.status.json`; raise
`max_stall` in the ledger when a single step legitimately spans several ticks
(long builds). All other rules — gates, autonomy policy, the S6 human
checkpoint — apply unchanged.

## Routing (Phase 4) applied throughout

Run `route.py "<subtask spec>"` for each subtask and for the review work; it
prints the tier + model id (tier table lives in the route-cost skill). The
cross-review reconcile always routes `top`.

## Gate B: cross-review (the hard rule that must survive)

When you reach S3, invoke the `cross-review` skill on the worktree diff. Its
independence is load-bearing: **Codex gets a fresh context with only the diff +
the one-line spec from NOTES.<slug>.md** — never your own reasoning or self-review.
Reconcile strict-biased; any unresolved High/Critical = BLOCK = no merge.

## State this skill owns

**`NOTES.md`** (target repo root — survives context compaction). **Append-only
during a run** (never rewrite lines — keeps it byte-stable / prompt-cache
eligible). Live status lives in `NOTES.status.json`, not here. The `project:`
header is optional forward plumbing (memory-os slug, ignored today).
```
# <task>  — base: <BASE> (default main)
project: <memory-os-slug>            # optional; ignored today

## Subtasks
- slug: hello    spec: "add hello() greeter"     owns: src/hello.js          tier: cheap
- slug: bye      spec: "add bye() farewell"       owns: src/bye.js            tier: cheap
```
3-5 subtasks, each independent (no shared write-file), testable (its own check),
bounded (one-line spec + owned paths).

**`NOTES.status.json`** (repo root, volatile — the ONLY place status changes;
never write status into NOTES.md): `{"hello": "pending", "bye": "building"}`,
status ∈ pending|building|reviewed|merged|blocked.

**`NOTES.loop.json`** (repo root, volatile — loop mode only; schema above).
Written by you at S0, updated ONLY by `harness.sh loop-tick` after that.

**`NOTES.<slug>.md`** — one per subtask, ~15 lines max: the one-line spec, the
owned files/dirs, and the acceptance check. Nothing else. Point each worktree
agent at its own `NOTES.<slug>.md` — never at the master NOTES.md.

**`plan.jsonl`** (input to `harness.sh budget`, token fields are thousands;
an optional `"project"` field is tolerated and ignored):
```
{"task":"add hello() greeter","tier":"cheap","in_ktok":12,"out_ktok":4,"cached_ktok":8}
{"task":"add bye() farewell","tier":"cheap","in_ktok":12,"out_ktok":4,"cached_ktok":8}
```
You author this from the decomposition + `route.py` tiers (estimates are yours).

**The `integration` branch** — created per batch off the base, deleted on success.
**Worktrees** — `../<repo>.worktrees/<slug>`, one per subtask, via `harness.sh`.

## harness.sh subcommands (the mechanical glue)

```
harness.sh budget <plan.jsonl>       Gate A — exit 1 if over ceiling_usd
harness.sh wt-new <slug>             create feat/<slug> worktree off the base
harness.sh wt-commit <slug>          commit the lane after the agent edits (harness commits, not the agent)
harness.sh wt-verify <slug>          Gate B — verify the lane is committed before it may merge
harness.sh integ-start               create integration off the base
harness.sh integ-merge <slug>        git merge --no-ff feat/<slug> (stops on conflict)
harness.sh trace <session>           Gate D L2 — check .claude/traces/<session>.jsonl
harness.sh loop-tick                 loop-mode Stop Rule — bump NOTES.loop.json; exit 1 = stop the loop
harness.sh promote                   guarded --ff-only of base to integration (only after the human go)
harness.sh reset-base                best-effort return of the repo to the base branch after a run (never fails the caller)
harness.sh clean [keep-session ...]  remove merged worktrees + delete integration + prune stale traces
```
Set `HARNESS_BASE=<branch>` to target a non-`main` base (smoke tests). The base
must already exist.

## Memory (optional)

All memory-os integration is orchestrator-side, behind `ENABLE_MEMORY_OS`
(default off). Hard boundaries:
- Memory calls ONLY at the `[you]`-owned steps **S0/S3/S5/S7** — never in
  `harness.sh`, the phase scripts, or the build agents (zero-MCP sandbox, no Bash).
- `route.py` (model tier) and memory-os `mem_route` (project→skill→agent) are
  **orthogonal** — never merge them.
- Writes are **summary-only at run boundaries**, exclusively through
  `web/lib/memory/proposeFromHarness.ts` (secret-scan + provisional/queue
  semantics live there). Never feed raw `.claude/traces/*.jsonl` into a write.
- Failures never block Gates A–D: reads fail open (skip enrichment), writes queue.
- harness.sh's stdout event contract RESERVES `type:"memory"` (comment only —
  the script never emits it).

## Preconditions

- **Codex MCP** (`mcp__codex__codex`) available — required for Gate B.
- **Trace hook** for Gate D Layer 2: the target repo's `.claude/settings.json` must
  register the eval-gate PostToolUse hook (`python3 .claude/skills/eval-gate/trace-log.py`)
  so `.claude/traces/<session>.jsonl` exists. This repo already has it. In another
  repo without it, `harness.sh trace` will error — warn and skip Layer 2 (Layer 1
  outcome evals still gate); do not hard-fail the pipeline over a missing trace.

## Notes / ceiling

skipped: dependency-graph merge ordering — pick foundational-first by hand in S4; add when batches exceed ~5 subtasks.
skipped: auto-appending caught Gate-B BLOCKs to the regression suite — do it manually per eval-gate; add when BLOCK volume is high.
skipped: parsing route.py output into plan.jsonl — you write plan.jsonl; add a parser when decompositions get large.
