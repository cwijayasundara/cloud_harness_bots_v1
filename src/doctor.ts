// `chb doctor [--repo-dir <dir>]`: is this machine, and this repo, ready? One line per check, each failure with its fix.
// ✓ ok · ! works but degraded · ✗ broken (exit 1). Run it on your Mac, on the Grok Bot computer, and in CI.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Args, opt, out } from './cli.ts'
import { git, defaultBase, mergeBase } from './git.ts'
import { toolsDir, BASELINE } from './gate.ts'
import { TOOLS } from './tools.ts'
import { UB_SENSORS } from './install.ts'
import { repoFromRemote } from './github.ts'
import { version } from './pkg.ts'

type Level = 'ok' | 'warn' | 'fail'
export type Check = { level: Level; what: string; fix?: string }
const MARK: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' }

const has = (cmd: string, args: string[] = ['--version']): string | null => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] ?? '' : null
}

export function nodeOk(v = process.versions.node): boolean {
  const [a = 0, b = 0] = v.split('.').map(Number)
  return a > 22 || (a === 22 && b >= 18)
}

export function machineChecks(): Check[] {
  const c: Check[] = []
  c.push(nodeOk() ? { level: 'ok', what: `node ${process.versions.node}` } : { level: 'fail', what: `node ${process.versions.node}`, fix: 'install Node 22.18 or later (runs TypeScript without a build)' })
  const g = has('git'); c.push(g ? { level: 'ok', what: g } : { level: 'fail', what: 'git missing', fix: 'install git' })
  const py = has('python3')
  if (!py) c.push({ level: 'fail', what: 'python3 missing', fix: "install python3: Uncle Bob's tools build their own venv with it" })
  else c.push(spawnSync('python3', ['-m', 'venv', '--help'], { encoding: 'utf8' }).status === 0 ? { level: 'ok', what: py } : { level: 'fail', what: `${py} without venv`, fix: 'install python3-venv' })
  for (const t of TOOLS) {
    const p = path.join(toolsDir(), t)
    if (!fs.existsSync(path.join(p, t))) { c.push({ level: 'fail', what: `${t} not installed in ${toolsDir()}`, fix: 'chb tools install' }); continue }
    const sha = git(['rev-parse', '--short', 'HEAD'], p)?.trim() ?? '?'
    c.push(fs.existsSync(path.join(p, '.venv')) ? { level: 'ok', what: `${t} @ ${sha}` } : { level: 'warn', what: `${t} @ ${sha}: venv not built`, fix: 'the first gate run builds it (needs PyPI access)' })
  }
  const ghv = has('gh')
  if (!ghv) c.push({ level: 'warn', what: 'gh missing: ledger, merge and report will not work', fix: 'install the GitHub CLI' })
  else c.push(spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).status === 0 ? { level: 'ok', what: `${ghv}, authenticated` } : { level: 'warn', what: `${ghv}, not authenticated`, fix: 'gh auth login, or set GH_TOKEN (a fine-grained token for the repos in scope)' })
  const cl = has('claude')
  c.push(cl ? { level: 'ok', what: `claude ${cl}` } : { level: 'warn', what: 'claude CLI missing: dispatch will not work', fix: 'npm install -g @anthropic-ai/claude-code, then CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`' })
  return c
}

export function repoChecks(dir: string): Check[] {
  const c: Check[] = []
  if (git(['rev-parse', '--show-toplevel'], dir) === null) return [{ level: 'warn', what: `${dir} is not a git repo: repo checks skipped` }]
  if (!fs.existsSync(path.join(dir, '.rig/sensors.json'))) return [{ level: 'warn', what: 'not a rig repo (no .rig/sensors.json): repo checks skipped', fix: 'run /rig:init in the repo, then chb install' }]
  c.push({ level: 'ok', what: 'rig repo' })
  const vendored = path.join(dir, '.rig/ub/VERSION')
  if (!fs.existsSync(vendored)) c.push({ level: 'fail', what: 'chb not vendored into .rig/ub', fix: `chb install ${dir}` })
  else {
    const v = fs.readFileSync(vendored, 'utf8').trim()
    c.push(v === version() ? { level: 'ok', what: `chb ${v} vendored` } : { level: 'warn', what: `chb ${v} vendored, ${version()} available`, fix: `chb upgrade ${dir}` })
  }
  const ids = new Set(((JSON.parse(fs.readFileSync(path.join(dir, '.rig/sensors.json'), 'utf8')) as { sensors?: { id: string; blocks?: boolean }[] }).sensors ?? []).map(s => s.id))
  const missing = UB_SENSORS.filter(s => !ids.has(s.id)).map(s => s.id)
  c.push(missing.length ? { level: 'fail', what: `sensors missing: ${missing.join(', ')}`, fix: `chb install ${dir}` } : { level: 'ok', what: 'ub sensors registered' })
  c.push(fs.existsSync(path.join(dir, BASELINE)) ? { level: 'ok', what: `${BASELINE} present` } : { level: 'fail', what: `no ${BASELINE}: legacy debt would block every change`, fix: 'node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts baseline write --skip mutate, then commit it' })
  const base = defaultBase(dir)
  if (!base) c.push({ level: 'fail', what: 'no base branch found', fix: 'set CHB_BASE, or fetch origin so origin/HEAD exists' })
  else c.push(mergeBase(base, dir) ? { level: 'ok', what: `base ${base}` } : { level: 'fail', what: `no merge-base with ${base}`, fix: 'fetch the full history (git fetch --unshallow)' })
  const repo = repoFromRemote(dir)
  c.push(repo ? { level: 'ok', what: `GitHub ${repo}` } : { level: 'warn', what: 'no github.com origin: pass --repo to ledger, merge and report' })
  c.push(fs.existsSync(path.join(dir, '.github/workflows/ub-gates.yml')) ? { level: 'ok', what: 'ub-gates workflow present' } : { level: 'warn', what: 'no ub-gates workflow: chb merge requires that check', fix: `chb install ${dir} --ci` })
  return c
}

export const render = (title: string, cs: Check[]): string => [title, ...cs.map(x => `  ${MARK[x.level]} ${x.what}${x.fix && x.level !== 'ok' ? `\n      → ${x.fix}` : ''}`)].join('\n')

export function cmdDoctor(args: Args): void {
  const dir = path.resolve(opt(args, 'repo-dir') ?? process.cwd())
  const m = machineChecks(), r = repoChecks(dir)
  out([`chb ${version()} doctor`, '', render('machine', m), '', render(`repo ${dir}`, r)].join('\n'))
  process.exitCode = [...m, ...r].some(x => x.level === 'fail') ? 1 : 0
}
