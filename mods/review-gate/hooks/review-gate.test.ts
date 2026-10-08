import { test, expect, type TestBody } from 'claude-code/testing'
type On = Parameters<TestBody>[1]

const ok = { result: { content: '' }, text: 'ok' }
const denied = (r: { deny?: string; isError?: boolean; text?: string }) =>
  r.deny ?? (r.isError ? r.text : undefined)

// Runs /review-record as the composer would.
const rec = ($: Parameters<TestBody>[0], args: string) =>
  $.command.run({ command: 'review-record', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const SHA_X = 'a'.repeat(40)
const SHA_X2 = 'b'.repeat(40)
const SHA_MAIN = 'c'.repeat(40)

// A fake repo: `branch` is checked out; refs resolve per `refs`; the reviews dir is in-memory.
const fakeRepo = (on: On, state: { branch: string; refs: Record<string, string> }) => {
  const files = new Map<string, string>()
  on('tool.call', () => ok)
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.read', ($, e) => {
    const v = files.get(e.path)
    if (v === undefined) throw new Error('ENOENT')
    return { value: v }
  })
  const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', ($, e) => {
    const a = [...e.argv]
    if (a[0] !== 'git') throw new Error(`unexpected ${a.join(' ')}`)
    if (a[1] === '-C') a.splice(1, 2)
    if (a[1] === 'rev-parse' && a[2] === '--abbrev-ref') return ran(0, state.branch + '\n')
    if (a[1] === 'rev-parse' && a[2] === '--verify') {
      const ref = (a[3] ?? '').replace(/\^\{commit\}$/, '')
      const sha = state.refs[ref === 'HEAD' ? state.branch : ref]
      return sha === undefined ? ran(128, '') : ran(0, sha + '\n')
    }
    throw new Error(`unexpected git ${a.join(' ')}`)
  })
  return files
}

test('merge into integration: denied without a PASS, allowed after /review-record, denied again when the source moves', async ($, on) => {
  const state = { branch: 'integration', refs: { 'feat/x': SHA_X, integration: SHA_MAIN, main: SHA_MAIN } }
  const files = fakeRepo(on, state)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat/x' }))).toMatch(/no Gate-B PASS/)
  const r = await rec($, 'PASS feat/x')
  expect(r.text).toMatch(/PASS for feat\/x/)
  expect(files.get(`/h/.gantry/reviews/${SHA_X}.json`)).toMatch(/"verdict":"PASS"/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge --no-ff feat/x' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge -m "merge feat/x" feat/x' }))).toBeUndefined()
  state.refs['feat/x'] = SHA_X2
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge feat/x' }))).toMatch(/no Gate-B PASS/)
})

test('a BLOCK record does not unlock; a PASS for a different SHA does not either', async ($, on) => {
  const state = { branch: 'main', refs: { 'feat/x': SHA_X, 'feat/y': SHA_X2, main: SHA_MAIN } }
  fakeRepo(on, state)
  await rec($, 'BLOCK feat/x')
  await rec($, 'PASS feat/y')
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge feat/x' }))).toMatch(/no Gate-B PASS/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge feat/y' }))).toBeUndefined()
})

test('non-gated forms pass: merge-base, --abort, merges on a feature branch, other git commands', async ($, on) => {
  fakeRepo(on, { branch: 'feat/x', refs: { 'feat/x': SHA_X, main: SHA_MAIN } })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge main' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge-base main HEAD' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git status' }))).toBeUndefined()
})

test('on integration: --abort passes, octopus and pull are denied, -C is honoured, compound commands are refused', async ($, on) => {
  fakeRepo(on, { branch: 'integration', refs: { 'feat/x': SHA_X, 'feat/y': SHA_X2, integration: SHA_MAIN } })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge --abort' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git merge feat/x feat/y' }))).toMatch(/exactly one/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git pull origin feat/x' }))).toMatch(/git pull/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git -C /repo merge feat/x' }))).toMatch(/no Gate-B PASS/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'git checkout integration && git merge feat/x' }))).toMatch(/compound/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'cd /repo; git merge feat/x' }))).toMatch(/compound/)
})

test('harness.sh integ-merge <slug> is gated on feat/<slug>', async ($, on) => {
  fakeRepo(on, { branch: 'feat/other', refs: { 'feat/x': SHA_X } })
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'bash .claude/skills/harness/harness.sh integ-merge x' }))).toMatch(/no Gate-B PASS/)
  await rec($, 'PASS feat/x')
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'bash .claude/skills/harness/harness.sh integ-merge x' }))).toBeUndefined()
})

test('/review-record validates its arguments', async ($, on) => {
  fakeRepo(on, { branch: 'main', refs: { main: SHA_MAIN } })
  expect((await rec($, 'MAYBE')).text).toMatch(/usage/)
  expect((await rec($, 'PASS nope')).text).toMatch(/cannot resolve/)
})

test('/review-record defaults to HEAD; extra arguments are ignored', async ($, on) => {
  const files = fakeRepo(on, { branch: 'feat/x', refs: { 'feat/x': SHA_X } })
  expect((await rec($, 'PASS')).text).toMatch(/PASS for HEAD/)
  expect(files.get(`/h/.gantry/reviews/${SHA_X}.json`)).toMatch(/"head":"a{40}"/)
  expect((await rec($, 'BLOCK feat/x trailing words')).text).toMatch(/BLOCK for feat\/x/)
})
