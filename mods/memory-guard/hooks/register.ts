import type { Register, EngineInterface } from 'claude-code'

// memory-os rules that were only prose in agent .md files: JSON under memory_layer/{projects,
// global} is written by `mem propose` alone, and nothing under memory_layer/ holds a secret.
// Smoke alarm, not a boundary (a script the agent writes elsewhere and runs is not caught);
// filesystem permissions and the memory-os pre-push hook are the boundary.

const SECRETS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI/Anthropic-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['Slack token', /\bxox[abp]-[A-Za-z0-9-]{10,}/],
]
// ponytail: no 12-word seed-phrase pattern — any twelve lowercase words is ordinary prose.

const WRITE_TOKENS = /(^|[^<])>|\|\s*tee\b|\bsed\s+-i|\b(mv|cp|rm)\s|-delete\b|-exec\b|\bopen\(|write_text|\bgit\s+(checkout|restore|clean|reset|apply|stash)\b/
const READERS = /^\s*(cat|less|head|tail|jq|grep|rg|ls|find|diff|git)\s/

let configuredRoot = '/home/alter/claude/memory-os'
let root = configuredRoot // realpath of configuredRoot once resolved, so a symlinked checkout still matches
let protectedDirs: string[] = []
const under = (p: string, dir: string) => p === dir || p.startsWith(dir + '/')

// Targets are compared realpathed, so the root must be too; resolved on first use, re-tried
// while the checkout is missing (then the spelling stands and nothing under it exists anyway).
let isRootResolved = false
async function resolveRoot($: EngineInterface): Promise<void> {
  if (isRootResolved) return
  const st = await $.fs.stat(configuredRoot, { resolve: true }).catch(() => undefined)
  if (st?.realPath === undefined) return
  root = st.realPath.replace(/\/$/, '')
  protectedDirs = dirsOf(root)
  isRootResolved = true
}
// Both spellings: targets are realpathed (so match `root`), Bash text is not (so match the
// configured spelling too — the agent types whichever it was told).
const roots = () => [...new Set([root, configuredRoot])]
const dirsOf = (r: string) => [`${r}/memory_layer/projects`, `${r}/memory_layer/global`]
const bashProtectedDirs = () => roots().flatMap(dirsOf)

// Where a path lands: realpath of the nearest EXISTING ancestor plus the rest of the spelling,
// so a file (or folder) not there yet is still placed. undefined when nothing on it resolves.
async function placed($: EngineInterface, spelled: string): Promise<string | undefined> {
  const abs = spelled.startsWith('/') ? spelled : `${await $.session.cwd()}/${spelled}`
  const parts = abs.split('/').filter(p => p !== '' && p !== '.')
  for (let i = parts.length; i > 0; i--) {
    const head = '/' + parts.slice(0, i).join('/')
    const st = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
    if (st?.realPath !== undefined) return [st.realPath.replace(/\/$/, ''), ...parts.slice(i)].join('/')
  }
  return undefined
}

// The deny text for a file write, or undefined when it may go on.
async function fileDenial($: EngineInterface, filePath: string, text: string): Promise<string | undefined> {
  await resolveRoot($)
  const real = await placed($, filePath)
  if (real === undefined) return undefined
  if (protectedDirs.some(d => under(real, d)))
    return `memory-guard: ${filePath} is memory-os source of truth. Direct edits are denied; write it through \`mem propose <slug> <type> '<json>'\`.`
  if (under(real, `${root}/memory_layer`)) {
    const hit = SECRETS.find(([, re]) => re.test(text))
    if (hit) return `memory-guard: the content looks like a ${hit[0]}; secrets never enter memory_layer/.`
  }
  return undefined
}

export const register: Register = (on, options) => {
  configuredRoot = String(options.memoryRoot ?? configuredRoot).replace(/\/$/, '')
  root = configuredRoot
  protectedDirs = dirsOf(root)
  isRootResolved = false

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const deny = await fileDenial($, e.file_path, e.new_string)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'memory-guard: guard failed; call refused.' }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const deny = await fileDenial($, e.file_path, e.content)
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'memory-guard: guard failed; call refused.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    await resolveRoot($)
    const cmd = e.command
    const cwd = await $.session.cwd()
    const namesProtected =
      bashProtectedDirs().some(d => cmd.includes(d)) ||
      (roots().some(r => under(cwd, r)) && /(^|[\s/'"=])(memory_layer|projects|global)\//.test(cmd))
    if (namesProtected && WRITE_TOKENS.test(cmd))
      return { deny: 'memory-guard: that command writes memory-os JSON directly. Use `mem propose`.' }
    if (/^\s*mem\s/.test(cmd) || cmd.includes('engine/cli.py') || READERS.test(cmd)) return next(e)
    if (namesProtected)
      return { deny: 'memory-guard: only readers and the `mem` CLI may touch memory_layer/{projects,global}.' }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'memory-guard: guard failed; call refused.' }))
}
