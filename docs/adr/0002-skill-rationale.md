# ADR 0002 — Rationale behind the harness phase skills

Status: accepted. This ADR holds the "why" prose that used to live inline in the
five phase SKILL.md files (`harness`, `cross-review`, `parallel-build`,
`eval-gate`, `route-cost`). The SKILL.md files keep only operative rules — they
are loaded into agent context on every run, so every rationale line there is a
recurring token cost. Nothing here is a rule; if a statement below conflicts
with a SKILL.md, the SKILL.md wins.

## harness (orchestrator)

The four phase-skills each do one job; nothing chains them. The orchestrator
skill is the driver: it owns the two *subjective* steps (decomposing the task,
the cross-review reconcile/verdict) and delegates the *mechanical* steps to
`harness.sh`, which only sequences the existing phase scripts plus the
integration-branch git transitions no phase script covers.

Why exactly one human checkpoint: promotion to `main` is the only irreversible,
shared-state step. Worktree creation is reversible (`harness.sh clean`) and is
covered by the budget approval, so it gets no separate stop. Halting anywhere
else would turn an autonomous batch into a babysat one without reducing risk.

Why NOTES.md is append-only with status externalized to `NOTES.status.json`:
a byte-stable master file is prompt-cache eligible (cached input bills at
~0.1×), so churning a `status:` word inside it invalidated the cache on every
subtask transition. Why per-lane `NOTES.<slug>.md`: a worktree agent that reads
the master NOTES.md pays for every other subtask's spec and — worse — can act
on it; a ~15-line lane file is both cheaper and a better isolation boundary.

## cross-review (Gate B)

Independent review beats self-review because a same-model reviewer shares the
author's blind spots and rationalizations (sycophancy). The value is the
**disagreement** between two providers: Codex tends to run terse and strict;
Claude tends to downgrade severity and tolerate more. Surface both, bias strict.
"Only Codex flagged it → keep it" exists because dismissing the other lane's
finding is exactly the sycophancy the gate is built to catch. Codex gets the
*intent* (spec), not just the diff, because correctness is judged against
intent, not mechanics.

Position in the harness: Phase 1 review gate — after verification (tests + app
actually run), before the sequential merge to integration. A BLOCK verdict
stops the merge gate.

## parallel-build (Phase 2)

Uncoordinated parallel agents are dangerous: they generate overlapping changes
with partial context, producing merge conflicts, duplicated implementations,
and semantic contradictions that pass compile and lint. Worktrees give each
agent its own working dir + index over a shared object store — conflicts get
deferred to intentional merge points and surface as ordinary git conflicts that
existing tooling resolves. The decomposition and the sequential merge are what
make parallelism safe rather than just fast. The 3–5 agent cap exists because
beyond that, merge/reconcile overhead exceeds the parallelism gain. The full
suite runs on `integration` after each merge because that is where duplicated
logic and semantic contradictions that passed each worktree's local tests get
caught.

Position: Phase 2, on top of Phase 1 — each worktree's pre-merge gate IS the
cross-review skill; Phase 3 later runs on the integration branch.

## eval-gate (Phase 3)

Single-run "it passed" is not evidence the harness is healthy; regressions hide
in both outcomes and trajectories, so both layers gate. The regression/
capability split protects what works while still tracking progress on hard
tasks without letting an aspirational failure block a healthy merge.
LOOP/EXPLOSION/THRASH are the documented agent-failure signals (looping,
trace-depth/call spikes). Planning/LLM-as-judge checks stay few and canonical
because they cost tokens and drift.

Position: Phase 3, on top of Phases 1–2. Layer 1 gates before `main`; Layer 2
makes the agent runtime observable so trajectory regressions (not just output
regressions) are visible. Feeds Phase 4: trajectory data tells you which tasks
are cheap vs. runaway.

## route-cost (Phase 4)

Running every subtask on Opus is the default waste at mid-scale. Route by what
the task needs; caching and a budget ceiling keep the bill bounded. Keyword
routing is deliberate — a classifier model would cost more than it saves at
this scale.

Position: Phase 4, the last layer. It feeds on Phase 3 trace data and applies
across Phases 1–2 (which model each review/worktree subtask uses).

## Memory boundary (memory-os)

The harness's optional memory-os integration is orchestrator-side only, for two
reasons. Security: build agents run in a zero-MCP sandbox
(`--strict-mcp-config`, no Bash) precisely so a compromised or confused lane
agent can never read or write shared memory; wiring memory into agent-facing
code would undo the lane isolation work. Reliability: memory is an enrichment,
not a dependency — reads fail open and writes queue, so a memory-os outage can
never block Gates A–D. Raw `.claude/traces/*.jsonl` are unscanned for secrets,
which is why memory writes are summary-only and must pass the secret-scan in
`web/lib/memory/proposeFromHarness.ts`.
