import { test, expect, type TestBody } from 'claude-code/testing'
type On = Parameters<TestBody>[1]

const ROOT = '/mem'
const ok = { result: { content: '' }, text: 'ok' }
const denied = (r: { deny?: string; isError?: boolean; text?: string }) =>
  r.deny ?? (r.isError ? r.text : undefined)

// A fake tree: these directories exist, nothing else does. Stats answer realPath = the path.
const DIRS = new Set(['/', '/w', ROOT, `${ROOT}/memory_layer`, `${ROOT}/memory_layer/projects`, `${ROOT}/memory_layer/projects/foo`, `${ROOT}/memory_layer/global`])
const fakeFs = (on: On, cwd = '/w') => {
  on('tool.call', () => ok)
  on('session.cwd', () => ({ value: cwd }))
  on('fs.stat', ($, e) => {
    if (DIRS.has(e.path)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
    throw new Error('ENOENT')
  })
}
const opts = { options: { memoryRoot: ROOT } }

test('Edit/Write under projects or global is denied; elsewhere allowed', opts, async ($, on) => {
  fakeFs(on)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/memory_layer/projects/foo/decisions.json`, old_string: 'a', new_string: 'b' }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/memory_layer/global/registry.json`, content: '{}' }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/README.md`, content: '# hi' }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/w/notes.md', content: 'x' }))).toBeUndefined()
})

test('a not-yet-existing nested target is placed by its nearest existing ancestor', opts, async ($, on) => {
  fakeFs(on)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/memory_layer/projects/new/deep/x.json`, content: '{}' }))).toMatch(/mem propose/)
})

test('relative paths resolve against the session cwd', opts, async ($, on) => {
  fakeFs(on, `${ROOT}/memory_layer`)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: 'projects/foo/state.json', old_string: 'a', new_string: 'b' }))).toMatch(/mem propose/)
})

test('secrets are denied anywhere under memory_layer/, allowed outside it', opts, async ($, on) => {
  fakeFs(on)
  const key = '-----BEGIN PRIVATE KEY-----\nabc'
  expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/memory_layer/scratch.md`, content: key }))).toMatch(/private key/)
  expect(denied(await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/memory_layer/notes.md`, old_string: 'a', new_string: 'AKIAABCDEFGHIJKLMNOP' }))).toMatch(/AWS/)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/w/keys.txt', content: key }))).toBeUndefined()
  const under = (content: string) => $.tool.call({ tool: 'Write', file_path: `${ROOT}/memory_layer/n.md`, content })
  expect(denied(await under('token sk-abcdefghijklmnopqrstuvwxyz1234'))).toMatch(/key/)
  expect(denied(await under('ghp_abcdefghijklmnopqrstuvwxyz0123456789'))).toMatch(/GitHub/)
  expect(denied(await under('xoxb-1234567890-abcdef'))).toMatch(/Slack/)
  expect(denied(await under('plain prose with twelve ordinary words in a row like this one here'))).toBeUndefined()
})

test('a symlinked memoryRoot is matched by its realpath', { options: { memoryRoot: '/link' } }, async ($, on) => {
  on('tool.call', () => ok)
  on('session.cwd', () => ({ value: '/w' }))
  on('fs.stat', ($, e) => {
    const real = e.path === '/link' ? ROOT : e.path
    if (DIRS.has(real)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: e.path === '/link', realPath: real } }
    throw new Error('ENOENT')
  })
  expect(denied(await $.tool.call({ tool: 'Write', file_path: `${ROOT}/memory_layer/global/x.json`, content: '{}' }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `echo 1 > ${ROOT}/memory_layer/global/x.json` }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `echo 1 > /link/memory_layer/global/x.json` }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Write', file_path: '/link/memory_layer/global/x.json', content: '{}' }))).toMatch(/mem propose/)
})

test('Bash relative spellings count when cwd is the symlink spelling of the root', { options: { memoryRoot: '/link' } }, async ($, on) => {
  on('tool.call', () => ok)
  on('session.cwd', () => ({ value: '/link' }))
  on('fs.stat', ($, e) => {
    const real = e.path === '/link' ? ROOT : e.path
    if (DIRS.has(real)) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: e.path === '/link', realPath: real } }
    throw new Error('ENOENT')
  })
  expect(denied(await $.tool.call({ tool: 'Bash', command: `echo 1 > memory_layer/global/x.json` }))).toMatch(/mem propose/)
})

test('Bash: writes to protected paths denied, readers and the mem CLI allowed', opts, async ($, on) => {
  fakeFs(on)
  const g = `${ROOT}/memory_layer/global/foo.json`
  expect(denied(await $.tool.call({ tool: 'Bash', command: `cat x > ${g}` }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `python3 -c 'open("${g}","w").write("{}")'` }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `find ${ROOT}/memory_layer/projects -name '*.json' -delete` }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `cat ${g}` }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: `jq .x ${g} | head` }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: `python3 ${ROOT}/memory_layer/engine/cli.py propose foo decision '{}'` }))).toBeUndefined()
  expect(denied(await $.tool.call({ tool: 'Bash', command: `mem propose foo decision '{}'` }))).toBeUndefined()
  // `open(` is a write token (the hook can't tell a read-mode open from a write), so this is
  // denied by the stricter branch; what matters is that a non-reader naming the path is denied.
  expect(denied(await $.tool.call({ tool: 'Bash', command: `python3 -c 'print(open("${g}").read())'` }))).toMatch(/memory-guard/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `node -e 'console.log(require("fs").readFileSync("${g}"))'` }))).toMatch(/only readers/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: 'npm test' }))).toBeUndefined()
})

test('Bash: relative spellings count when cwd is inside the memory root', opts, async ($, on) => {
  fakeFs(on, ROOT)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `echo '{}' > memory_layer/global/x.json` }))).toMatch(/mem propose/)
  expect(denied(await $.tool.call({ tool: 'Bash', command: `cat memory_layer/global/x.json` }))).toBeUndefined()
})
