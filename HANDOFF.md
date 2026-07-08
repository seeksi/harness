# HANDOFF — Non-gating follow-ups batch (Group A code done; B/C pending) — 2026-07-08T08:42-07:00

> Resume with NOTES.md (section "# Non-gating follow-ups batch (post-agenda)") + this file.
> Repo /home/alter/HARNESS, branch **feat/followups** (off main ffb18be). Working tree
> has uncommitted Group-A edits. GANTRY product context: prior HANDOFF content is below
> the older divider in git history / NOTES; all four NEXT-PASS agenda items (#1-#4) are DONE.

## Current state
- **Group A (4 code follow-ups): DONE + CROSS-REVIEW PASS + COMMITTED on feat/followups.**
  Cross-review r1 BLOCK (1 High: reconnect budget reset only on id-frames vs live server's id-less
  ping/sync/open frames → premature give-up) → fixed (reset on any frame) + 2 test additions →
  Codex r2 PASS. Gate C after fix: 496 vitest, eslint clean, tsc 11=baseline, node --check OK.
  Commit = 62d1a25 on feat/followups. Operator go/no-go 2026-07-08: **HOLD — stay on branch**
  (no merge, no push; deliberate, not pending-unasked). Merge/push await a later explicit say-so.
  - Gate C just run clean: `cd console && npx vitest run` = **494 pass** (483 baseline + 11 new);
    eslint clean; `tsc --noEmit` = **11 errors = main baseline** (all pre-existing, in
    harness-bridge.test.ts / daemon.test.ts:13,20 NODE_ENV / notifier.test.ts — ZERO in files I
    touched); `npx next build` compiled; `node --check bin/gantry` OK; `bash tests/install.test.sh`
    = 29/0 exit 0.
- **Group B (operator-gated, draft-only): NOT started.** VPS drop-mode (#6) scripts + threat-model
  §7 doc; ntfy tap deep-link (#5) code verify.
- **Group C (live smokes, need running server + creds): NOT started.** mixed-tier already done
  (see routing smoke in NOTES); remaining = /graph showpiece capture, phone-approve over tailnet.

## Decisions
- Group A is small + file-disjoint → direct edits on ONE branch + cross-review before merge
  (repo doctrine: "smaller changes edit directly, still cross-review"), NOT the worktree harness.
- SSE reconnect: resume via `?lastEventId=` (server replay is EXCLUSIVE — broker `since(seq)` is
  `> seq`, fixture `resumeStartIndex` is `cursor+1` — so gapless/dup-free). Bounded
  MAX_RECONNECTS=5 + linear backoff 300ms base/3s cap, reset on any frame. never-opened stream =
  fast-fail (no retry storm), preserving the existing "stream connect failed" test. STREAM_END
  ("__console_end", hardcoded — mirrors client.ts) stops the loop for finite fixture streams.
- usage fix: pick DOMINANT modelUsage entry by total token volume (not entries[0]); `>` keeps
  single-entry + insertion-order ties deterministic. Fixes haiku side-call mis-attribution.
- plan.jsonl: extracted pure exported `serializePlanFile(plan)`; writePlanFile calls it (byte
  identical write). Enables golden-test without fs.

## Files touched (all uncommitted on feat/followups)
- bin/gantry — followRun rewritten with bounded lastEventId reconnect; header ponytail note updated.
- console/lib/sandbox/agent-runner.ts — parseAgentUsage picks dominant modelUsage entry.
- console/lib/sandbox/agent-runner.test.ts — +1 multi-model (opus-dominant) test.
- console/lib/server/daemon.ts — new exported serializePlanFile; writePlanFile delegates.
- console/lib/server/daemon.test.ts — import serializePlanFile; +2 golden tests (mixed-tier, single sonnet).
- console/lib/cli/gantry-cli.test.ts — +os/fs imports; +6 findClaude tests; +2 SSE reconnect tests
  (resume test matches by PATHNAME — the resume URL carries ?lastEventId=, exact-URL match 404s);
  trailing ponytail reworded (only cmdUp spawn undriven now).
- NOTES.md — new "# Non-gating follow-ups batch (post-agenda)" section (this batch record).

## Next steps
1. **Cross-review the Group-A diff** (`git -C /home/alter/HARNESS diff main -- bin/ console/`; small,
   single branch). Use the cross-review skill (fresh Codex thread: diff + one-line spec per change).
   Reconcile strict-biased → fix rounds until PASS. NOTE the recurring lesson: `git add -N` any
   untracked file so it shows in the diff (none here — all edits are to tracked files).
2. Commit feat/followups (one commit), then human go/no-go → merge to main → **push is still held
   for operator say-so** (main also unpushed since f149661 per prior HANDOFF — confirm push scope).
3. Update NOTES status line (COMPLETE), memory if durable.
4. **Group B drafts**: VPS drop-mode (#6) — draft egress-firewall + resource-limit + agent-N-account
   scripts + threat-model §7 doc (draft only; operator runs on real VPS). ntfy deep-link (#5) — verify
   the deep-link base URL config in code (console notifier / ntfy hooks), fix if wrong.
5. **Group C live smokes** (queue for a live operator session, `gantry up`): /graph showpiece capture
   (playwright screenshot), phone-approve over tailnet, ntfy tap. Needs ENABLE_AGENT_EXEC + creds.

## Dead ends / open questions
- reconnect "give-up" test costs ~4.5s (5 backoffs) — given a 20000ms `it` timeout; acceptable but
  slow. Did NOT add an env knob to shrink backoff (would add surface to the zero-dep CLI a reviewer
  may ding). If the suite time matters, revisit.
- Group B/C are mostly operator-hands; I can only produce review-ready drafts + code verifies. The
  VPS drop-mode threat-model §7 sign-off is a HUMAN decision — do not self-approve.
- Prior open low/background items still stand: haiku model-alias quirk (distinct from the usage-key
  fix — that was attribution; alias is `--model haiku`→sonnet resolution); agent-home git-identity
  cache / openat-anchored writes.
