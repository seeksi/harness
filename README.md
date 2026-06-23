# HARNESS

A minimal, four-phase agent harness for building a mid-scale app with Claude Code
as the substrate and an independent **Codex** lane for cross-model review. Each phase
is a self-contained Claude Code skill under `.claude/skills/`; together they cover the
runtime (review, traces, routing) and the workflow (parallelism, merge gates, evals).

Built smallest-first: every component earns its place by the failure it prevents.

## The pipeline

A unit of work flows through the phases like this:

```
  task
   │
   ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ PHASE 2  parallel-build                                       │
 │  decompose → spec'd, file-owned subtasks (NOTES.md)          │
 │  one git worktree per subtask  (3–5 concurrent)              │
 └───────────────┬──────────────────────────────────────────────┘
                 │  per subtask:
                 ▼
        ┌───────────────────────────────┐
        │ PHASE 4  route-cost            │   pick the model for THIS subtask
        │  mechanical → Haiku            │   (cheap explore vs. Opus reasoning)
        │  ordinary   → Sonnet           │   + budget gate before a batch spends
        │  hard/review→ Opus             │
        └───────────────┬───────────────┘
                        ▼
                  implement in worktree
                        │
                        ▼
        ┌───────────────────────────────┐
        │ PHASE 1  cross-review          │   Claude self-review ∥ Codex (fresh
        │  diff + spec only → Codex      │   context, diff+spec only)
        │  reconcile, strict-bias        │   BLOCK on unresolved High/Critical
        └───────────────┬───────────────┘
              PASS       │   BLOCK → fix in place
                        ▼
        ┌───────────────────────────────┐
        │ PHASE 2  sequential merge      │   serialize → integration branch
        │  full suite on integration     │
        └───────────────┬───────────────┘
                        ▼
        ┌───────────────────────────────┐
        │ PHASE 3  eval-gate             │   regression + capability evals
        │  trajectory check (loops?)     │   on integration, before main
        └───────────────┬───────────────┘
              green      │
                        ▼
                  fast-forward to main

  PHASE 3 (cross-cutting): a PostToolUse hook logs every tool call to
  .claude/traces/ so the agent's trajectory is observable the whole way through.
```

## The four phases

| Phase | Skill | What it does | Why it's there |
|---|---|---|---|
| 1 | [`cross-review`](.claude/skills/cross-review/SKILL.md) | Independent Codex review (fresh context, diff+spec only) reconciled against a Claude self-review with a strict-biased tie-break; emits BLOCK/PASS | Same-model self-review shares the author's blind spots (sycophancy); a different provider catches a different class of bug |
| 2 | [`parallel-build`](.claude/skills/parallel-build/SKILL.md) | Spec-driven decomposition → one git worktree per subtask → sequential merge through an integration branch (`wt.sh` manages lifecycle) | Uncoordinated parallel agents produce semantic conflicts that pass lint; worktrees turn them into ordinary git conflicts at intentional merge points |
| 3 | [`eval-gate`](.claude/skills/eval-gate/SKILL.md) | Regression + capability evals on the integration branch, plus a PostToolUse trace hook and a trajectory gate (loop / explosion / thrash) | Catches both output regressions and *trajectory* regressions before they reach main |
| 4 | [`route-cost`](.claude/skills/route-cost/SKILL.md) | Per-task model routing (Haiku / Sonnet / Opus) and a budget estimator that gates a batch over `ceiling_usd` | Running every subtask on Opus is the default waste at mid-scale; route to the cheapest correct tier |

## The three load-bearing decisions

Distilled from the research that produced this harness — these are where single-model,
uncoordinated, or unmeasured harnesses fail:

1. **Cross-model review in a fresh context, biased strict** (Phase 1) — the biggest
   quality lever for the cost. Codex never sees Claude's reasoning, so it stays independent.
2. **External memory + subagent isolation + just-in-time context** — context is the
   binding constraint; subtasks return summaries, not file dumps (Phase 2's `NOTES.md`).
3. **Worktree isolation + sequential integration-branch merges before scaling parallelism**
   (Phase 2) — parallel agents without this actively corrupt the codebase in ways CI won't catch.

## Layout

```
.claude/
  settings.json                 # registers the Phase 3 trace hook
  skills/
    cross-review/    SKILL.md
    parallel-build/  SKILL.md  wt.sh
    eval-gate/       SKILL.md  trace-log.py  trace-check.py
    route-cost/      SKILL.md  route.py  budget.py  models.json
  traces/                       # gitignored — per-session tool-call logs
```

## Prerequisites

- **Claude Code** (skills, subagents, hooks).
- **Codex CLI** for Phase 1, reachable as the `codex` MCP server. Add to `.mcp.json`:
  ```json
  { "mcpServers": { "codex": { "command": "codex", "args": ["mcp"] } } }
  ```
- **Python 3** and **git** for the Phase 2–4 helper scripts.

## Status

All four phases are implemented and were smoke-tested end-to-end (a real Claude×Codex
review on a planted-bug diff, a full worktree lifecycle, a flagged trajectory loop, and
routing + a tripped budget gate). Model rates in `route-cost/models.json` are cached —
re-verify against the Models API before trusting them for billing.
