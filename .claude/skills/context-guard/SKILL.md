# context-guard

PostToolUse hook that watches the interactive session's context-window fill and
enforces the harness context-management policy:

- **Soft limit 60%** — injects `additionalContext` telling the model to
  checkpoint (append state/decisions/next steps to NOTES.md) and keep working.
- **Hard limit 75%** — emits `decision: block` directing the model to stop new
  work, write a structured `HANDOFF.md` at the repo root (Current state /
  Decisions / Files touched / Next steps / Dead ends), and tell the user to
  start a fresh session opened with NOTES + HANDOFF.md.

Fill is estimated from the transcript's last main-thread assistant
`message.usage` (`input + cache_read + cache_creation` tokens) over a 200k
window. Warnings fire once per upward tier crossing, debounced via
`.claude/context-guard/<session>.json`; the tier re-arms when fill drops below
the soft limit (compaction, `/clear`).

Env overrides: `CONTEXT_GUARD_SOFT`, `CONTEXT_GUARD_HARD` (fractions),
`CONTEXT_GUARD_WINDOW` (tokens). Thresholds mirror `CONTEXT_SOFT`/`CONTEXT_HARD`
in `web/lib/contract/types.ts` (the daemon/HUD side of the same policy).

Non-blocking contract (same as eval-gate/trace-log.py): any failure exits 0.
Registered in `.claude/settings.json` under `PostToolUse`.
