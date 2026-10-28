// `chb coordinate`: run one repo's queue across cloud sessions (Masterstock improvement plan, phase 4).
//
// rig decides WHAT may start, and this follows rig's rules rather than restating them:
//   - ready: `sdlc.ts ready --json`, run in a temporary worktree of the base branch (rig reads "already started" from
//     the working tree, so a stale checkout would re-plan shipped work);
//   - autonomy: `.rig/autonomy.json` rung 0–3 (anything else reads as 0, as rig does): rung 0 starts nothing, rung 1
//     starts plans (it stops at approval), rung 2+ also starts builds (a build session opens the PR); deferred go last;
//   - approval: approval.json's hashes must match the branch's spec, plan and requirements, as rig's approvalState checks;
//     with CHB_AUTO_BUILD=tier0 and rig's plan gate off on the base, an unapproved change that autobuild.ts judges tier 0
//     is built too (see there); every other one still waits for /rig:approve;
//   - shipped: the base has `.rig/changes/<slug>/pr.md` (rig's isShipped), or the branch is merged by any method.
// rig's own queue keeps one writer per file across LOCAL worktrees; cloud sessions push sdlc/<slug> branches instead,
// so in-flight work is read from the remote. Every unshipped origin/sdlc/* branch claims its intent's `scope:` and
// `touches:`, its spec's `## Blast radius`, its plan's `## Files` and its actual diff; a plan dispatched recently whose
// branch has not appeared holds its intent's scope. Limits: a work-in-progress cap, two build sessions and two plan
// sessions per change, no second build while one is still running, one coordinator run at a time per repo.
// Dry by default; --go starts the sessions through `chb dispatch`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { type Args, flag, opt, out, warn, die } from './cli.ts'
import { git, defaultBase } from './git.ts'
import { repoKey, MAX_BUILDS } from './dispatch.ts'
import { globToRe } from './tare.ts'
import { fmList, sectionPaths, approvalOf, type Approval } from './rig.ts'
import { autoBuildOn, planGateOff, judgeAuto, type Auto } from './autobuild.ts'

export type Ready = { slug: string; sprint: number; estimateDays?: number | null }
// auto: the tier-0 verdict for an unapproved change, when auto-build is on and rig's plan gate is off; else absent.
export type Flight = { slug: string; branch: string | null; claims: string[]; approval: Approval; proofPass: boolean; builds: number; buildRunning: boolean; auto?: Auto }
export type Pick = { kind: 'plan' | 'build'; slug: string; intent?: string; why: string }
export type Skip = { slug: string; why: string }
const maxPlans = Number(process.env.CHB_MAX_PLANS)
export const MAX_PLANS = Number.isInteger(maxPlans) && maxPlans > 0 ? maxPlans : 2

// ---------- rig's formats (in rig.ts, shared with the auto-build policy) ----------

export { fmList, sectionPaths, approvalOf } from './rig.ts'
export const intentPath = (r: Ready): string => `.rig/product/sprints/sprint-${r.sprint}/intents/${r.slug}.md`

// ---------- overlap ----------

const GLOB = /[*?[{]/
const normal = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
// The literal folder a glob lives under: `src/api/**` → `src/api/`.
const stem = (g: string): string => { const i = g.search(GLOB); return i < 0 ? `${g}/` : g.slice(0, g.lastIndexOf('/', i) + 1) }
const simpleGlob = (g: string): boolean => !/[[{]/.test(g) // braces and classes: judged by stem only, conservatively

// Could a write to `a` and a write to `b` touch the same file? A plain path also means the folder under it (rig's
// scope rule). Case-insensitive, so it errs towards "yes" on case-insensitive disks. Unsure means yes.
export function overlaps(a0: string, b0: string): boolean {
  const a = normal(a0), b = normal(b0)
  if (!a || !b) return false
  if (a === b) return true
  const ga = GLOB.test(a), gb = GLOB.test(b)
  if (!ga && !gb) return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
  if (ga && gb) { const sa = stem(a), sb = stem(b); return sa.startsWith(sb) || sb.startsWith(sa) }
  const [g, p] = ga ? [a, b] : [b, a]
  if (!simpleGlob(g)) return p.startsWith(stem(g)) || stem(g).startsWith(`${p}/`)
  return globToRe(g).test(p) || stem(g).startsWith(`${p}/`) // a folder that holds the glob's files
}

// ---------- the queue ----------

export type ChooseOpts = { wip: number; deferred: string[]; maxBuilds: number; maxPlans: number; rung: number; plansSoFar: (slug: string) => number }

export function choose(ready: Ready[], flights: Flight[], writes: Map<string, string[]>, o: ChooseOpts): { picks: Pick[]; skipped: Skip[] } {
  const picks: Pick[] = [], skipped: Skip[] = []
  // Builds first: an approved change waiting for code is further along than a new plan, and holds its claims already.
  for (const f of flights) {
    if (f.proofPass) continue
    if (f.approval === 'missing') {
      if (!f.auto) continue // waiting for /rig:approve, as every unapproved change does without auto-build
      if (!f.auto.ok) { skipped.push({ slug: f.slug, why: `not tier 0, so it waits for /rig:approve: ${f.auto.why.join('; ')}` }); continue }
    }
    if (f.approval === 'stale') { skipped.push({ slug: f.slug, why: 'its approval is stale (spec or plan changed since): a person re-approves' }); continue }
    if (o.rung < 2) { skipped.push({ slug: f.slug, why: `approved, but rung ${o.rung}: builds start at rung 2 (a build session opens the PR)` }); continue }
    if (f.buildRunning) { skipped.push({ slug: f.slug, why: 'a build session was started after its last commit and may still be running' }); continue }
    if (f.builds >= o.maxBuilds) { skipped.push({ slug: f.slug, why: `${f.builds} build session(s) already: it needs a person` }); continue }
    picks.push({ kind: 'build', slug: f.slug, why: `${f.approval === 'approved' ? 'approved' : "tier 0 with rig's plan gate off (no person approved it)"}, no passing proof, build session ${f.builds + 1} of ${o.maxBuilds}` })
  }
  let inFlight = flights.length
  const claimed: { path: string; by: string }[] = flights.flatMap(f => f.claims.map(p => ({ path: p, by: f.slug })))
  const flying = new Set(flights.map(f => f.slug))
  const order = [...ready].sort((x, y) => Number(o.deferred.includes(x.slug)) - Number(o.deferred.includes(y.slug)) || x.sprint - y.sprint)
  for (const r of order) {
    if (flying.has(r.slug)) continue // its branch, or its dispatched plan, is in flight already
    if (o.rung < 1) { skipped.push({ slug: r.slug, why: 'rung 0: a person starts each intent' }); continue }
    const tries = o.plansSoFar(r.slug)
    if (tries >= o.maxPlans) { skipped.push({ slug: r.slug, why: `${tries} plan session(s) already and it is ready again (closed or abandoned?): it needs a person` }); continue }
    if (inFlight >= o.wip) { skipped.push({ slug: r.slug, why: `work in progress is at the limit (${o.wip})` }); continue }
    const scope = writes.get(r.slug) ?? []
    if (!scope.length) {
      // No declared scope: nothing can show it is safe beside other work, so it only starts alone.
      if (inFlight > 0) { skipped.push({ slug: r.slug, why: 'its intent declares no scope: it starts only when nothing else is in flight' }); continue }
      picks.push({ kind: 'plan', slug: r.slug, intent: intentPath(r), why: 'ready; no scope, so it runs alone' })
      inFlight = o.wip
      continue
    }
    const hit = scope.flatMap(s => claimed.filter(c => overlaps(s, c.path)).map(c => `${s} ↔ ${c.path} (${c.by})`))
    if (hit.length) { skipped.push({ slug: r.slug, why: `one writer per file: ${hit.slice(0, 3).join('; ')}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''}` }); continue }
    picks.push({ kind: 'plan', slug: r.slug, intent: intentPath(r), why: `ready; writes ${scope.join(', ')}` })
    claimed.push(...scope.map(p => ({ path: p, by: r.slug })))
    inFlight++
  }
  return { picks, skipped }
}

// ---------- the dispatch log ----------

type LogRow = { at?: string; kind?: string; slug?: string; repo?: string; dir?: string }
export function readLog(log: string): LogRow[] {
  if (!fs.existsSync(log)) return []
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as LogRow] } catch { return [] } })
}
const mine = (rows: LogRow[], kind: string, repo: string, slug?: string) => rows.filter(r => r.kind === kind && (r.repo ?? r.dir) === repo && (!slug || r.slug === slug))

// Plans dispatched in the last `hours` whose branch has not appeared yet: their sessions are still writing the plan.
export function pendingPlans(log: string, repo: string, hours: number, now = Date.now()): { slug: string; at: string }[] {
  return mine(readLog(log), 'plan', repo).filter(r => r.slug && r.at && now - Date.parse(r.at) < hours * 3_600_000).map(r => ({ slug: r.slug!, at: r.at! }))
}

// ---------- reading the repo ----------

const show = (dir: string, ref: string, f: string): string => git(['show', `${ref}:${f}`], dir) ?? ''

export function shippedOn(dir: string, base: string): Set<string> {
  return new Set((git(['ls-tree', '-r', '--name-only', base, '--', '.rig/changes'], dir) ?? '').split('\n').filter(f => f.endsWith('/pr.md')).map(f => f.split('/')[2] ?? ''))
}

// Merged by any method: an ancestor (merge commit, fast-forward), or every commit already on base (rebase, cherry-pick).
function merged(dir: string, branch: string, base: string): boolean {
  if (git(['merge-base', '--is-ancestor', branch, base], dir) !== null) return true
  const cherry = git(['cherry', base, branch], dir)
  return cherry !== null && cherry.trim() !== '' && cherry.trim().split('\n').every(l => l.startsWith('-'))
}

export function inFlight(dir: string, base: string, log: string, pendingHours: number, holdHours: number, now = Date.now()): Flight[] {
  const repo = repoKey(dir), rows = readLog(log), shipped = shippedOn(dir, base)
  const intents = (ref: string) => (git(['ls-tree', '-r', '--name-only', ref, '--', '.rig/product/sprints/'], dir) ?? '').split('\n')
  const writesOf = (text: string) => [...fmList(text, 'scope'), ...fmList(text, 'touches')]
  const onRemote = (git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/sdlc/'], dir) ?? '').split('\n').filter(Boolean).flatMap((branch): Flight[] => {
    const slug = branch.replace(/^origin\/sdlc\//, '')
    if (shipped.has(slug) || merged(dir, branch, base)) return []
    const intentFile = intents(branch).find(f => f.endsWith(`/intents/${slug}.md`))
    const ch = `.rig/changes/${slug}`
    const mb = git(['merge-base', base, branch], dir)?.trim()
    const diff = mb ? (git(['diff', '--name-only', mb, branch], dir) ?? '').split('\n').filter(f => f && !/^\.rig\//.test(f)) : []
    const files = Object.fromEntries(['spec.md', 'plan.md', 'requirements.md'].map(n => [n, show(dir, branch, `${ch}/${n}`)]))
    const claims = [...new Set([...(intentFile ? writesOf(show(dir, branch, intentFile)) : []), ...sectionPaths(files['spec.md']!, 'Blast radius'), ...sectionPaths(files['plan.md']!, 'Files'), ...diff])].sort()
    let proofPass = false
    try { proofPass = (JSON.parse(show(dir, branch, `${ch}/proof.json`) || '{}') as { pass?: boolean }).pass === true } catch { /* no proof */ }
    const builds = mine(rows, 'build', repo, slug)
    const lastCommit = Date.parse(git(['log', '-1', '--format=%cI', branch], dir)?.trim() ?? '') || 0
    const lastBuild = Math.max(0, ...builds.map(b => Date.parse(b.at ?? '') || 0))
    return [{ slug, branch, claims, approval: approvalOf(files, show(dir, branch, `${ch}/approval.json`)), proofPass, builds: builds.length, buildRunning: lastBuild > lastCommit && now - lastBuild < holdHours * 3_600_000 }]
  })
  // A plan session that has not pushed yet still holds its intent's scope.
  const known = new Set(onRemote.map(f => f.slug))
  const baseIntents = intents(base)
  const pending = [...new Map(pendingPlans(log, repo, pendingHours, now).filter(p => !known.has(p.slug) && !shipped.has(p.slug)).map(p => [p.slug, p])).values()]
  return [...onRemote, ...pending.map(p => { const f = baseIntents.find(x => x.endsWith(`/intents/${p.slug}.md`)); return { slug: p.slug, branch: null, claims: f ? writesOf(show(dir, base, f)) : [], approval: 'missing' as const, proofPass: false, builds: 0, buildRunning: false } })]
}

// rig's `ready`, judged on the base branch as it is on the remote (not this checkout's working tree).
function readyOnBase(dir: string, base: string): Ready[] {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-coord-'))
  try {
    if (git(['worktree', 'add', '-q', '--detach', wt, base], dir) === null) throw new Error(`could not check out ${base} in a temporary worktree`)
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(wt, '.rig/bin/sdlc.ts'), 'ready', '--json'], { cwd: wt, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: wt } })
    if (r.status !== 0) throw new Error(`\`sdlc.ts ready --json\` failed on ${base}: ${(r.stderr || r.stdout).trim().split('\n').pop()} (is rig up to date there? /rig:upgrade)`)
    try { return JSON.parse(r.stdout) as Ready[] } catch { throw new Error(`\`sdlc.ts ready --json\` printed something that is not JSON: ${r.stdout.trim().slice(0, 120)}`) }
  } finally {
    git(['worktree', 'remove', '--force', wt], dir)
    fs.rmSync(wt, { recursive: true, force: true })
  }
}

// One run at a time per repo: an hourly run that overlaps a slow one would choose against stale claims.
function lock(home: string, repo: string): (() => void) | string {
  fs.mkdirSync(home, { recursive: true })
  const f = path.join(home, `coordinate-${createHash('sha1').update(repo).digest('hex').slice(0, 12)}.lock`)
  try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }) } catch {
    const pid = Number(fs.readFileSync(f, 'utf8'))
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* gone */ }
    if (alive && Date.now() - fs.statSync(f).mtimeMs < 2 * 3_600_000) return `another coordinate run (pid ${pid}) is working on this repo`
    fs.writeFileSync(f, String(process.pid))
  }
  return () => { try { fs.rmSync(f) } catch { /* fine */ } }
}

const positive = (v: string | undefined, d: number, name: string): number => { const n = Number(v ?? d); if (!Number.isFinite(n) || n <= 0) die(`--${name} must be a positive number`); return n }

export function cmdCoordinate(args: Args): void {
  const dir = path.resolve(opt(args, 'repo-dir') ?? process.cwd())
  if (!fs.existsSync(path.join(dir, '.rig/bin/sdlc.ts'))) die(`${dir} is not a rig repo (no .rig/bin/sdlc.ts): pass --repo-dir <clone>`)
  const go = flag(args, 'go')
  if (!flag(args, 'no-fetch') && git(['fetch', '-q', '--prune', 'origin'], dir) === null) {
    if (go) die('git fetch origin failed: not starting sessions from stale branches', 2)
    warn('git fetch origin failed: judging from the last fetch')
  }
  let base = opt(args, 'base') ?? defaultBase(dir)
  // origin/HEAD can point at a change branch; judging against it would hide every flight.
  if (!opt(args, 'base') && base && /(^|\/)sdlc\//.test(base)) base = ['origin/main', 'origin/master'].find(b => git(['rev-parse', '--verify', '-q', b], dir) !== null) ?? null
  if (!base || /(^|\/)sdlc\//.test(base)) die('no base branch (or it is a change branch): pass --base origin/main', 2)
  const wip = positive(opt(args, 'wip'), 4, 'wip')
  if (!Number.isInteger(wip)) die('--wip is a whole number of changes')
  const pendingHours = positive(opt(args, 'pending-hours'), 6, 'pending-hours'), holdHours = positive(opt(args, 'build-hold-hours'), 6, 'build-hold-hours')
  const home = process.env.CHB_HOME ?? path.join(os.homedir(), '.chb'), log = path.join(home, 'dispatch.jsonl')
  const repo = repoKey(dir)
  const unlock = lock(home, repo)
  if (typeof unlock === 'string') { out(`coordinate ${path.basename(dir)}: ${unlock}; nothing done`); return }
  try {
    let ready: Ready[]
    try { ready = readyOnBase(dir, base) } catch (e) { return die((e as Error).message, 2) }
    // Belt and braces: anything with a change folder on the base has started.
    const started = new Set((git(['ls-tree', '-d', '--name-only', `${base}:.rig/changes`], dir) ?? '').split('\n').filter(Boolean))
    ready = ready.filter(r => !started.has(r.slug))
    let autonomy: { rung?: unknown; deferred?: unknown } = {}
    const autoText = show(dir, base, '.rig/autonomy.json')
    try { autonomy = JSON.parse(autoText || '{}') as typeof autonomy } catch { /* malformed: rung 0 */ }
    const rung = [0, 1, 2, 3].includes(autonomy.rung as number) ? autonomy.rung as number : 0
    const deferred = Array.isArray(autonomy.deferred) ? autonomy.deferred.filter((d): d is string => typeof d === 'string') : []
    const flights = inFlight(dir, base, log, pendingHours, holdHours)
    let auto = false
    try { auto = autoBuildOn() } catch (e) { return die((e as Error).message) }
    const gateOff = planGateOff(show(dir, base, '.rig/sensors.json'))
    if (auto && gateOff && rung >= 2) for (const f of flights) if (f.branch && f.approval === 'missing' && !f.proofPass) f.auto = judgeAuto(dir, base, f.branch, f.slug)
    const writes = new Map(ready.map(r => { const t = show(dir, base, intentPath(r)); return [r.slug, [...fmList(t, 'scope'), ...fmList(t, 'touches')]] }))
    const rows = readLog(log)
    const { picks, skipped } = choose(ready, flights, writes, { wip, deferred, maxBuilds: MAX_BUILDS, maxPlans: MAX_PLANS, rung, plansSoFar: s => mine(rows, 'plan', repo, s).length })

    if (flag(args, 'json')) return out(JSON.stringify({ base, rung, wip, flights, picks, skipped }, null, 2))
    const L = [`coordinate ${path.basename(dir)} against ${base}: ${flights.length} in flight, ${ready.length} ready, work-in-progress limit ${wip}, autonomy rung ${rung}${autoText && rung === 0 && autonomy.rung !== 0 ? ' (.rig/autonomy.json unreadable or out of range: read as 0, as rig does)' : ''}`]
    for (const f of flights) L.push(`  flight  ${f.slug}${f.branch ? '' : ' (plan dispatched, no branch yet)'}${f.approval !== 'missing' ? ` (${f.approval})` : f.auto ? ` (${f.auto.ok ? 'tier 0' : 'waits for a person'})` : ''}${f.proofPass ? ' (proof passes)' : ''}: claims ${f.claims.length ? f.claims.slice(0, 4).join(', ') + (f.claims.length > 4 ? ` +${f.claims.length - 4}` : '') : 'nothing declared'}`)
    for (const p of picks) L.push(`  start   ${p.kind} ${p.slug}: ${p.why}`)
    for (const s of skipped) L.push(`  wait    ${s.slug}: ${s.why}`)
    if (auto && !gateOff) L.push(`  note    CHB_AUTO_BUILD=tier0, but rig's plan gate is on in ${base}: every build waits for /rig:approve`)
    if (!auto && gateOff) L.push("  note    rig's plan gate is off, but CHB_AUTO_BUILD is not tier0: unapproved changes wait for /rig:approve")
    L.push('  note    not judged here: tests, test fixtures and repo-root config (package.json, lockfiles) that two changes may both edit; rig\'s merge checks catch those')
    out(L.join('\n'))
    if (!go) return out('dry run: pass --go to start these sessions')
    // --emit <file>: record the picks as dispatched and write them as a job list, for a runner (GitHub Actions) that
    // starts each in its own job with `chb dispatch <kind> <arg> --local --go --no-log`.
    const emit = opt(args, 'emit')
    if (emit) {
      const jobs = picks.map(p => ({ kind: p.kind, arg: p.kind === 'plan' ? p.intent! : p.slug, slug: p.slug }))
      fs.mkdirSync(path.dirname(log), { recursive: true })
      for (const j of jobs) fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), kind: j.kind, slug: j.slug, repo, dir, via: 'emit' }) + '\n')
      fs.writeFileSync(emit, JSON.stringify(jobs) + '\n')
      return out(`emitted ${jobs.length} job(s) to ${emit}`)
    }
    let failed = 0
    for (const p of picks) {
      const argv = [process.execPath, '--disable-warning=ExperimentalWarning', process.argv[1]!, 'dispatch', p.kind, p.kind === 'plan' ? p.intent! : p.slug, '--repo-dir', dir, '--go', ...(flag(args, 'local') ? ['--local'] : [])]
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (r.status !== 0) failed++
      out(`${r.status === 0 ? 'started' : 'FAILED '} ${p.kind} ${p.slug}${r.status === 0 ? '' : `: ${(r.stderr || r.stdout).trim().split('\n').pop()}`}`)
    }
    process.exitCode = failed ? 1 : 0
  } finally { unlock() }
}
