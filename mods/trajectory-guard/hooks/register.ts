import type { Register } from 'claude-code'
import type { Trajectory } from '../types'

// Thresholds copied verbatim from .claude/skills/eval-gate/trace-check.py (Gate D).
// This mod is the live, early form of that gate: same rule, applied before the
// call runs instead of after the lane finishes. THRASH stays post-hoc (subjective).
const LOOP_RUN = 3
const MAX_CALLS = 200

const REF = { plugin: 'trajectory-guard', key: 'trajectory' } as const

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const { tool, tool_use_id: _id, consent: _c, ...args } = e as Record<string, unknown> & { tool: string }
    const key = tool + JSON.stringify(args)

    const held = await $.state.get(REF)
    const prev: Trajectory = held.value ?? { total: 0, last: '', run: 0 }
    const s: Trajectory = {
      total: prev.total + 1,
      last: key,
      run: key === prev.last ? prev.run + 1 : 1,
    }
    await $.state.set(REF, s)
    $.ui.status(`calls ${s.total}`)

    if (s.run >= LOOP_RUN)
      return { deny: `trajectory-guard: ${s.run} identical ${tool} calls in a row (Gate D LOOP). Change the input or the approach; do not retry this call.` }
    if (s.total > MAX_CALLS)
      return { deny: `trajectory-guard: ${s.total} tool calls this session (> ${MAX_CALLS}, Gate D EXPLOSION). Stop, write HANDOFF.md, end the session.` }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'trajectory-guard: guard failed; call refused.' }))
}
