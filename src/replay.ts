// `chb replay …`: does rig, or Tare, change outcomes on your own work? (Masterstock improvement plan, phase 1.)
//   build  — turn merged PRs (or commits) into tasks. The parent commit is the start; the tests the change touched are
//            hidden from the agent and become the score.
//   check  — keep only tasks whose hidden tests fail at the start and pass at the accepted solution.
//   run    — for every task × arm × model × run: a history-free snapshot of the start (no later commits to peek at),
//            the arm's preparation, the agent, then the hidden tests restored over whatever the agent wrote, and run.
//   report — pass rate per arm with run-to-run spread, and a paired bootstrap of each arm against a baseline arm.
// Nothing here trusts the agent's account of its work: the score is the accepted change's own tests.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { type Args, flag, opt, out, warn, die } from './cli.ts'
import { git, TEST_FILE } from './git.ts'
import { norm } from './judge.ts'
import { gh } from './gh.ts'
import { mergedSince, repoFromRemote } from './github.ts'
import { TARE_PATH, TARE_LINE } from './dispatch.ts'

export type ChangeType = 'feature' | 'bugfix' | 'refactor' | 'chore' | 'other'
export type Task = {
  id: string; title: string; type: ChangeType; prompt: string; base: string; solution: string; hidden: string[]
  size: { files: number; added: number; deleted: number }; pr?: number; valid?: boolean | null; note?: string
  config?: string[] // test/build config the solution changed: scored with the solution's version, never the agent's
}
export type TaskFile = { version: 1; repo: string | null; built: string; testCmd?: string; setup?: string; tasks: Task[] }
export type Arm = { name: string; prompt: string; strip?: string[]; tare?: boolean; setup?: string; agentCmd?: string }
export type Status = 'pass' | 'fail' | 'blocked' | 'timeout' | 'agent-error'
// Not the agent's doing (setup failed, claude missing, auth, rate limits): never saved as a result, retried on resume.
export type Infra = { infra: string }
export type Result = {
  task: string; type: ChangeType; arm: string; model: string; run: number; status: Status; pass: boolean
  agentExit: number | null; testExit: number | null; costUsd: number | null; turns: number | null
  tokensIn: number | null; tokensOut: number | null; wallMs: number; diff: { files: number; added: number; deleted: number }
  gates: { crap: number | null; dry: number | null } | null; at: string
}

// ---------- classification ----------

export function changeType(title: string, labels: string[] = []): ChangeType {
  const t = title.trim().toLowerCase(), l = labels.map(x => x.toLowerCase())
  const pre = (re: string) => new RegExp(`^(${re})(\\(|:|!)`).test(t)
  if (pre('fix|bugfix|hotfix') || l.includes('bug')) return 'bugfix'
  if (pre('feat|feature') || l.includes('feature') || l.includes('enhancement')) return 'feature'
  if (pre('refactor') || l.includes('refactor')) return 'refactor'
  if (pre('chore|build|ci|deps|docs|perf|style') || l.includes('chore')) return 'chore'
  return 'other'
}

export const isTestPath = (file: string): boolean => { const f = norm(file); return !/\.d\.[cm]?ts$/.test(f) && (TEST_FILE.test(f) || /(^|\/)(test|tests|spec|specs|__tests__)\//.test(f)) }

// Files that decide what "the tests pass" means: the test runner's config, scripts, fixtures and snapshots, and the
// dependency set. The agent's edits to these are never scored (an `exit 0` test script, a conftest that skips
// everything, a deleted snapshot); scoring uses the start's version, or the accepted solution's where it changed one.
const CONFIG = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|tsconfig[^/]*\.json|(jest|vitest|vite|babel|karma|playwright|cypress|mocha|ava|tap|c8|nyc)\.config\.[cm]?[jt]s(on)?|\.mocharc[^/]*|\.babelrc[^/]*|\.nycrc[^/]*|conftest\.py|pytest\.ini|tox\.ini|setup\.cfg|setup\.py|pyproject\.toml|noxfile\.py|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|Makefile|justfile|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|build\.gradle(\.kts)?|pom\.xml|deps\.edn|project\.clj|bb\.edn)$/
export const isScoringConfig = (file: string): boolean => { const f = norm(file); return CONFIG.test(f) || /\.snap$/.test(f) || /(^|\/)__snapshots__\//.test(f) }
const HARNESS = /^(\.rig|\.claude)\//

// The brief the agent gets: the PR's title and description, without template comments.
export const taskPrompt = (title: string, body: string): string => `${title.trim()}\n\n${body.replace(/<!--[\s\S]*?-->/g, '').trim()}`.trim()

// ---------- build ----------

function exists(dir: string, sha: string, file: string): boolean { return git(['cat-file', '-e', `${sha}:${file}`], dir) !== null }

// A task from a start commit and a solution commit, or the reason it cannot be one.
export function taskFrom(dir: string, t: { id: string; title: string; body: string; base: string; solution: string; labels?: string[]; pr?: number }, maxLines: number): Task | string {
  const numstat = git(['diff', '--numstat', '--no-renames', t.base, t.solution], dir)
  if (numstat === null) return 'commits not in this clone (git fetch origin)'
  let files = 0, added = 0, deleted = 0
  const hidden: string[] = [], config: string[] = []
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [a, d, f] = line.split('\t') as [string, string, string]
    if (HARNESS.test(norm(f))) continue
    files++; added += Number(a) || 0; deleted += Number(d) || 0
    if (isTestPath(f) && exists(dir, t.solution, f)) hidden.push(norm(f))
    else if (isScoringConfig(f)) config.push(norm(f))
  }
  if (!hidden.length) return 'no test files changed, so nothing can score it'
  if (hidden.length + config.length === files) return 'only tests or test config changed'
  if (added + deleted > maxLines) return `too large (${added + deleted} lines > ${maxLines})`
  return { id: t.id, title: t.title, type: changeType(t.title, t.labels), prompt: taskPrompt(t.title, t.body), base: t.base, solution: t.solution, hidden: hidden.sort(), config: config.sort(), size: { files, added, deleted }, ...(t.pr ? { pr: t.pr } : {}), valid: null }
}

const rev = (dir: string, ref: string): string | null => git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], dir)?.trim() || null

function candidatesFromCommits(dir: string, refs: string[]) {
  return refs.map(ref => {
    const solution = rev(dir, ref), base = solution ? rev(dir, `${solution}^1`) : null
    const [title = '', ...body] = (solution ? git(['log', '-1', '--format=%B', solution], dir) ?? '' : '').split('\n')
    return { id: `commit-${(solution ?? ref).slice(0, 10)}`, title, body: body.join('\n'), base: base ?? '', solution: solution ?? '', missing: !solution || !base }
  })
}

function candidatesFromPRs(dir: string, repo: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000)
  return mergedSince(repo, since).map(p => {
    const d = JSON.parse(gh(['api', `repos/${repo}/pulls/${p.number}`, '--jq', '{sha: .merge_commit_sha, body: (.body // ""), commits}'])) as { sha: string | null; body: string; commits: number }
    const solution = d.sha && rev(dir, d.sha)
    let base = solution ? rev(dir, `${solution}^1`) : null
    // Merge and squash merges: the parent is main before the PR. A rebase merge puts the PR's n commits on main one
    // by one, so the start is n commits back. Told apart by the last PR commit's subject reappearing on main.
    if (solution && base && d.commits > 1 && !rev(dir, `${solution}^2`)) {
      const last = gh(['api', '--paginate', `repos/${repo}/pulls/${p.number}/commits?per_page=100`, '--jq', '.[].commit.message | split("\n")[0]']).trim().split('\n').pop()
      if (last && git(['log', '-1', '--format=%s', solution], dir)?.trim() === last) base = rev(dir, `${solution}~${d.commits}`)
    }
    return { id: `pr-${p.number}`, pr: p.number, title: p.title, body: d.body, labels: p.labels.map(l => l.name), base: base ?? '', solution: solution ?? '', missing: !solution || !base }
  })
}

export function loadTasks(file: string): TaskFile {
  if (!fs.existsSync(file)) die(`${file} not found: run chb replay build first`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TaskFile
}
const saveTasks = (file: string, tf: TaskFile): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(tf, null, 2) + '\n') }

function cmdBuild(args: Args, dir: string, file: string): void {
  const maxLines = Number(opt(args, 'max-lines') ?? 800), limit = Number(opt(args, 'limit') ?? 50)
  const repo = opt(args, 'repo') ?? repoFromRemote(dir)
  const commits = opt(args, 'commits')
  if (!commits && !repo) die('no GitHub repo: pass --repo owner/name, or --commits <sha,sha,…> to build from local commits')
  const cands = commits ? candidatesFromCommits(dir, commits.split(',').map(s => s.trim()).filter(Boolean)) : candidatesFromPRs(dir, repo!, Number(opt(args, 'days') ?? 90))
  // Keep what is already in the file: prompts you edited and check results survive a rebuild.
  const tf: TaskFile = fs.existsSync(file) ? loadTasks(file) : { version: 1, repo: repo ?? null, built: '', tasks: [] }
  const known = new Set(tf.tasks.map(t => t.id))
  const skipped: string[] = []
  let added = 0
  for (const c of cands) {
    if (tf.tasks.length >= limit) break
    if (known.has(c.id)) continue
    if (c.missing) { skipped.push(`${c.id}: commits not in this clone (git fetch origin)`); continue }
    const t = taskFrom(dir, c, maxLines)
    if (typeof t === 'string') { skipped.push(`${c.id}: ${t}`); continue }
    tf.tasks.push(t); added++
  }
  if (opt(args, 'test-cmd')) tf.testCmd = opt(args, 'test-cmd')
  if (opt(args, 'setup')) tf.setup = opt(args, 'setup')
  tf.built = new Date().toISOString()
  saveTasks(file, tf)
  const byType = tf.tasks.reduce<Record<string, number>>((m, t) => ({ ...m, [t.type]: (m[t.type] ?? 0) + 1 }), {})
  out([`${file}: ${tf.tasks.length} task(s), ${added} new (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`,
    ...skipped.map(s => `  skipped ${s}`),
    `Next: read each prompt and rewrite any that give the answer away, then chb replay check${tf.testCmd ? '' : ' --test-cmd "<command; {hidden} = the hidden test files>"'}`].join('\n'))
}

// ---------- workspaces ----------

const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
export const testCommand = (cmd: string, hidden: string[]): string => cmd.replaceAll('{hidden}', () => hidden.map(quote).join(' '))
const GIT_ID = ['-c', 'user.name=chb replay', '-c', 'user.email=replay@chb.invalid', '-c', 'commit.gpgsign=false']

// A copy of `sha` with no history: the agent cannot find the solution in git log, other branches or the reflog.
export function snapshot(repoDir: string, sha: string, prepare?: (ws: string) => void): { ws: string; start: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-replay-'))
  const tar = `${ws}.tar`
  try {
    if (git(['archive', '--format=tar', '-o', tar, sha], repoDir) === null) throw new Error(`git archive ${sha} failed`)
    const x = spawnSync('tar', ['-xf', tar, '-C', ws])
    if (x.status !== 0) throw new Error(`tar could not unpack ${sha}`)
    prepare?.(ws)
    git(['init', '-q', '-b', 'main'], ws); git(['add', '-A'], ws)
    if (git([...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'replay start'], ws) === null) throw new Error('could not commit the snapshot')
    return { ws, start: git(['rev-parse', 'HEAD'], ws)!.trim() }
  } catch (e) { fs.rmSync(ws, { recursive: true, force: true }); throw e } finally { fs.rmSync(tar, { force: true }) }
}

// Put the accepted versions of the hidden tests back, over anything the agent wrote at those paths.
export function restoreHidden(repoDir: string, task: Task, ws: string): void {
  for (const f of [...task.hidden, ...(task.config ?? [])]) {
    const r = spawnSync('git', ['show', `${task.solution}:${f}`], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 })
    const to = path.join(ws, f)
    if (r.status !== 0) {
      if (task.hidden.includes(f)) throw new Error(`hidden test ${f} is not in ${task.solution}`)
      fs.rmSync(to, { force: true }); continue // config the solution deleted
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.writeFileSync(to, r.stdout)
  }
}

// The agent's work as the scorer sees it: its changes to source only. Test files, scoring config and the harness
// folders come from the start (or the solution, via restoreHidden), so nothing the agent did to them counts.
export function carryOver(agentWs: string, from: string, scoreWs: string): string[] {
  const carried: string[] = []
  for (const line of (git(['diff', '--name-status', '--no-renames', '-z', from, 'HEAD'], agentWs) ?? '').split('\0').reduce<string[][]>((acc, x, i, arr) => (i % 2 === 0 && x ? [...acc, [x, arr[i + 1] ?? '']] : acc), [])) {
    const [st, f] = line as [string, string]
    if (!f || isTestPath(f) || isScoringConfig(f) || HARNESS.test(norm(f))) continue
    const src = path.join(agentWs, f), dst = path.join(scoreWs, f)
    if (st === 'D') fs.rmSync(dst, { force: true })
    else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst) }
    carried.push(f)
  }
  return carried
}

type Ran = { code: number | null; out: string; timedOut: boolean; ms: number; spawnError?: string }
// Process groups still running, so Ctrl-C stops the agents (and their spend) too.
const live = new Set<number>()
const killGroup = (pid: number | undefined): void => { if (!pid) return; try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
let trapped = false
const trap = (): void => {
  if (trapped) return
  trapped = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { for (const pid of live) killGroup(pid); process.exit(130) })
}

// Async, so `--jobs` agents run side by side. The result is the main process's exit; anything it left running in the
// background (a dev server, a watcher) is killed with its process group then, so it can neither hold the run open
// until the timeout nor collide with a neighbour's ports.
export function sh(cmd: string, cwd: string, timeoutMs: number, opts: { input?: string; env?: NodeJS.ProcessEnv; argv?: string[] } = {}): Promise<Ran> {
  trap()
  return new Promise(resolve => {
    const t0 = Date.now()
    const env = opts.env ?? process.env
    const p = opts.argv ? spawn(opts.argv[0]!, opts.argv.slice(1), { cwd, env, detached: true }) : spawn('sh', ['-c', cmd], { cwd, env, detached: true })
    if (p.pid) live.add(p.pid)
    let buf = '', timedOut = false, exitCode: number | null | undefined, spawnError: string | undefined
    const keep = (d: Buffer) => { buf += d.toString(); if (buf.length > 4_000_000) buf = buf.slice(-2_000_000) }
    p.stdout.on('data', keep); p.stderr.on('data', keep)
    p.stdin.on('error', () => { /* the command did not read its input: fine */ })
    const timer = setTimeout(() => { if (exitCode === undefined) { timedOut = true; killGroup(p.pid) } }, timeoutMs)
    p.on('error', e => { spawnError = String(e); buf += spawnError })
    p.on('exit', code => { exitCode = code; clearTimeout(timer); setTimeout(() => killGroup(p.pid), 200) })
    p.on('close', code => {
      clearTimeout(timer); if (p.pid) live.delete(p.pid)
      resolve({ code: exitCode === undefined ? code : exitCode, out: buf, timedOut, ms: Date.now() - t0, ...(spawnError ? { spawnError } : {}) })
    })
    if (opts.input !== undefined) p.stdin.end(opts.input); else p.stdin.end()
  })
}

// ---------- check ----------

async function cmdCheck(args: Args, dir: string, file: string): Promise<void> {
  const tf = loadTasks(file)
  const testCmd = opt(args, 'test-cmd') ?? tf.testCmd
  if (!testCmd) die('no test command: pass --test-cmd "<command>" ({hidden} is replaced by the hidden test files)')
  tf.testCmd = testCmd
  if (opt(args, 'setup')) tf.setup = opt(args, 'setup')
  const timeout = Number(opt(args, 'test-timeout') ?? 10) * 60_000
  for (const t of tf.tasks) {
    if (t.valid !== null && t.valid !== undefined && !flag(args, 'force')) continue
    const at = async (sha: string, withHidden: boolean): Promise<Ran> => {
      const { ws } = snapshot(dir, sha)
      try {
        if (tf.setup) { const s = await sh(tf.setup, ws, timeout); if (s.code !== 0) return { ...s, code: -1 } }
        if (withHidden) restoreHidden(dir, t, ws); else if (t.config?.length) restoreHidden(dir, { ...t, hidden: [] }, ws)
        return await sh(testCommand(testCmd, t.hidden), ws, timeout)
      } finally { fs.rmSync(ws, { recursive: true, force: true }) }
    }
    try {
      const before = await at(t.base, true), after = await at(t.solution, false)
      t.valid = before.code !== 0 && before.code !== -1 && !before.timedOut && after.code === 0
      t.note = after.code === -1 || before.code === -1 ? 'setup failed'
        : before.timedOut || after.timedOut ? 'tests timed out (raise --test-timeout)'
        : after.code !== 0 ? 'hidden tests fail at the solution (flaky, or need setup)'
        : before.code === 0 ? 'hidden tests already pass at the start, so they cannot tell a fix from no fix' : 'ok'
    } catch (e) { t.valid = false; t.note = `could not check: ${(e as Error).message}` }
    out(`${t.valid ? 'valid  ' : 'invalid'} ${t.id} ${t.type}: ${t.note}`)
    saveTasks(file, tf) // after every task: a crash keeps what was checked
  }
  const n = tf.tasks.filter(t => t.valid).length
  out(`${n} of ${tf.tasks.length} task(s) valid.${n < 20 ? ' The plan asks for 20–50: widen --days or add --commits.' : ''}`)
}

// ---------- arms and the agent ----------

const GO = 'No person is available. Do not ask questions: make reasonable decisions, list them in your final message, and finish the change. Run whatever checks you need.'
const RIG = 'Use this repository\'s rig workflow for the change below: /rig:start, then /rig:plan, /rig:build and /rig:test. This is an offline replay and no person is present. Where rig needs a person\'s approval, treat it as given for this replay; if rig will not continue without one, stop and end with the line CHB-RESULT status=blocked.'

export const DEFAULT_ARMS: Arm[] = [
  { name: 'bare', strip: ['.rig', '.claude', 'CLAUDE.md', 'AGENTS.md'], prompt: `{task}\n\n${GO}` },
  { name: 'rig', prompt: `${RIG}\n\n{task}\n\n${GO}` },
  { name: 'rig+tare', tare: true, prompt: `${RIG}\n\n{task}\n\n${GO}` },
]

export const armPrompt = (arm: Arm, task: Task): string => (arm.tare ? `${TARE_LINE}\n\n` : '') + arm.prompt.replaceAll('{task}', () => task.prompt)

export function claudeArgv(prompt: string, model: string, permissionMode: string, budget?: string): string[] {
  // Project settings only: your user-level skills, plugins and hooks would otherwise apply to every arm, bare included.
  return ['claude', '-p', prompt, '--model', model, '--output-format', 'json', '--permission-mode', permissionMode, '--setting-sources', 'project,local',
    ...(budget ? ['--max-budget-usd', budget] : []), '--disallowedTools', 'WebFetch', 'WebSearch']
}

// `claude -p --output-format json` prints one result object; take the last line that parses as one.
export function usage(stdout: string): { costUsd: number | null; turns: number | null; tokensIn: number | null; tokensOut: number | null; isError: boolean } {
  for (const line of stdout.trim().split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue
    try {
      const j = JSON.parse(line) as { total_cost_usd?: number; num_turns?: number; is_error?: boolean; usage?: Record<string, number> }
      if (j.total_cost_usd === undefined && j.num_turns === undefined && j.usage === undefined) continue
      const u = j.usage ?? {}
      const tin = u.input_tokens === undefined ? null : (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      return { costUsd: j.total_cost_usd ?? null, turns: j.num_turns ?? null, tokensIn: tin, tokensOut: u.output_tokens ?? null, isError: j.is_error === true }
    } catch { /* not the result line */ }
  }
  return { costUsd: null, turns: null, tokensIn: null, tokensOut: null, isError: false }
}

function diffSize(ws: string, start: string): Result['diff'] {
  let files = 0, added = 0, deleted = 0
  for (const line of (git(['diff', '--numstat', start, 'HEAD'], ws) ?? '').split('\n').filter(Boolean)) {
    const [a, d, f] = line.split('\t') as [string, string, string]
    if (/^(\.rig|\.claude)\//.test(f)) continue
    files++; added += Number(a) || 0; deleted += Number(d) || 0
  }
  return { files, added, deleted }
}

const lastNumber = (s: string): number | null => { const m = /(-?\d+(\.\d+)?)\s*$/.exec(s.trim()); return m ? Number(m[1]) : null }

type Job = { task: Task; arm: Arm; model: string; run: number; out: string }
type RunCfg = { dir: string; tf: TaskFile; tare: string | null; agentCmd?: string; permissionMode: string; budget?: string; agentMs: number; testMs: number; gates: boolean; keep: boolean }

// Tokens the agent could use to read the merged PR (gh pr view, the API): removed from its environment.
const SECRETS = /^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GITLAB_TOKEN|CHB_GH_TOKEN)$/
export const agentEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRETS.test(k))), ...extra })
const INFRA_OUTPUT = /rate.?limit|overloaded|\b(401|403|429|529)\b|authenticat|invalid api key|credit balance|ENOENT/i

export async function runOne(j: Job, c: RunCfg): Promise<Result | Infra> {
  const base = { task: j.task.id, type: j.task.type, arm: j.arm.name, model: j.model, run: j.run, at: new Date().toISOString() }
  const setups = [c.tf.setup, j.arm.setup].filter(Boolean) as string[]
  const { ws } = snapshot(c.dir, j.task.base, w => {
    for (const s of j.arm.strip ?? []) fs.rmSync(path.join(w, s), { recursive: true, force: true })
    // Arms without Tare must not get a committed copy of it either, or rig vs rig+tare understates it.
    fs.rmSync(path.join(w, TARE_PATH), { force: true })
    if (j.arm.tare && c.tare) { fs.mkdirSync(path.join(w, path.dirname(TARE_PATH)), { recursive: true }); fs.copyFileSync(c.tare, path.join(w, TARE_PATH)) }
  })
  let scoreWs: string | null = null
  try {
    for (const s of setups) { const r = await sh(s, ws, c.testMs); if (r.code !== 0) return { infra: `setup failed: ${s}` } }
    // Setup output (node_modules, venvs) is not the agent's work: commit it into the start.
    git(['add', '-A'], ws); git([...GIT_ID, 'commit', '-q', '-m', 'replay setup'], ws)
    const setupHead = git(['rev-parse', 'HEAD'], ws)!.trim()
    const prompt = armPrompt(j.arm, j.task)
    const cmd = j.arm.agentCmd ?? c.agentCmd
    const env = agentEnv({ CHB_REPLAY_MODEL: j.model, CHB_REPLAY_TASK: j.task.id, CHB_REPLAY_ARM: j.arm.name })
    const a = cmd ? await sh(cmd, ws, c.agentMs, { input: prompt, env }) : await sh('', ws, c.agentMs, { argv: claudeArgv(prompt, j.model, c.permissionMode, c.budget), env })
    if (a.spawnError || (!a.timedOut && (a.code === null || a.code < 0 || a.code === 127))) return { infra: `agent did not start: ${(a.spawnError ?? a.out).trim().slice(0, 200)}` }
    const u = usage(a.out)
    git(['add', '-A'], ws); git([...GIT_ID, 'commit', '-q', '--allow-empty', '-m', 'agent work'], ws)
    const diff = diffSize(ws, setupHead)
    let gates: Result['gates'] = null
    if (c.gates) {
      const g = (name: string) => sh('', ws, c.testMs, { argv: [process.execPath, '--disable-warning=ExperimentalWarning', process.argv[1]!, 'gate', name, '--base', setupHead] })
      gates = { crap: lastNumber((await g('crap')).out), dry: lastNumber((await g('dry')).out) }
    }
    // Score in a fresh copy of the start: the agent's source changes, the accepted tests and config, a clean setup.
    scoreWs = snapshot(c.dir, j.task.base).ws
    carryOver(ws, setupHead, scoreWs)
    restoreHidden(c.dir, j.task, scoreWs)
    for (const s of setups) { const r = await sh(s, scoreWs, c.testMs); if (r.code !== 0) return { infra: `setup failed while scoring: ${s}` } }
    const t = await sh(testCommand(c.tf.testCmd!, j.task.hidden), scoreWs, c.testMs)
    const passed = t.code === 0 && !t.timedOut
    if (!passed && (u.isError || a.code !== 0) && INFRA_OUTPUT.test(a.out.slice(-4000))) return { infra: `agent stopped by the service: ${a.out.trim().split('\n').pop()?.slice(0, 200)}` }
    const blocked = /CHB-RESULT[^\n]*status=blocked/.test(a.out)
    const status: Status = passed ? 'pass' : a.timedOut ? 'timeout' : blocked ? 'blocked' : a.code !== 0 || u.isError ? 'agent-error' : 'fail'
    return { ...base, status, pass: passed, agentExit: a.code, testExit: t.code, ...u, wallMs: a.ms, diff, gates }
  } finally {
    if (c.keep) warn(`kept ${j.task.id}/${j.arm.name}/${j.model}#${j.run}: agent ${ws}${scoreWs ? `, scored ${scoreWs}` : ''}`)
    else { fs.rmSync(ws, { recursive: true, force: true }); if (scoreWs) fs.rmSync(scoreWs, { recursive: true, force: true }) }
  }
}

// At most n at once, and never two runs of the same task at once: a run must not find a neighbour's finished fix or
// restored tests for its own task in the temp directory.
export async function pool<T>(items: T[], n: number, key: (x: T) => string, f: (x: T) => Promise<void>): Promise<void> {
  const pending = [...items], busy = new Set<string>(), running = new Set<Promise<void>>()
  while (pending.length || running.size) {
    const i = running.size < n ? pending.findIndex(x => !busy.has(key(x))) : -1
    if (i < 0) { await Promise.race(running); continue }
    const [x] = pending.splice(i, 1) as [T]
    busy.add(key(x))
    const p: Promise<void> = f(x).finally(() => { busy.delete(key(x)); running.delete(p) })
    running.add(p)
  }
}

// Readable, and unique: the hash of the exact tuple keeps "a/b" and "a_b" apart.
export const resultFile = (dir: string, j: { task: string; arm: string; model: string; run: number }): string =>
  path.join(dir, `${`${j.task}__${j.arm}__${j.model}__${j.run}`.replace(/[^\w.+@-]/g, '_')}.${createHash('sha1').update(JSON.stringify([j.task, j.arm, j.model, j.run])).digest('hex').slice(0, 8)}.json`)
const writeAtomic = (file: string, text: string): void => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, text); fs.renameSync(tmp, file) }

async function cmdRun(args: Args, dir: string, file: string): Promise<void> {
  const tf = loadTasks(file)
  if (!tf.testCmd) die('no test command in the task file: run chb replay check --test-cmd "<command>" first')
  let arms: Arm[] = opt(args, 'arms') ? JSON.parse(fs.readFileSync(opt(args, 'arms')!, 'utf8')) as Arm[] : DEFAULT_ARMS
  if (opt(args, 'arm')) { const want = opt(args, 'arm')!.split(','); arms = arms.filter(a => want.includes(a.name)) }
  const tare = opt(args, 'tare') ? path.resolve(opt(args, 'tare')!) : null
  if (tare && !fs.existsSync(tare)) die(`--tare ${tare} not found`)
  if (!tare && arms.some(a => a.tare)) { warn('no --tare <SKILL.md>: skipping the Tare arm(s)'); arms = arms.filter(a => !a.tare) }
  if (!arms.length) die('no arms to run')
  const tasks = tf.tasks.filter(t => t.valid === true || (flag(args, 'unchecked') && t.valid !== false))
  if (!tasks.length) die('no valid tasks: run chb replay check first (or --unchecked)')
  const models = (opt(args, 'models') ?? 'sonnet').split(',').map(s => s.trim()).filter(Boolean)
  const runs = Number(opt(args, 'runs') ?? 3)
  const outDir = path.resolve(opt(args, 'out') ?? path.join(path.dirname(file), 'results'))
  fs.mkdirSync(outDir, { recursive: true })
  const jobs: Job[] = []
  for (const task of tasks) for (const model of models) for (const arm of arms) for (let run = 1; run <= runs; run++) {
    const o = resultFile(outDir, { task: task.id, arm: arm.name, model, run })
    if (fs.existsSync(o) && !flag(args, 'force')) continue // resumable: finished runs are kept
    jobs.push({ task, arm, model, run, out: o })
  }
  const cfg: RunCfg = {
    dir, tf, tare, agentCmd: opt(args, 'agent-cmd'), permissionMode: opt(args, 'permission-mode') ?? 'bypassPermissions', budget: opt(args, 'budget'),
    agentMs: Number(opt(args, 'timeout') ?? 30) * 60_000, testMs: Number(opt(args, 'test-timeout') ?? 10) * 60_000, gates: flag(args, 'gates'), keep: flag(args, 'keep'),
  }
  const total = tasks.length * models.length * arms.length * runs
  out(`${jobs.length} run(s) to do (${total - jobs.length} already done): ${tasks.length} task(s) × ${arms.map(a => a.name).join('/')} × ${models.join('/')} × ${runs}`)
  if (flag(args, 'dry-run')) return
  let done = 0
  const infra: string[] = []
  await pool(jobs, Number(opt(args, 'jobs') ?? 2), j => j.task.id, async j => {
    let r: Result | Infra
    try { r = await runOne(j, cfg) } catch (e) { r = { infra: (e as Error).message } }
    const tag = `${j.task.id} ${j.arm.name} ${j.model} #${j.run}`
    if ('infra' in r) {
      infra.push(`${tag}: ${r.infra}`)
      fs.appendFileSync(path.join(outDir, '_infra.log'), `${new Date().toISOString()} ${tag}: ${r.infra}\n`)
      return out(`[${++done}/${jobs.length}] ${'not scored'.padEnd(11)} ${tag}: ${r.infra}`)
    }
    writeAtomic(j.out, JSON.stringify(r, null, 2) + '\n')
    out(`[${++done}/${jobs.length}] ${r.status.padEnd(11)} ${tag}${r.costUsd !== null ? ` $${r.costUsd.toFixed(2)}` : ''}`)
  })
  if (infra.length) out(`${infra.length} run(s) not scored (setup, claude, auth or rate limits: not the agent's doing). Fix the cause and rerun the same command to retry only those.`)
  out(`Results in ${outDir}. Next: chb replay report`)
}

// ---------- report ----------

const mean = (xs: number[]): number | null => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
// A small seeded generator, so the same results always print the same interval.
function rng(seed: number): () => number {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export type ArmSummary = { arm: string; model: string; tasks: number; runs: number; passRate: number; spread: [number, number]; statuses: Record<string, number>; costUsd: number | null; wallMin: number | null; turns: number | null; addedLines: number | null; crap: number | null; dry: number | null }
export type Comparison = { arm: string; baseline: string; model: string; tasks: number; delta: number; ci: [number, number]; verdict: 'better' | 'worse' | 'no detectable difference' | 'too few tasks'; costRatio: number | null }
// Below this many paired tasks a percentile bootstrap is overconfident (2 tasks at +1 give the interval [1, 1]).
export const MIN_TASKS = 10

export function summarise(results: Result[], baseline = 'bare', seed = 7): { arms: ArmSummary[]; comparisons: Comparison[] } {
  const groups = new Map<string, Result[]>()
  for (const r of results) { const k = `${r.arm}\u0000${r.model}`; groups.set(k, [...(groups.get(k) ?? []), r]) }
  const perTask = (rs: Result[]) => { const m = new Map<string, number[]>(); for (const r of rs) m.set(r.task, [...(m.get(r.task) ?? []), r.pass ? 1 : 0]); return new Map([...m].map(([k, v]) => [k, mean(v)!])) }
  const arms: ArmSummary[] = []
  for (const [k, rs] of groups) {
    const [arm, model] = k.split('\u0000') as [string, string]
    const pt = perTask(rs)
    const byRun = new Map<number, number[]>(); for (const r of rs) byRun.set(r.run, [...(byRun.get(r.run) ?? []), r.pass ? 1 : 0])
    const runRates = [...byRun.values()].map(v => mean(v)!)
    const nums = (f: (r: Result) => number | null) => mean(rs.map(f).filter((x): x is number => x !== null))
    arms.push({
      arm, model, tasks: pt.size, runs: rs.length, passRate: mean([...pt.values()])!, spread: [Math.min(...runRates), Math.max(...runRates)],
      statuses: rs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}),
      costUsd: nums(r => r.costUsd), wallMin: (nums(r => r.wallMs) ?? 0) / 60_000 || null, turns: nums(r => r.turns), addedLines: nums(r => r.diff.added),
      crap: nums(r => r.gates?.crap ?? null), dry: nums(r => r.gates?.dry ?? null),
    })
  }
  arms.sort((a, b) => a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm))
  const comparisons: Comparison[] = []
  for (const a of arms) {
    if (a.arm === baseline) continue
    const b = arms.find(x => x.arm === baseline && x.model === a.model)
    if (!b) continue
    const pa = perTask(groups.get(`${a.arm}\u0000${a.model}`)!), pb = perTask(groups.get(`${b.arm}\u0000${b.model}`)!)
    const ds = [...pa.keys()].filter(t => pb.has(t)).map(t => pa.get(t)! - pb.get(t)!)
    if (!ds.length) continue
    const r = rng(seed), boots: number[] = []
    for (let i = 0; i < 2000; i++) { let s = 0; for (let j = 0; j < ds.length; j++) s += ds[Math.floor(r() * ds.length)]!; boots.push(s / ds.length) }
    boots.sort((x, y) => x - y)
    const ci: [number, number] = [boots[Math.floor(0.025 * boots.length)]!, boots[Math.ceil(0.975 * boots.length) - 1]!]
    comparisons.push({ arm: a.arm, baseline, model: a.model, tasks: ds.length, delta: mean(ds)!, ci, verdict: ds.length < MIN_TASKS ? 'too few tasks' : ci[0] > 0 ? 'better' : ci[1] < 0 ? 'worse' : 'no detectable difference', costRatio: a.costUsd !== null && b.costUsd ? a.costUsd / b.costUsd : null })
  }
  return { arms, comparisons }
}

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`
const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`
const num = (x: number | null, d = 2): string => x === null ? '–' : x.toFixed(d)

export function renderReport(s: ReturnType<typeof summarise>, baseline: string): string {
  const L = ['# Replay report', '', '| Arm | Model | Tasks | Runs | Pass rate | Spread across runs | Cost / run ($) | Minutes / run | Turns | Lines added | CRAP blocks | Dup blocks | Statuses |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const a of s.arms) L.push(`| ${a.arm} | ${a.model} | ${a.tasks} | ${a.runs} | ${pct(a.passRate)} | ${pct(a.spread[0])}–${pct(a.spread[1])} | ${num(a.costUsd)} | ${num(a.wallMin, 1)} | ${num(a.turns, 0)} | ${num(a.addedLines, 0)} | ${num(a.crap, 1)} | ${num(a.dry, 1)} | ${Object.entries(a.statuses).map(([k, v]) => `${k} ${v}`).join(', ')} |`)
  L.push('', `## Against ${baseline} (paired by task, 95% bootstrap interval)`, '')
  if (!s.comparisons.length) L.push(`No comparison: no ${baseline} results for the same model.`)
  else {
    L.push('| Arm | Model | Tasks | Difference (points) | 95% interval | Verdict | Cost ratio |', '| --- | --- | --- | --- | --- | --- | --- |')
    for (const c of s.comparisons) L.push(`| ${c.arm} | ${c.model} | ${c.tasks} | ${pp(c.delta)} | ${pp(c.ci[0])} to ${pp(c.ci[1])} | ${c.verdict} | ${c.costRatio === null ? '–' : `${c.costRatio.toFixed(1)}×`} |`)
  }
  L.push('', 'An interval that includes 0 is not a result: add tasks or runs before acting on it.')
  if (s.comparisons.some(c => c.verdict === 'too few tasks')) L.push('', `Verdicts need at least ${MIN_TASKS} tasks valid for both arms; below that the interval is shown but not judged.`)
  const kill = s.comparisons.filter(c => c.arm === 'rig+tare' && c.baseline === 'bare' && (c.verdict === 'no detectable difference' || c.verdict === 'worse'))
  if (kill.length) L.push('', `**Kill rule:** rig+tare is not better than bare on ${kill.map(c => c.model).join(', ')}. Cut to whichever arm wins and re-plan before phases 2–4.`)
  return L.join('\n')
}

export function readResults(dir: string): Result[] {
  const outp: Result[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.json')) { try { const r = JSON.parse(fs.readFileSync(p, 'utf8')) as Result; if (r.task && r.arm && typeof r.pass === 'boolean') outp.push(r) } catch { /* not a result */ } }
  } }
  if (fs.existsSync(dir)) walk(dir)
  return outp
}

function cmdReport(args: Args, file: string): void {
  const dir = path.resolve(opt(args, 'results') ?? path.join(path.dirname(file), 'results'))
  let results = readResults(dir)
  if (!results.length) die(`no results in ${dir}: run chb replay run first`)
  // Results for tasks since removed or found invalid do not count, unless --all.
  if (fs.existsSync(file) && !flag(args, 'all')) { const ok = new Set(loadTasks(file).tasks.filter(t => t.valid === true).map(t => t.id)); results = results.filter(r => ok.has(r.task)) }
  if (!results.length) die('no results for tasks that are valid in the task file (--all includes the rest)')
  const baseline = opt(args, 'baseline') ?? 'bare'
  const s = summarise(results, baseline)
  out(flag(args, 'json') ? JSON.stringify(s, null, 2) : renderReport(s, baseline))
}

// ---------- entry ----------

export function cmdReplay(args: Args): void {
  const sub = args.pos[0]
  const dir = path.resolve(opt(args, 'repo-dir') ?? process.cwd())
  const file = path.resolve(dir, opt(args, 'tasks') ?? 'replay/tasks.json')
  if (sub !== 'report' && git(['rev-parse', '--git-dir'], dir) === null) die(`${dir} is not a git clone: pass --repo-dir <clone>`)
  const fail = (e: unknown) => die(`chb replay ${sub}: ${(e as Error).message}`, 2)
  if (sub === 'build') return cmdBuild(args, dir, file)
  if (sub === 'check') { cmdCheck(args, dir, file).catch(fail); return }
  if (sub === 'run') { cmdRun(args, dir, file).catch(fail); return }
  if (sub === 'report') return cmdReport(args, file)
  die('usage: chb replay <build|check|run|report> … (chb help)')
}
