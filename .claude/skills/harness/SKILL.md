---
name: harness
description: Top-level orchestrator that runs the full four-phase agent harness as an explicit execution graph — decompose a task into subtasks, materialize a node/edge graph (graph.py init), then walk it engine-driven; every step is next → execute one node → advance, with the engine refusing off-graph moves. Nodes cover route+budget (Gate A), per-subtask build/commit/verify/review in isolated worktrees with a declared fix cycle (Gate B), dependency-ordered merges through an integration branch (Gate C), evals + trajectory check (Gate D), and a human-gated promote to main. Use on "run the harness", "full pipeline", "build this end to end", a spec-doc-driven build brief, or to drive cross-review / parallel-build / eval-gate / route-cost as one flow. Also runs under /loop: each tick is one graph step; graph.py next/advance is the deterministic stop rule.
---

# The Harness (graph-driven orchestrator)

Execution is controlled by an explicit graph of nodes and edges, walked by
`graph.py` — not by you. You own the two *subjective* inputs — the decomposition
(which parameterizes the graph) and the cross-review reconcile/verdict (a node
outcome) — and you execute node payloads. The engine decides what is eligible,
which transitions are legal, which cycles may run and how many times.
Reimplement nothing. Rationale: `docs/adr/0002-skill-rationale.md`.

Canonical paths: `python3 ~/.claude/skills/harness/graph.py`,
`bash ~/.claude/skills/harness/harness.sh`,
`python3 ~/.claude/skills/route-cost/route.py`.

## The iron rule

**Every step of a run is exactly: `graph.py next` → execute ONE frontier node's
payload → `graph.py advance <node> <outcome>`.** Never run a `harness.sh`
subcommand, build, review, merge, or eval that is not the payload of a node
currently on the frontier. `advance` refuses off-graph moves, undeclared
outcomes, over-cap cycle visits, and anything after a HALT — a refusal (exit 1)
means you mis-stepped: re-run `next` and follow it, never work around the engine.

## Run lifecycle

```
1. DECOMPOSE [you]   Write NOTES.md, NOTES.subtasks.json, and one NOTES.<slug>.md
                     per subtask (formats below). Refuse if two subtasks write
                     the same file. Declare inter-subtask deps here — they become
                     the merge-order edges.
2. INIT     [engine] graph.py init NOTES.subtasks.json   → writes GRAPH.json and
                     prints the initial frontier.
3. WALK     [loop]   next → execute one node → advance, until next reports
                     COMPLETE or the graph HALTS.
```

## The graph topology (what init materializes)

```
route_budget ──ok──> build.<slug> ─ok─> commit.<slug> ─ok─> verify.<slug> ─ok─> review.<slug>
   │fail=HALT (Gate A)     ^                ^                   │fail──> build.<slug> (retry, cap 2)
                           │                └──ok── fix.<slug> <┘block (Gate B cycle, cap 3 fixes)
                           │
all review.<slug> ══pass══> integ_start ─ok─> merge.<s1> ─ok─> suite.<s1> ─ok─> merge.<s2> … (topo order)
(AND-join)                                      │conflict=HALT     │fail=HALT (Gate C)
… ─ok─> eval_trace ─ok─> promote_gate ─approved─> promote ─ok─> account_clean (terminal)
          │fail=HALT (Gate D)   │human node          │fail=HALT
```

Node types: `script` (run the payload command, map exit 0/1 to the declared
outcomes), `model` (you do the work described in the payload), `model+script`
(you prepare, then a script gate decides), `human` (promote_gate — see below).

Per-node `context` lists what you may read while executing that node
(`NOTES.<slug>.md`, `worktree:<slug>`, …). Honor it: a build/fix/review node
sees its own subtask's context only — never the master NOTES.md, never a
sibling worktree.

HALT semantics: an outcome with no declared edge (gate failure) halts the
graph and locks `advance`. After fixing the cause (e.g. resolving a merge
conflict on integration), `graph.py resume "<note>"` re-arms the halted node
for a retry; its visit cap still applies. Visit/step-cap halts are NOT
resumable by you — report them to the human (they can raise the cap by editing
GRAPH.json deliberately).

## Autonomy policy

Walk the graph **autonomously**. Halts are automatic and engine-enforced
(over budget, Gate B block-cycle exhausted, conflict, red suite, red eval,
trace anomaly, visit/step caps). Exactly **one** human checkpoint exists and it
is a node: `promote_gate`. Never `advance promote_gate approved` without an
explicit human yes in this conversation — the engine cannot verify this; it is
the one honor-bound edge, so treat it as inviolable.

## Loop mode (/loop as the tick)

For long batches run under `/loop` (`/loop /harness <task>` self-paced, or
`/loop 10m /harness <task>`). Each tick:

1. `graph.py next`. COMPLETE → report and stop the loop (do not schedule the
   next wake-up). HALTED / exit 1 → stop the loop and report the halt reason
   from GRAPH.json. (For `promote_gate` on the frontier: ask the human, then
   continue — the loop never auto-approves.)
2. Execute **one** frontier node's payload.
3. `graph.py advance <node> <outcome>`.
4. Dynamic mode only: ScheduleWakeup with the same /loop prompt.

The engine's visit caps and `max_steps` replace the old NOTES.loop.json
stall/iteration ledger — there is no separate loop state.

## Routing (Phase 4) applied throughout

At DECOMPOSE, run `route.py "<subtask spec>"` per subtask and record the tier
in NOTES.subtasks.json — init bakes it into each build node's payload. The
cross-review reconcile always routes `top`.

## Gate B part 1: TDD evidence (no test, no merge)

Every `build.<slug>` is red → green with captured proof. The builder writes the
failing test for the acceptance check in `NOTES.<slug>.md`, runs
`harness.sh tdd-run <slug> red -- <cmd>` (refuses if it passes), implements,
then `tdd-run <slug> green -- <cmd>` (refuses if it fails). Both logs land in
`.harness/tdd/` inside the lane and are committed by `wt-commit`; `wt-verify`
raises Gate B if either is missing, red shows `exit=0`, green isn't `exit=0`,
or the lane diff touches no test file. The point is the evidence, not the
ritual: a reviewer with fresh context can read the red log and know the test
actually guards the behavior. Lanes with nothing testable (docs, config) commit
`.harness/tdd/<slug>.skip` with a one-line reason — visible as a warn, never
silent.

## Gate B part 2: cross-review (the hard rule that must survive)

The `review.<slug>` node's payload invokes the `cross-review` skill on the
worktree diff. Its independence is load-bearing: **Codex gets a fresh context
with only the diff + the one-line spec from NOTES.<slug>.md** — never your own
reasoning or self-review. Reconcile strict-biased; any unresolved High/Critical
= outcome `block` (which routes to `fix.<slug>` — the engine caps the cycle).
Never advance `pass` on an unresolved High/Critical.

## State this skill owns

**`GRAPH.json`** (target repo root, volatile) — the single source of execution
truth: nodes, edges, states, visit counts, halt reason. Written only by
`graph.py`; never hand-edit it mid-run (the one exception: a human deliberately
raising a visit cap). Supersedes NOTES.status.json and NOTES.loop.json.

**`NOTES.md`** (repo root — survives context compaction). Append-only during a
run (byte-stable / prompt-cache eligible). Human-readable decomposition record:
```
# <task>  — base: <BASE> (default main)

## Subtasks
- slug: hello    spec: "add hello() greeter"     owns: src/hello.js   tier: cheap
- slug: bye      spec: "add bye() farewell"      owns: src/bye.js     tier: cheap   deps: hello
```
3-5 subtasks, each independent (no shared write-file), testable, bounded.

**`NOTES.subtasks.json`** (repo root — the machine input to `graph.py init`):
```
{"task":"<one line>","subtasks":[
  {"slug":"hello","spec":"add hello() greeter","tier":"cheap","deps":[]},
  {"slug":"bye","spec":"add bye() farewell","tier":"cheap","deps":["hello"]}]}
```
`deps` (other slugs) drive merge order via topological sort; a dep cycle is
refused at init. `tier` ∈ `cheap`|`default`|`top`.

**`NOTES.<slug>.md`** — one per subtask, ~15 lines max: the one-line spec, the
owned files/dirs, the acceptance check. This is the build node's entire
context — point each worktree agent at it only.

**`plan.jsonl`** (input to `harness.sh budget` inside the route_budget node;
token fields are thousands):
```
{"task":"add hello() greeter","tier":"cheap","in_ktok":12,"out_ktok":4,"cached_ktok":8}
```

**The `integration` branch** — created per batch off the base, deleted on success.
**Worktrees** — `../<repo>.worktrees/<slug>`, one per subtask, via `harness.sh`.

## harness.sh subcommands (node payloads — the mechanical glue)

```
harness.sh budget <plan.jsonl>       Gate A — exit 1 if over ceiling_usd
harness.sh wt-new <slug>             create feat/<slug> worktree off the base
harness.sh wt-commit <slug>          commit the lane after the agent edits
harness.sh tdd-run <slug> red|green -- <cmd>  capture a test run as TDD evidence (red must fail, green must pass)
harness.sh wt-verify <slug>          Gate B pre-check — lane committed + clean + TDD evidence
harness.sh integ-start               create integration off the base
harness.sh integ-merge <slug>        Gate B — requires a cross-review PASS on record for feat/<slug>'s HEAD
                                     (~/.gantry/reviews/<sha>.json via /review-record; HARNESS_REVIEW_GATE=skip
                                     merges unreviewed and says so), then git merge --no-ff (stops on conflict)
harness.sh trace <session>           Gate D L2 — check .claude/traces/<session>.jsonl
harness.sh promote                   guarded --ff-only (only after the human go)
harness.sh reset-base                best-effort return to the base branch
harness.sh clean [keep-session ...]  remove worktrees + integration + stale traces
harness.sh loop-tick                 LEGACY (pre-graph loop ledger) — superseded by
                                     graph.py; do not use in graph runs
```
Set `HARNESS_BASE=<branch>` to target a non-`main` base (smoke tests). The base
must already exist.

## Memory (optional)

All memory-os integration is orchestrator-side, behind `ENABLE_MEMORY_OS`
(default off). Hard boundaries:
- Memory calls ONLY around model-type nodes at run boundaries (DECOMPOSE,
  review reconciles, eval_trace, account_clean) — never in graph.py,
  harness.sh, the phase scripts, or the build agents (zero-MCP sandbox).
- `route.py` (model tier) and memory-os `mem_route` (project→skill→agent) are
  **orthogonal** — never merge them.
- Writes are **summary-only at run boundaries**, exclusively through
  `web/lib/memory/proposeFromHarness.ts`. Never feed raw `.claude/traces/*.jsonl`
  into a write.
- Failures never block any gate: reads fail open, writes queue.
- harness.sh's stdout event contract RESERVES `type:"memory"` (comment only).

## Preconditions

- **Clean base**: no uncommitted tracked changes on the base branch. If dirty,
  stop at DECOMPOSE and ask: commit the WIP (suite green first) or stash.
- **Codex MCP** (`mcp__codex__codex`) available — required for review nodes.
- **Trace hook** for the eval_trace node's L2: the target repo must register the
  eval-gate PostToolUse hook (`python3 .claude/skills/eval-gate/trace-log.py`).
  In a repo without it, warn and skip L2; with no eval-gate suites either,
  eval_trace degrades BY DESIGN to: full suite green on integration + a scripted
  app-level QA pass of each subtask's acceptance checks. Say which mode ran in
  the promote_gate report.

## Notes / ceiling

skipped: engine-verified promote_gate approval (honor-bound edge) — add if a control-plane approval event becomes consumable here.
skipped: machine enforcement of per-node context lists (they're printed by `next`, honored by you) — add a sandbox wrapper when build agents get shell access.
skipped: auto-appending caught Gate-B BLOCKs to the regression suite — do it manually per eval-gate; add when BLOCK volume is high.

## Visual-diff gate (shots/)

`bash ~/.claude/skills/harness/shots/shots.sh <worktree> <port> <outdir> [routes…]` seeds a
throwaway checkout (never a dev DB you care about), boots its server, logs in past the
verification/terms gates, and screenshots each route at 1440/390 beside its mockup
(`side-*.png` montages when ImageMagick is installed). Use it inside `review.<slug>` as the
visual half of Gate B, and on integration before `promote_gate` for the human's evidence.
Knobs are env vars documented at the top of the script; the mockup map is in `shots.rb`.
Written for prospect-farm (Rails, `sample_data:seed`, `LegalHelper` terms); adapt those two
lines for another app.
