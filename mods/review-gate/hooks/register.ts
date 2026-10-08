import type { Register, EngineInterface } from 'claude-code'

// Gate B (cross-review PASS) enforced where unreviewed code would enter integration/main: the
// merge. /review-record PASS|BLOCK [ref] writes ~/.gantry/reviews/<sha>.json (operator-owned,
// outside every repo and worktree); a `git merge <src>` on main/integration, or
// `harness.sh integ-merge <slug>`, is denied unless the source SHA has a PASS. Pushes are not
// gated (promote is already operator-gated). Smoke alarm: the real gate is the console's
// integ-merge honouring the same file (harness follow-up).

const PROTECTED = new Set(['main', 'integration'])
const MERGE_PASSTHROUGH = new Set(['--abort', '--continue', '--quit', '--dry-run'])
const VALUE_FLAGS = new Set(['-m', '--message', '-F', '--file', '-S', '--gpg-sign', '-s', '--strategy', '-X', '--strategy-option'])

async function reviewsDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/root'
  return `${home}/.gantry/reviews`
}

async function git($: EngineInterface, dir: string | undefined, ...args: string[]): Promise<string | undefined> {
  const argv = dir === undefined ? ['git', ...args] : ['git', '-C', dir, ...args]
  const r = await $.process.run(argv).catch(() => undefined)
  return r !== undefined && r.exitCode === 0 ? r.stdout.trim() : undefined
}

// The deny text for merging `src` (in `dir`), or undefined when a PASS artifact covers its SHA.
async function mergeDenial($: EngineInterface, dir: string | undefined, src: string): Promise<string | undefined> {
  const sha = await git($, dir, 'rev-parse', '--verify', `${src}^{commit}`)
  if (sha === undefined) return `review-gate: cannot resolve ${src} to a commit; nothing to merge.`
  const file = `${await reviewsDir($)}/${sha}.json`
  const raw = await $.fs.read(file).catch(() => undefined)
  let rec: { verdict?: string; head?: string } | undefined
  try { rec = typeof raw === 'string' ? JSON.parse(raw) : undefined } catch { rec = undefined }
  if (rec?.verdict === 'PASS' && rec.head === sha) return undefined
  return `review-gate: no Gate-B PASS recorded for ${src} (${sha.slice(0, 12)}). Run the cross-review skill, then \`/review-record PASS ${src}\`; a BLOCK must be fixed in place and re-reviewed.`
}

// Shell-ish tokens with quoted strings blanked, so `-m "merge x"` cannot leak a source name.
const tokens = (cmd: string) => cmd.replace(/"[^"]*"|'[^']*'/g, '""').trim().split(/\s+/)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-record',
      description: 'Record the cross-review verdict for a ref (default HEAD) so review-gate lets it merge.',
      argumentHint: 'PASS|BLOCK [ref]',
    })
    return next(e)
  })

  on('command.run', { command: 'review-record' }, async ($, e) => {
    const [verdict, ref = 'HEAD'] = e.args.trim().split(/\s+/)
    if (verdict !== 'PASS' && verdict !== 'BLOCK') return { text: 'usage: /review-record PASS|BLOCK [ref]' }
    const sha = await git($, undefined, 'rev-parse', '--verify', `${ref}^{commit}`)
    if (sha === undefined) return { text: `review-record: cannot resolve ${ref}.` }
    const dir = await reviewsDir($)
    // fs.write creates the folder as needed.
    await $.fs.write(`${dir}/${sha}.json`, JSON.stringify({ verdict, head: sha, ref, at: new Date().toISOString() }) + '\n')
    return { text: `review-record: ${verdict} for ${ref} (${sha.slice(0, 12)}).` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    const t = tokens(cmd)

    // harness.sh integ-merge <slug>: always into integration, source feat/<slug>.
    const im = t.findIndex((x, i) => x === 'integ-merge' && /harness\.sh$/.test(t[i - 1] ?? ''))
    if (im >= 0) {
      const slug = t[im + 1]
      if (slug === undefined) return next(e)
      const deny = await mergeDenial($, undefined, `feat/${slug}`)
      return deny === undefined ? next(e) : { deny }
    }

    // The first `git [-C dir] merge|pull` anywhere in the text (a compound command may lead
    // with another git call, e.g. `git checkout integration && git merge feat/x`).
    let i = -1
    let dir: string | undefined
    for (let k = 0; k < t.length; k++) {
      if (t[k] !== 'git') continue
      let j = k + 1
      let d: string | undefined
      if (t[j] === '-C') { d = t[j + 1]; j += 2 }
      if (t[j] === 'merge' || t[j] === 'pull') { i = j; dir = d; break }
    }
    if (i < 0) return next(e)
    const sub = t[i]

    // The hook samples the branch before the shell runs: a compound command can switch branch
    // or directory first, so a raw merge/pull inside one is refused outright.
    if (/&&|;|\|\||\n/.test(cmd) || /(^|\s)cd\s/.test(cmd) || /\bgit\s+(checkout|switch)\b/.test(cmd))
      return { deny: 'review-gate: run the merge as its own command (or via harness.sh integ-merge); it cannot be gated inside a compound command.' }

    const branch = await git($, dir, 'rev-parse', '--abbrev-ref', 'HEAD')
    if (branch === undefined || !PROTECTED.has(branch)) return next(e)

    if (sub === 'pull')
      return { deny: `review-gate: git pull on ${branch} is a merge the gate cannot inspect; fetch, then merge the reviewed ref.` }

    const rest = t.slice(i + 1)
    if (rest.some(x => MERGE_PASSTHROUGH.has(x))) return next(e)
    const sources: string[] = []
    for (let k = 0; k < rest.length; k++) {
      const x = rest[k] ?? ''
      if (VALUE_FLAGS.has(x)) { k++; continue }
      if (x.startsWith('-') || x === '""') continue
      sources.push(x)
    }
    if (sources.length !== 1)
      return { deny: `review-gate: merge into ${branch} must name exactly one reviewed source ref (got ${sources.length}).` }
    const deny = await mergeDenial($, dir, sources[0] ?? '')
    return deny === undefined ? next(e) : { deny }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'review-gate: guard failed; call refused.' }))
}
