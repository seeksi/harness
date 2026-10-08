import { test, expect } from 'claude-code/testing'

const ok = { result: { content: '' }, text: 'ok' }
const denied = (r: { deny?: string; isError?: boolean; text?: string }) =>
  r.deny ?? (r.isError ? r.text : undefined)
const usage = (context: { percent?: number; tokens?: number; window: number }, usd = 1.23) => ({
  value: { startedAt: 0, context, rateLimits: [], cost: { usd } },
})

test('at 76%: new work denied, checkpoint work allowed', async ($, on) => {
  on('tool.call', () => ok)
  on('session.usage', () => usage({ percent: 76, window: 1_000_000 }))
  expect(denied(await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' }))).toMatch(/HANDOFF/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'bash /x/harness.sh wt-new foo' }))).toMatch(/HANDOFF/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'claude -p "x"' }))).toMatch(/HANDOFF/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'claude --print x' }))).toMatch(/HANDOFF/)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: 'HANDOFF.md', content: '# h' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git commit -am checkpoint' }))).toBeUndefined()
})

test('percent absent: fill is computed from tokens/window', async ($, on) => {
  on('tool.call', () => ok)
  on('session.usage', () => usage({ tokens: 800, window: 1000 }))
  expect(denied(await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' }))).toMatch(/80%/)
})

test('at 50%: nothing denied', async ($, on) => {
  on('tool.call', () => ok)
  on('session.usage', () => usage({ percent: 50, window: 1_000_000 }))
  expect(denied(await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'gantry run "x"' }))).toBeUndefined()
})

test('userConfig thresholds are honored', { options: { hard: 40 } }, async ($, on) => {
  on('tool.call', () => ok)
  on('session.usage', () => usage({ percent: 50, window: 1_000_000 }))
  expect(denied(await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' }))).toMatch(/>= 40%/)
})

test('status on every call; one toast at soft, re-armed once fill drops below soft', async ($, on) => {
  on('tool.call', () => ok)
  let percent = 50
  on('session.usage', () => usage({ percent, window: 1_000_000 }, 1.5))
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  const read = { tool: 'Read', file_path: 'a.ts' } as const
  await $.tool.call(read)
  expect(status).toEqual(['ctx 50% · $1.50'])
  expect(toasts).toEqual([])
  percent = 61
  await $.tool.call(read)
  await $.tool.call(read)
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatch(/61%.*NOTES\.md/)
  percent = 30
  await $.tool.call(read)
  percent = 65
  await $.tool.call(read)
  expect(toasts).toHaveLength(2)
  expect(status).toHaveLength(5)
})

test('a failing usage read fails open', async ($, on) => {
  on('tool.call', () => ok)
  on('session.usage', () => { throw new Error('no session') })
  expect(denied(await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'x' }))).toBeUndefined()
})
