import { test, expect } from 'claude-code/testing'

const ok = { result: { content: '' }, text: 'ok' }
const denied = (r: { deny?: string; isError?: boolean; text?: string }) =>
  r.deny ?? (r.isError ? r.text : undefined)

test('third identical call in a row is denied; a different call resets the run', async ($, on) => {
  on('tool.call', () => ok)
  const read = { tool: 'Read', file_path: 'a.ts' } as const
  expect(denied(await $.tool.call(read))).toBeUndefined()
  expect(denied(await $.tool.call(read))).toBeUndefined()
  expect(denied(await $.tool.call(read))).toMatch(/LOOP/)
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'b.ts' }))).toBeUndefined()
  expect(denied(await $.tool.call(read))).toBeUndefined()
})

test('reserved fields (tool_use_id, consent) do not make identical calls distinct', async ($, on) => {
  on('tool.call', () => ok)
  for (const id of ['t1', 't2'])
    expect(denied(await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: id }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 't3', consent: 'yes' }))).toMatch(/LOOP/)
})

test('the 201st call is denied', async ($, on) => {
  on('tool.call', () => ok)
  for (let i = 0; i < 200; i++)
    expect(denied(await $.tool.call({ tool: 'Read', file_path: `${i}.ts` }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Read', file_path: 'last.ts' }))).toMatch(/EXPLOSION/)
})
