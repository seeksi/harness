import type { Register } from 'claude-code'

// Replaces .claude/skills/context-guard/context-guard.py (transcript parsing against a guessed
// window) with the engine's own figures. Same policy: soft = checkpoint nudge, hard = stop
// starting work. Scale is whole percent 0-100 everywhere.
const LAUNCH = /gantry\s+run|harness\.sh\s+wt-new|\bwt-new\b|\bclaude\s+(-p|--print)\b|\bcodex\s+exec\b/

export const register: Register = (on, options) => {
  const soft = Number(options.soft ?? 60)
  const hard = Number(options.hard ?? 75)
  let nudged = false // re-armed when fill drops below soft (compaction, /clear); resets on reload

  on('tool.call', async ($, e, next) => {
    const u = await $.session.usage()
    const c = u.context
    // One whole-percent figure, used for display AND thresholds (no 74.6% shown as 75% but allowed).
    const fill = Math.round(c.percent ?? (c.tokens && c.window ? (100 * c.tokens) / c.window : 0))
    const usd = u.cost?.usd ?? 0
    $.ui.status(`ctx ${fill}% · $${usd.toFixed(2)}`)

    if (fill < soft) nudged = false
    else if (!nudged) {
      nudged = true
      $.ui.toast(`context-guard: ${fill}% — checkpoint state/decisions/next steps to NOTES.md now.`)
    }

    const startsWork = e.tool === 'Agent' || (e.tool === 'Bash' && LAUNCH.test(e.command))
    if (fill >= hard && startsWork)
      return { deny: `context-guard: context at ${fill}% (>= ${hard}%). No new work: write HANDOFF.md (Current state / Decisions / Files touched / Next steps / Dead ends), commit, and tell the user to start a fresh session.` }
    return next(e)
  })
    // Fail OPEN, unlike the other guards: a usage read that throws must not brick every tool
    // call in the session; the old shell hook had the same non-blocking contract.
    .catch(($, e, next) => next(e))
}
