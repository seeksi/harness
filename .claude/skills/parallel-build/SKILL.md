---
name: parallel-build
description: Run multiple coding agents in parallel safely using git worktrees, then merge sequentially through an integration branch. Decomposes a task into independent spec'd subtasks, isolates each in its own worktree, verifies and cross-reviews each, and serializes the merges so conflicts surface as normal git conflicts instead of silent semantic corruption. Use for multi-part features, "build these in parallel", "split this work", or as Phase 2 of the agent harness.
---

# Parallel Build (worktree isolation + sequential merge)

Worktrees isolate each agent; the sequential merge serializes conflicts. Never
skip the decomposition or the sequential merge — they are what make parallelism
safe rather than just fast. Rationale: `docs/adr/0002-skill-rationale.md`.

Cap: **3–5 concurrent agents.**

## Procedure

### 1. Spec-driven decomposition (do this first — it is the safety mechanism)
Split the task into subtasks that are:
- **Independent** — minimal shared files; if two subtasks must edit the same file,
  they are not independent — sequence them or merge them into one subtask.
- **Testable** — each has its own acceptance check.
- **Bounded** — write a one-line spec + the file/dir ownership for each.

Write the decomposition to `NOTES.md` (orchestrator-owned, append-only) so it
survives context compaction, and emit one `NOTES.<slug>.md` per subtask (~15
lines: one-line spec + owned files + acceptance check only — see the harness
skill for the templates). Refuse to start if two subtasks claim write-ownership
of the same file.

### 2. Create one worktree per subtask
```
.claude/skills/parallel-build/wt.sh new <slug>      # -> prints worktree path
```
Worktrees land in `../<repo>.worktrees/<slug>` on branch `feat/<slug>` off `main`.
Launch one agent per worktree (a subagent, or background tasks). Give each agent
ONLY its own `NOTES.<slug>.md` — never the master NOTES.md or the others' specs.
Optional per-task model routing: cheap model for boilerplate subtasks, top model
for the hard one.

### 3. Verify each worktree independently (quality gate)
In each worktree, before it is eligible to merge:
- run the build + that subtask's tests, and **actually run the app** if relevant;
- run the **cross-review** skill on the worktree's diff (Phase 1 gate).
A worktree with failing tests or a BLOCK verdict does not merge. Fix in place.

### 4. Sequential merge through an integration branch
Never merge parallel branches straight to main. Serialize:
```
git checkout -b integration main          # once, per batch
# then, one branch at a time:
git merge --no-ff feat/<slug>             # resolve conflicts here, deliberately
<run full build + test suite on integration>   # catch semantic conflicts lint missed
```
Merge order: lowest-risk / most-foundational first. After each merge, run the FULL
suite on `integration`. Only when `integration` is green through all branches:
```
git checkout main && git merge --ff-only integration
```

### 5. Clean up
```
.claude/skills/parallel-build/wt.sh clean      # removes merged worktrees + branches
```

## Notes / ceiling

skipped: automated merge-order selection — you pick foundational-first; add a
dependency-graph sort past ~5 subtasks. skipped: locking between live agents —
disjoint file ownership from step 1 covers it; add a coordinator only if ownership
keeps colliding. skipped: auto-rebasing worktrees onto a moving main — fine for
short batches; add when a batch outlives a day of main activity.
