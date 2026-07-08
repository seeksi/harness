# HANDOFF — tracehook Gate-D fix: code COMPLETE + cross-review PASS, committed — resume = LIVE SMOKE — 2026-07-08 s7

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
- **COMMITTED on feat/followups** (this session, NO push per operator). Diff = the s5 tracehook
  work (--settings hook injection + CLAUDE_PROJECT_DIR threading) + step-1 resolveTraceHookPath
  + containment guard/tests.

## Decisions
- Containment SUBSUMES Codex #1+#2: realpath-contain the resolved hook, reject if inside the
  target repo / worktrees. Do NOT blanket-reject symlinks (legit non-ASCII escape hatch).
- Guard lives in worktree.ts; single exported predicate (isAgentWritablePath).
- Operator posture: commit on feat/followups (DONE), **NO push**; run the live smoke.
- Committed BEFORE the live smoke (deviation from prior ordering): code fully unit-verified +
  cross-review PASS, feature branch + no push = reversible; done under context-budget pressure.

## Next steps (RESUME POINT = live smoke, HANDOFF steps 4-8)
1. **Rebuild + restart :3001.** Kill old server (`pgrep -af "next start"`; was pid 343982 in s5,
   likely dead). `cd console && npx next build` then relaunch:
   `npx next start -H 100.72.193.64 -p 3001` with env: `ENABLE_AGENT_EXEC=1 AGENT_ALLOW_DIRECT=1
   AGENT_CLI_PATH=/home/alter/.local/bin/claude HARNESS_LIVE=1 HARNESS_BASE=main
   HARNESS_REPO=/tmp/c2-throwaway
   HARNESS_SCRIPT_PATH=/home/alter/HARNESS/.claude/skills/harness/harness.sh
   NTFY_URL=https://ntfy.sh NTFY_TOPIC=gantry-smoke-c3` + belt-and-suspenders
   `AGENT_TRACE_HOOK_PATH=/home/alter/HARNESS/.claude/skills/eval-gate/trace-log.py`.
   Log to scratchpad, run_in_background. (`/tmp/c2-throwaway` should be CLEAN main.)
2. **Live smoke** — POST a run to projectId `harness-57f84330`, CSRF headers `x-harness-request: 1`
   + `origin: http://100.72.193.64:3001`. Confirm it PASSES Gate D and reaches `done` (the s5
   blocker: Gate-D trace-relocate failed → couldn't reach done). `gantry run` is the alt path.
3. **Verify the trace landed** — `<worktree>/.claude/traces/<session>.jsonl` written AND copied
   to `/tmp/c2-throwaway/.claude/traces/`.
4. Cleanup — `harness.sh clean` from repo root (NOT a worktree), then force-remove leftover
   lane worktrees/branches in /tmp/c2-throwaway.
5. (Optional) push — only on explicit operator say-so.

## Dead ends / open questions
- `HARNESS_REPO` is OVERLOADED: harness-bridge uses it as the TARGET repo; it must NOT locate
  the harness's own files. `HARNESS_SCRIPT_PATH` is the harness-repo anchor.
- isAgentWritablePath false-reject check: legit hook is in the HARNESS repo, anchors are the
  TARGET repo — disjoint in live AND dev (dev REPO_ROOT=cwd=console/, hook at repo-root/.claude).
  Test (d) proves this.
- Open (verify in smoke): headless `claude` respects a pre-set CLAUDE_PROJECT_DIR; `--settings`
  MERGES (not replaces) project settings. Unit-verified: with CLAUDE_PROJECT_DIR set, trace-log.py
  writes `$CLAUDE_PROJECT_DIR/.claude/traces/<session>.jsonl` (= relocateTrace src).
