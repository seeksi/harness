---
name: harness
description: Top-level orchestrator that runs the full four-phase agent harness end to end — decompose a task, route+budget-gate it (Phase 4), build each subtask in an isolated worktree gated by a cross-review PASS (Phases 1-2), merge sequentially through an integration branch, run evals + a trajectory check (Phase 3), then fast-forward to main. Use on "run the harness", "full pipeline", "build this end to end", or to drive cross-review / parallel-build / eval-gate / route-cost as one flow.
---

# The Harness (orchestrator over the four phases)

The four phase-skills each do one job; nothing chains them. This skill is the
driver. It owns the two *subjective* steps itself — decomposing the task and the
cross-review reconcile/verdict — and delegates the *mechanical* steps to
`harness.sh`, which only sequences the existing phase scripts (`route.py`,
`budget.py`, `wt.sh`, `trace-check.py`) plus the integration-branch git
transitions no phase script covers. Reimplement nothing.

## Autonomy policy

Run the batch **autonomously**. Halt automatically only on a real gate failure
(over budget, cross-review BLOCK, integration suite red, eval red, trace anomaly).
Require **exactly one** human go/no-go: immediately before promoting to `main`
(`harness.sh promote`) — the only irreversible, shared-state step. Worktree
creation is reversible (`harness.sh clean`) and is covered by the budget approval,
so it gets no separate stop.

## State machine

```
S0 DECOMPOSE      [you]      write NOTES.md (below). Refuse if two subtasks write the same file.
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

## Routing (Phase 4) applied throughout

Use `route.py "<subtask spec>"` for each subtask and for the review work:
- architecture / security / review / **the cross-review reconcile** / migration / hard debug → `top` (Opus)
- scaffold / tests / docs / rename / format / lint / explore / read → `cheap` (Haiku)
- everything else → `default` (Sonnet)

## Gate B: cross-review (the hard rule that must survive)

When you reach S3, invoke the `cross-review` skill on the worktree diff. Its
independence is load-bearing: **Codex gets a fresh context with only the diff +
the one-line spec from NOTES.md** — never your own reasoning or self-review.
Reconcile strict-biased; any unresolved High/Critical = BLOCK = no merge.

## State this skill owns

**`NOTES.md`** (target repo root — survives context compaction):
```
# <task>  — base: <BASE> (default main)

## Subtasks
- slug: hello    spec: "add hello() greeter"     owns: src/hello.js          tier: cheap   status: pending
- slug: bye      spec: "add bye() farewell"       owns: src/bye.js            tier: cheap   status: pending
```
status ∈ pending|building|reviewed|merged|blocked. 3-5 subtasks, each independent
(no shared write-file), testable (its own check), bounded (one-line spec + owned paths).

**`plan.jsonl`** (input to `harness.sh budget`, token fields are thousands):
```
{"task":"add hello() greeter","tier":"cheap","in_ktok":12,"out_ktok":4,"cached_ktok":8}
{"task":"add bye() farewell","tier":"cheap","in_ktok":12,"out_ktok":4,"cached_ktok":8}
```
You author this from the decomposition + `route.py` tiers (estimates are yours).

**The `integration` branch** — created per batch off the base, deleted on success.
**Worktrees** — `../<repo>.worktrees/<slug>`, one per subtask, via `harness.sh`.

## harness.sh subcommands (the mechanical glue)

```
harness.sh budget <plan.jsonl>   Gate A — exit 1 if over ceiling_usd
harness.sh wt-new <slug>         create feat/<slug> worktree off the base
harness.sh integ-start           create integration off the base
harness.sh integ-merge <slug>    git merge --no-ff feat/<slug> (stops on conflict)
harness.sh trace <session>       Gate D L2 — check .claude/traces/<session>.jsonl
harness.sh promote               guarded --ff-only of base to integration (only after the human go)
harness.sh clean                 remove merged worktrees + delete integration
```
Set `HARNESS_BASE=<branch>` to target a non-`main` base (smoke tests). The base
must already exist.

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
