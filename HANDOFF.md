# HANDOFF — tracehook Gate-D fix: code COMPLETE + cross-review PASS + **LIVE SMOKE PASSED** — resume = (optional) push — 2026-07-09 s8

## Current state
- **STEP 1 (HARNESS_REPO collision fix) — DONE + verified.** `resolveTraceHookPath()` in
  `agent-runner.ts`: `AGENT_TRACE_HOOK_PATH` override → `HARNESS_SCRIPT_PATH` sibling
  (`dirname/../eval-gate/trace-log.py`) → `cwd/..` fallback. HARNESS_REPO no longer consulted
  for the hook path (it points at the TARGET repo, would fail closed on every live run).
- **CONTAINMENT HARDENING — DONE + tested.** `worktree.ts` exports `isAgentWritablePath()`
  (realpath-resolves the path AND the anchors REPO_ROOT_ABS/WORKTREES_DIR_ABS, both from
  HARNESS_REPO; true if inside either). `traceHookCommand()` throws AgentExecError if the
  resolved hook is agent-writable (after the isFile check). +4 regression tests in
  agent-runner.test.ts describe "trace-hook CONTAINMENT": hook-in-repo THROWS; hook-in-worktree
  THROWS; ASCII symlink→worktree THROWS (realpath); legit sibling-repo hook ACCEPTED (no false
  reject).
- **CROSS-REVIEW CLOSED (step 3): VERDICT PASS.** Containment guard + the 4 tests resolve Codex
  #1 (override accepts worktree-controlled abs path), #2 (statSync follows symlink→worktree),
  #3 (no test). Self-reconciled — evidence concrete. Operator tie-break (s6) "add realpath
  containment" satisfied. Codex thread 019f43b9-d3dc-78d2-92bf-514558e4a654 (optional reply only).
- **VERIFY GREEN:** full console suite **515 pass** (38 files), tsc **11 = baseline** (0 in
  lib/sandbox), eslint clean on all 3 touched files.
- **COMMITTED on feat/followups** (NO push per operator). Diff = the s5 tracehook
  work (--settings hook injection + CLAUDE_PROJECT_DIR threading) + step-1 resolveTraceHookPath
  + containment guard/tests.
- **LIVE SMOKE PASSED (s8, 2026-07-09).** Rebuilt console with the committed fix (839a1ca),
  restarted :3001 with the full live env, POSTed a real headless-agent run to `harness-57f84330`.
  Run `3bf78820afcb887aaf14bdbb` reached **`done`**: Gate B clear (agent commit b63ef2d, worktree
  clean) → Gate C clear (integration merge ffa0d1c) → **Gate D clear — trace written by hook AND
  relocated** to `/tmp/c2-throwaway/.claude/traces/5c2e0db2-….jsonl` (7 tool-call lines incl. the
  Write append + commit Bash). The s5 blocker (Gate-D trace-relocate) is CONFIRMED FIXED live. No
  console code change was needed to pass.
- **FIXTURE BUG FOUND + FIXED (not a code bug).** Run 1 (`7aa77767…`) failed at Gate B
  (`wt-verify` exited 1): the trace hook writes `.claude/traces/` INTO the worktree pre-relocate,
  and `wt-verify`'s clean-check assumes that path is gitignored ("…so the agent's own trace won't
  trip it"). The real HARNESS repo gitignores `.claude/traces/`, but the throwaway base
  `/tmp/c2-throwaway` was under-provisioned (`.gitignore` had only `data/plans/`). Fix = added
  `.claude/traces/` to c2's `.gitignore` (commit `2a2567f`), matching a real target repo. Run 2
  then passed clean. **Whatever provisions the C2 throwaway base MUST gitignore `.claude/traces/`.**
- **c2-throwaway restored to bare main** (`2a2567f`): no worktrees, no leftover feat/integration
  branches, tree clean, verified trace artifact retained (gitignored). Console still running on
  :3001 (pid 993450 at handoff time).

## Decisions
- Containment SUBSUMES Codex #1+#2: realpath-contain the resolved hook, reject if inside the
  target repo / worktrees. Do NOT blanket-reject symlinks (legit non-ASCII escape hatch).
- Guard lives in worktree.ts; single exported predicate (isAgentWritablePath).
- Operator posture: commit on feat/followups (DONE), **NO push**; run the live smoke.
- Committed BEFORE the live smoke (deviation from prior ordering): code fully unit-verified +
  cross-review PASS, feature branch + no push = reversible; done under context-budget pressure.

## Next steps (RESUME POINT = optional push; smoke is DONE)
1. **(Optional) push feat/followups** — only on explicit operator say-so. Everything below is
   already verified; nothing else is blocking.
2. **(Optional) tear down the :3001 console** — `pkill -f "next start -H 100.72.193.64 -p 3001"`
   (pid 993450 at s8 handoff). Left running so the next smoke skips the rebuild.

### Live-smoke run recipe (for reference / re-runs)
- Rebuild + restart :3001: `cd console && npx next build`, then
  `npx next start -H 100.72.193.64 -p 3001` with env: `ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1
  AGENT_CLI_PATH=/home/alter/.local/bin/claude HARNESS_LIVE=1 HARNESS_BASE=main
  HARNESS_REPO=/tmp/c2-throwaway
  HARNESS_SCRIPT_PATH=/home/alter/HARNESS/.claude/skills/harness/harness.sh
  NTFY_URL=https://ntfy.sh NTFY_TOPIC=gantry-smoke-c3
  AGENT_TRACE_HOOK_PATH=/home/alter/HARNESS/.claude/skills/eval-gate/trace-log.py` (log to
  scratchpad, background). `/tmp/c2-throwaway` must be CLEAN main WITH `.claude/traces/` gitignored.
- POST run: `curl :3001/api/runs -X POST -H 'content-type: application/json'
  -H 'origin: http://100.72.193.64:3001' -H 'x-harness-request: 1'
  -d '{"projectId":"harness-57f84330","brief":"…Commit.","routing":"haiku"}'`. Poll outcome via
  `/api/projects` (project[0].recentRuns). Daemon `[daemon] run … failed:` lines land in the
  server stdout log.
- Cleanup: `harness.sh clean` (from repo root, not a worktree) leaves the feat lane unmerged-vs-main
  by design — force-remove it: `git worktree remove --force …`, `git branch -D feat/<slug> integration`.

## Dead ends / open questions
- `HARNESS_REPO` is OVERLOADED: harness-bridge uses it as the TARGET repo; it must NOT locate
  the harness's own files. `HARNESS_SCRIPT_PATH` is the harness-repo anchor.
- isAgentWritablePath false-reject check: legit hook is in the HARNESS repo, anchors are the
  TARGET repo — disjoint in live AND dev (dev REPO_ROOT=cwd=console/, hook at repo-root/.claude).
  Test (d) proves this.
- ~~Open (verify in smoke): headless `claude` respects a pre-set CLAUDE_PROJECT_DIR; `--settings`
  MERGES (not replaces) project settings.~~ **CONFIRMED live in s8:** the trace landed at
  `$CLAUDE_PROJECT_DIR/.claude/traces/<session>.jsonl` inside the worktree and relocated cleanly —
  so both the pre-set CLAUDE_PROJECT_DIR and the `--settings` merge behave as designed.
- **Gotcha (s8):** the trace hook writes into the worktree BEFORE relocate, so the target repo
  MUST gitignore `.claude/traces/` or Gate B (`wt-verify` clean-check) fails every live run. Real
  target repos do; the C2 throwaway base had to be patched. Bake this into base provisioning.
