---
name: cross-review
description: Cross-model code review. Reviews the current diff with an independent Codex session (fresh context, diff + spec only) in parallel with a Claude self-review, then reconciles findings with a strict-biased tie-break and emits a BLOCK/PASS merge verdict. Use before merging any branch, on "cross review", "codex review", "review this diff", or as the Phase 1 review gate of the agent harness.
---

# Cross-Model Review (Claude × Codex)

Two independent reviews (Codex fresh-context + Claude self-review), reconciled
strict-biased. Rationale: `docs/adr/0002-skill-rationale.md`.

## Hard rules (do not skip)

1. **Codex gets a FRESH context with only the diff + the spec.** Never feed Codex
   your own reasoning, your self-review, or "I think this is fine" — that anchors
   it and destroys the independence that makes this worth running.
2. **Run the two reviews in parallel**, then reconcile. Do not let one see the other
   before both have produced findings.
3. **On any severity disagreement, take the stricter call.** A human (or the
   orchestrator on low-risk diffs) breaks genuine ties — never auto-resolve downward.
4. **Severity ≥ High that is unresolved ⇒ verdict is BLOCK.** No merge.
5. **Memory boundary ⇒ automatic BLOCK.** Any diff that wires `mem_*` calls, memory-os
   access, or MCP config into agent-facing code (`web/lib/sandbox/**` — e.g. adding
   `--mcp-config` to the build-agent launcher) is an automatic BLOCK, regardless of
   any other finding. The zero-MCP build-agent sandbox is a security invariant.

## Procedure

### 1. Capture the diff and the spec
```
git diff --merge-base origin/main   # or the relevant base; fall back to: git diff HEAD
```
The spec = the task description / PR body / ticket. If none exists, write one
sentence stating the intended behavior — Codex needs the *intent*, not just mechanics.

### 2. Launch the Codex pass (fresh, read-only)
Call `mcp__codex__codex` with `sandbox: "read-only"`. Pass ONLY the diff + spec in
the prompt. One prompt covering all four lenses is fine for mid-scale diffs; split
into separate Codex sessions only for large/security-critical changes.

`base-instructions` (the reviewer's whole job):
```
You are an independent code reviewer from a different provider than the author.
You are given a diff and the spec it must satisfy — nothing else. Review across
four lenses and report findings only; do not rewrite the code.
  SECURITY: injection, authz/authn gaps, secrets, unsafe deserialization, SSRF.
  PERFORMANCE: N+1 queries, unbounded loops/memory, missing indexes, sync-in-hot-path.
  TESTING: untested branches, missing edge/error cases, assertions that prove nothing.
  ARCHITECTURE: spec mismatch, leaky boundaries, duplicated logic, footguns for callers.
For each finding output: SEVERITY (Critical/High/Medium/Low) | LENS | file:line |
one-line problem | one-line fix. End with a one-line overall risk verdict.
Be terse. Flag spec violations as at least High. Do not praise.
```
`prompt`: `SPEC:\n<spec>\n\nDIFF:\n<diff>`
Set `model` to your current Codex model (e.g. `gpt-5.2-codex`) or omit to use the default.

### 3. Run the Claude self-review in parallel
Review the same diff against the same four lenses in your own context. It is NOT
a substitute for Codex.

### 4. Reconcile
Build one merged findings table. For each finding present in either review:

| Sev | Lens | file:line | Problem | Fix | Claude | Codex |
|-----|------|-----------|---------|-----|--------|-------|

- **Both flagged it** → high confidence, keep at the higher severity.
- **Only Codex flagged it** → keep it; do NOT dismiss because Claude "didn't see a
  problem" (that is exactly the sycophancy this gate exists to catch).
- **Only Claude flagged it** → keep it.
- **Severity disagreement** → take the stricter. Note the disagreement so a human
  can break it if it gates the merge.

### 5. Emit the verdict
```
VERDICT: BLOCK | PASS
- BLOCK if any unresolved finding is High or Critical.
- PASS if only Medium/Low remain; list them as follow-ups, do not gate on them.
Then: the merged table, and the 1–3 must-fix items if BLOCK.
```

Position in the harness: the Phase 1 review gate — after verification (tests +
app actually run), before the sequential merge to integration. BLOCK stops the merge.

## Notes / ceiling

skipped: separate Codex sessions per lens — add when diffs exceed a few hundred lines
or are security-critical. skipped: persisting review transcripts for trace/eval — add
when the eval suite needs them. skipped: auto-applying Codex fixes — review and write
stay separate on purpose; apply fixes yourself after reconciling.
