// `chb tools install|status`: put crapper, dryer and mutator side by side under UB_TOOLS_DIR (default ~/.ub-tools).
// mutator needs crapper at ../crapper, so they must be siblings. Each tool makes its own .venv on first run (python3).
// `--pin crapper=<sha>,dryer=<sha>,mutator=<sha>` checks out commits you have read; otherwise the default branch HEAD.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Args, opt, out, die } from './cli.ts'
import { toolsDir } from './gate.ts'

export const TOOLS = ['crapper', 'dryer', 'mutator'] as const
const REPO = (t: string) => `https://github.com/unclebob/${t}.git`

const run = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { cwd, encoding: 'utf8' })

export function cmdTools(args: Args): void {
  const sub = args.pos[0]
  const dir = toolsDir()
  if (sub === 'status') {
    const lines = TOOLS.map(t => {
      const p = path.join(dir, t)
      if (!fs.existsSync(path.join(p, t))) return `${t}: missing (chb tools install)`
      const sha = run('git', ['rev-parse', '--short', 'HEAD'], p).stdout.trim()
      return `${t}: ${p} @ ${sha || 'unknown'}${fs.existsSync(path.join(p, '.venv')) ? '' : ' (venv not built yet: first run builds it)'}`
    })
    return out([`UB_TOOLS_DIR=${dir}`, ...lines].join('\n'))
  }
  if (sub !== 'install') die('usage: chb tools install [--pin crapper=<sha>,dryer=<sha>,mutator=<sha>] | chb tools status')
  if (run('python3', ['--version']).status !== 0) die('python3 is required: the tools build their own venv with it', 2)
  fs.mkdirSync(dir, { recursive: true })
  const pins = Object.fromEntries((opt(args, 'pin') ?? '').split(',').filter(Boolean).map(kv => kv.split('=') as [string, string]))
  for (const t of TOOLS) {
    const p = path.join(dir, t)
    if (fs.existsSync(path.join(p, '.git'))) {
      const r = run('git', ['fetch', '-q', 'origin'], p)
      if (r.status !== 0) die(`${t}: git fetch failed: ${r.stderr.trim()}`, 2)
    } else {
      const r = run('git', ['clone', '-q', REPO(t), p])
      if (r.status !== 0) die(`${t}: clone failed: ${r.stderr.trim()}`, 2)
    }
    const ref = pins[t] ?? 'origin/HEAD'
    const c = run('git', ['checkout', '-q', '--detach', ref], p)
    if (c.status !== 0) die(`${t}: cannot check out ${ref}: ${c.stderr.trim()}`, 2)
    out(`${t}: ${p} @ ${run('git', ['rev-parse', '--short', 'HEAD'], p).stdout.trim()}`)
  }
  out('Uncle Bob says: do not use them verbatim; point your agents at them and customise. Licence: 0BSD.')
}
