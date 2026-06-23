---
name: eval-gate
description: Phase 3 of the agent harness — regression evals + trace observability run on the integration branch so regressions are caught before main. Splits evals into regression (protect what works) and capability (push hard tasks), logs the agent's tool-call trajectory via a PostToolUse hook, and gates on trajectory anomalies (loops, call explosions, thrash). Use as the pre-main gate, on "run evals", "check the trace", or "did the agent loop".
---

# Eval Gate (regression evals + trace observability)

Two layers run on the **integration branch** before promotion to `main`:

1. **Outcome evals** — does the change still do the right thing?
2. **Trajectory observability** — did the agent get there sanely, or loop/thrash?

Single-run "it passed" is not evidence the harness is healthy; regressions hide in
both layers. Run both; a failure in either blocks the fast-forward to `main`.

## Layer 1 — Outcome evals (on the integration branch)

Keep two suites, run both in CI on `integration`:
- **Regression suite** — protects what already works. The app's existing tests PLUS
  fixed-bug cases (every BLOCK the cross-review gate caught should become a test).
  A regression failure is an automatic block.
- **Capability suite** — the hard tasks you're trying to make the agent handle.
  Allowed to fail; tracked as a score over time, not a hard gate.

For agent-built behavior that isn't deterministically checkable, add a small
**planning / LLM-as-judge** check: assert the change forms a sensible plan and meets
the spec. Keep these few and canonical — they cost tokens and drift.

Wire it as the step between the Phase 2 sequential merge and the `main` fast-forward:
```
git checkout integration
<run regression suite>      # hard gate
<run capability suite>      # tracked, soft
<run planning/judge evals>  # hard gate on spec match
# only if regression + judge green:
git checkout main && git merge --ff-only integration
```

## Layer 2 — Trajectory observability

Every tool call is logged by the `trace-log.py` PostToolUse hook to
`.claude/traces/<session>.jsonl`. Check a session's trajectory:
```
python3 .claude/skills/eval-gate/trace-check.py .claude/traces/<session>.jsonl
```
It reports tool-call counts and flags (exit 1 on any hard signal):
- **LOOP** — N identical consecutive calls (agent stuck repeating itself).
- **EXPLOSION** — total calls over budget (runaway / no plan).
- **THRASH** — one tool dominates (e.g. all Bash, no progress).

These are the documented agent-failure signals (looping, trace-depth/call spikes).
Run trace-check in CI on the session that produced the integration branch, or ad hoc
when an agent run "felt off". Tune `LOOP_RUN` / `MAX_CALLS` / `DOMINANCE` at the top
of the script for your app's normal shape.

### Enabling the hook

`.claude/settings.json` registers the PostToolUse hook (already wired in this repo).
Traces are gitignored. If the hook isn't firing, confirm the project `settings.json`
hook block is present and `python3` is on PATH.

## Where this sits in the harness

Phase 3, on top of Phases 1–2. Layer 1 is the gate before `main`; Layer 2 makes the
agent runtime observable so trajectory regressions (not just output regressions) are
visible. Feeds Phase 4 (routing/cost): trajectory data tells you which tasks are
cheap vs. runaway.

## Notes / ceiling

skipped: a hosted eval/trace platform (Braintrust/Weave/Laminar) — the JSONL + script
is enough at mid-scale; add a platform when you need dashboards, multi-run trend
lines, or team sharing. skipped: latency/cost fields in the trace — add when Phase 4
needs per-task cost. skipped: span nesting / subagent attribution in traces — flat
log is enough to catch loops; add nesting when debugging multi-agent trajectories.
