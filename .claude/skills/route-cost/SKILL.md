---
name: route-cost
description: Phase 4 of the agent harness — per-task model routing and cost controls. Routes mechanical work to Haiku, ordinary work to Sonnet, and hard reasoning / cross-review reconcile to Opus, then estimates the USD cost of a routed batch against a budget ceiling and gates if it's over. Use when deciding which model a subagent should run, estimating spend before a batch, or on "which model", "route this", "what will this cost".
---

# Model Routing + Cost Controls (Phase 4)

Route by what the task needs: Haiku for mechanical/read-only work, Sonnet for
ordinary implementation, Opus only for hard reasoning and correctness-critical
steps. Rationale: `docs/adr/0002-skill-rationale.md`.

Rates live in `models.json` (cheap=Haiku, default=Sonnet, top=Opus), sourced from the
claude-api reference — re-verify against the Models API / pricing docs before trusting
the numbers for billing.

## Routing

```
python3 .claude/skills/route-cost/route.py "<task description>"
```
Prints the tier and the Claude model id. An optional `--project <slug>` flag is
accepted and ignored (forward plumbing for memory-os; distinct from mem_route —
never merge them). Wire it into delegation:
- **Subagents** — pass the printed model id as the subagent's model (cheap explore
  agents on Haiku, the hard implementation on Opus).
- **Cross-review (Phase 1)** — Claude self-review and the reconcile run on `top`
  (Opus); Codex is the independent lane regardless.
- **parallel-build (Phase 2)** — route each worktree subtask independently.

Routing table (the forks):

| Task shape | Tier | Model |
|---|---|---|
| architecture, security, review, reconcile, migration, hard debug | top | `claude-opus-4-8` |
| scaffold, tests, docs, rename, format, lint, explore, read | cheap | `claude-haiku-4-5` |
| everything else | default | `claude-sonnet-4-6` |

## Cost estimate + budget gate

Write a JSONL plan (token fields are thousands of tokens; `cached_ktok` is the input
portion served from cache, billed at ~0.1× the input rate; an optional `"project"`
field is tolerated and ignored):
```
{"task":"scaffold module","tier":"cheap","in_ktok":10,"out_ktok":4}
{"task":"implement handler","tier":"default","in_ktok":25,"out_ktok":8,"cached_ktok":15}
{"task":"security review","tier":"top","in_ktok":40,"out_ktok":6,"cached_ktok":30}
```
Then:
```
python3 .claude/skills/route-cost/budget.py plan.jsonl
```
Prints per-task USD and the total, and **exits 1 if the total exceeds `ceiling_usd`**
in `models.json` — use it as a pre-batch gate. Token counts are your estimates; for
actuals read Claude Code's `/cost`.

## Cost levers (in priority order)

1. **Route down** — the cheapest correct tier. Most subtasks are not Opus-worthy.
2. **Cache the stable prefix** — CLAUDE.md, tool list, and shared context cache at
   ~0.1× read; keep volatile content (timestamps, IDs) last so the prefix stays
   byte-stable. `cached_ktok` in the plan models this.
3. **Right-size `max_tokens` / effort** — lower effort on cheap/mechanical subtasks.
4. **Budget alarm** — the ceiling gate stops a runaway batch before it spends.

## Notes / ceiling

skipped: a learned/LLM classifier for routing — add when task descriptions stop
matching keywords. skipped: pulling real token usage from transcripts into
budget.py — `/cost` covers actuals; wire in for automated post-hoc cost reports.
skipped: Fable 5 (`claude-fable-5`, $10/$50) as a fourth tier — add only when a
task genuinely exceeds Opus.
