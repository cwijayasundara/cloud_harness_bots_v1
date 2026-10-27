// `chb coordinate`: run one repo's queue across cloud sessions (Masterstock improvement plan, phase 4).
//
// rig decides WHAT may start: `sdlc.ts ready` lists intents whose sprint chart is approved and whose dependencies have
// shipped, `.rig/autonomy.json` says whether the model may start work at all (rung 0: a person starts each intent) and
// which intents are deferred, and rig's own queue keeps one writer per file across LOCAL worktrees. Cloud sessions make
// no local worktrees: each pushes an sdlc/<slug> branch. So this reads the in-flight work from the remote instead:
// every unmerged origin/sdlc/* branch claims the files of its intent's `scope:`, its spec's `## Blast radius`, its
// plan's `## Files` and its actual diff. Then, under a work-in-progress limit, it picks ready intents whose scope
// touches nothing claimed (one writer per file), and approved changes that need a build session, and starts them.
// Deterministic and dry by default: it prints the plan; --go starts the sessions through `chb dispatch`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Args, flag, opt, out, warn, die } from './cli.ts'
import { git, defaultBase } from './git.ts'
import { buildsSoFar, repoKey, MAX_BUILDS } from './dispatch.ts'
import { globToRe } from './tare.ts'

export type Ready = { slug: string; sprint: number; estimateDays?: number | null }
export type Flight = { slug: string; branch: string | null; claims: string[]; approved: boolean; proofPass: boolean; builds: number }
export type Pick = { kind: 'plan' | 'build'; slug: string; intent?: string; why: string }
export type Skip = { slug: string; why: string }

// ---------- reading rig's formats ----------

// A frontmatter list in rig's three forms: `key: [a, b]`, `key: a`, and `key:` then `  - a` lines.
export function fmList(text: string, key: string): string[] {
  const rows = (/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').split('\n')
  const at = rows.findIndex(r => new RegExp(`^${key}:`).test(r))
  if (at < 0) return []
  const tidy = (s: string) => s.trim().replace(/^["']|["']$/g, '').replace(/^\.\//, '')
  const inline = rows[at]!.slice(key.length + 1).replace(/\s+#.*$/, '').trim()
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(tidy).filter(Boolean)
  const outp: string[] = []
  for (const r of rows.slice(at + 1)) { if (!/^\s+-\s*\S/.test(r)) break; outp.push(tidy(r.replace(/^\s+-\s*/, '').replace(/\s+#.*$/, ''))) }
  return outp.filter(Boolean)
}

// Bullet paths under a `## <heading>` section, as rig's bulletPaths reads them.
export function sectionPaths(text: string, heading: string): string[] {
  const body = text.split(new RegExp(`^##\\s+${heading}[ \\t]*$`, 'm'))[1]?.split(/^## /m)[0] ?? ''
  return body.split('\n').flatMap(l => {
    const m = /^\s*(?:[-*]\s+)?(?:[A-Za-z]+:\s+)?(?:`([^`\s]+)`|([^`\s]+))/.exec(l)
    return m?.[1] ? [m[1]] : m?.[2] && /\/|\.\w+$/.test(m[2]) ? [m[2]] : []
  }).map(p => p.replace(/^\.\//, ''))
}

export const intentPath = (r: Ready): string => `.rig/product/sprints/sprint-${r.sprint}/intents/${r.slug}.md`

// ---------- overlap ----------

const isPattern = (p: string): boolean => /[*?]/.test(p) || p.endsWith('/')
// The literal folder a path or glob lives under: `src/api/**` → `src/api/`, `src/api/x.ts` → itself.
const stem = (p: string): string => { const i = p.search(/[*?]/); return i < 0 ? p : p.slice(0, p.lastIndexOf('/', i) + 1) }

// Could a write to `a` and a write to `b` touch the same file? Paths compare exactly; a glob or folder against a path by
// matching; two globs or folders by whether one's literal folder contains the other's (conservative: unsure means yes).
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true
  const pa = isPattern(a), pb = isPattern(b)
  if (!pa && !pb) return false
  if (pa && !pb) return globToRe(a).test(b)
  if (!pa && pb) return globToRe(b).test(a)
  const sa = stem(a), sb = stem(b)
  return sa.startsWith(sb) || sb.startsWith(sa)
}

// ---------- the queue ----------

export function choose(ready: Ready[], flights: Flight[], scopes: Map<string, string[]>, opts: { wip: number; deferred: string[]; maxBuilds: number }): { picks: Pick[]; skipped: Skip[] } {
  const picks: Pick[] = [], skipped: Skip[] = []
  // Builds first: an approved change waiting for code is further along than a new plan, and holds its claims already.
  for (const f of flights) {
    if (!f.approved || f.proofPass) continue
    if (f.builds >= opts.maxBuilds) { skipped.push({ slug: f.slug, why: `${f.builds} build session(s) already: it needs a person` }); continue }
    picks.push({ kind: 'build', slug: f.slug, why: `approved, no passing proof, build session ${f.builds + 1} of ${opts.maxBuilds}` })
  }
  let inFlight = flights.length
  const claimed: { path: string; by: string }[] = flights.flatMap(f => f.claims.map(p => ({ path: p, by: f.slug })))
  const flying = new Set(flights.map(f => f.slug))
  const order = [...ready].sort((x, y) => Number(opts.deferred.includes(x.slug)) - Number(opts.deferred.includes(y.slug)) || x.sprint - y.sprint)
  for (const r of order) {
    if (flying.has(r.slug)) continue // its branch is in flight already
    if (inFlight >= opts.wip) { skipped.push({ slug: r.slug, why: `work in progress is at the limit (${opts.wip})` }); continue }
    const scope = scopes.get(r.slug) ?? []
    if (!scope.length) {
      // No declared scope: nothing can show it is safe beside other work, so it only starts alone.
      if (inFlight > 0) { skipped.push({ slug: r.slug, why: 'its intent declares no scope: it starts only when nothing else is in flight' }); continue }
      picks.push({ kind: 'plan', slug: r.slug, intent: intentPath(r), why: 'ready; no scope, so it runs alone' })
      inFlight = opts.wip // alone means alone
      continue
    }
    const hit = scope.flatMap(s => claimed.filter(c => overlaps(s, c.path)).map(c => `${s} ↔ ${c.path} (${c.by})`))
    if (hit.length) { skipped.push({ slug: r.slug, why: `one writer per file: ${hit.slice(0, 3).join('; ')}${hit.length > 3 ? ` and ${hit.length - 3} more` : ''}` }); continue }
    picks.push({ kind: 'plan', slug: r.slug, intent: intentPath(r), why: `ready; scope ${scope.join(', ')}` })
    claimed.push(...scope.map(p => ({ path: p, by: r.slug })))
    inFlight++
  }
  return { picks, skipped }
}

// ---------- reading the repo ----------

const show = (dir: string, ref: string, f: string): string => git(['show', `${ref}:${f}`], dir) ?? ''

// Plans dispatched in the last `hours` whose branch has not appeared yet: their sessions are still writing the plan.
export function pendingPlans(log: string, repo: string, hours: number, now = Date.now()): { slug: string; at: string }[] {
  if (!fs.existsSync(log)) return []
  const rows = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as { at?: string; kind?: string; slug?: string; repo?: string }] } catch { return [] } })
  return rows.filter(r => r.kind === 'plan' && r.slug && r.repo === repo && r.at && now - Date.parse(r.at) < hours * 3_600_000).map(r => ({ slug: r.slug!, at: r.at! }))
}

export function inFlight(dir: string, base: string, log: string, pendingHours = 6): Flight[] {
  const repo = repoKey(dir)
  const onRemote = (git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/sdlc/'], dir) ?? '').split('\n').filter(Boolean).flatMap(branch => {
    if (git(['merge-base', '--is-ancestor', branch, base], dir) !== null) return [] // merged: not in flight
    const slug = branch.replace(/^origin\/sdlc\//, '')
    const intentFile = (git(['ls-tree', '-r', '--name-only', branch, '.rig/product/sprints/'], dir) ?? '').split('\n').find(f => f.endsWith(`/intents/${slug}.md`))
    const ch = `.rig/changes/${slug}`
    const mb = git(['merge-base', base, branch], dir)?.trim()
    const diff = mb ? (git(['diff', '--name-only', mb, branch], dir) ?? '').split('\n').filter(f => f && !/^\.rig\//.test(f)) : []
    const claims = [...new Set([
      ...(intentFile ? fmList(show(dir, branch, intentFile), 'scope') : []),
      ...sectionPaths(show(dir, branch, `${ch}/spec.md`), 'Blast radius'),
      ...sectionPaths(show(dir, branch, `${ch}/plan.md`), 'Files'),
      ...diff,
    ])].sort()
    let proofPass = false
    try { proofPass = (JSON.parse(show(dir, branch, `${ch}/proof.json`) || '{}') as { pass?: boolean }).pass === true } catch { /* no proof */ }
    return [{ slug, branch, claims, approved: show(dir, branch, `${ch}/approval.json`) !== '', proofPass, builds: buildsSoFar(log, slug, repo) }]
  })
  // A plan session that has not pushed yet still holds its intent's scope.
  const known = new Set(onRemote.map(f => f.slug))
  const merged = (slug: string) => git(['log', '-1', '--format=%H', base, '--', `.rig/changes/${slug}`], dir)?.trim()
  const pending = pendingPlans(log, repo, pendingHours).filter(p => !known.has(p.slug) && !merged(p.slug))
  const intentOf = (slug: string) => (git(['ls-tree', '-r', '--name-only', base, '.rig/product/sprints/'], dir) ?? '').split('\n').find(f => f.endsWith(`/intents/${slug}.md`))
  return [...onRemote, ...[...new Map(pending.map(p => [p.slug, p])).values()].map(p => { const f = intentOf(p.slug); return { slug: p.slug, branch: null, claims: f ? fmList(show(dir, base, f), 'scope') : [], approved: false, proofPass: false, builds: 0 } })]
}

function sdlc(dir: string, args: string[]): string | null {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(dir, '.rig/bin/sdlc.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } })
  return r.status === 0 ? r.stdout : null
}

export function cmdCoordinate(args: Args): void {
  const dir = path.resolve(opt(args, 'repo-dir') ?? process.cwd())
  if (!fs.existsSync(path.join(dir, '.rig/bin/sdlc.ts'))) die(`${dir} is not a rig repo (no .rig/bin/sdlc.ts): pass --repo-dir <clone>`)
  if (!flag(args, 'no-fetch') && git(['fetch', '-q', '--prune', 'origin'], dir) === null) warn('git fetch origin failed: judging from the last fetch')
  const base = opt(args, 'base') ?? defaultBase(dir)
  if (!base) die('no base branch: pass --base origin/main', 2)
  const readyText = sdlc(dir, ['ready', '--json'])
  if (readyText === null) die('`sdlc.ts ready --json` failed: is rig up to date in this repo? (/rig:upgrade)', 2)
  const ready = JSON.parse(readyText) as Ready[]
  let autonomy: { rung?: number; deferred?: string[] } = {}
  try { autonomy = JSON.parse(fs.readFileSync(path.join(dir, '.rig/autonomy.json'), 'utf8')) as typeof autonomy } catch { /* rung 0 */ }
  const rung = autonomy.rung ?? 0
  const log = path.join(process.env.CHB_HOME ?? path.join(os.homedir(), '.chb'), 'dispatch.jsonl')
  const flights = inFlight(dir, base, log, Number(opt(args, 'pending-hours') ?? 6))
  const scopes = new Map(ready.map(r => [r.slug, fmList(show(dir, base, intentPath(r)) || (() => { try { return fs.readFileSync(path.join(dir, intentPath(r)), 'utf8') } catch { return '' } })(), 'scope')]))
  const wip = Number(opt(args, 'wip') ?? 4)
  if (!Number.isInteger(wip) || wip < 1) die('--wip is a whole number of changes, at least 1')
  const { picks, skipped } = choose(ready, flights, scopes, { wip, deferred: autonomy.deferred ?? [], maxBuilds: MAX_BUILDS })

  const L = [`coordinate ${path.basename(dir)}: ${flights.length} in flight, ${ready.length} ready, work-in-progress limit ${wip}, autonomy rung ${rung}`]
  for (const f of flights) L.push(`  flight  ${f.slug}${f.branch ? '' : ' (plan dispatched, no branch yet)'}${f.approved ? ' (approved)' : ''}${f.proofPass ? ' (proof passes)' : ''}: claims ${f.claims.length ? f.claims.slice(0, 4).join(', ') + (f.claims.length > 4 ? ` +${f.claims.length - 4}` : '') : 'nothing yet'}`)
  for (const p of picks) L.push(`  start   ${p.kind} ${p.slug}: ${p.why}`)
  for (const s of skipped) L.push(`  wait    ${s.slug}: ${s.why}`)
  const plans = picks.filter(p => p.kind === 'plan')
  if (plans.length && rung < 1) L.push(`  note    rung 0: a person starts each intent, so plans are listed, not started (/rig:autonomy to raise it)`)
  if (flag(args, 'json')) return out(JSON.stringify({ base, rung, wip, flights, picks, skipped }, null, 2))
  out(L.join('\n'))
  if (!flag(args, 'go')) return out('dry run: pass --go to start these sessions')

  const startable = picks.filter(p => p.kind === 'build' || rung >= 1)
  let failed = 0
  for (const p of startable) {
    const argv = [process.execPath, '--disable-warning=ExperimentalWarning', process.argv[1]!, 'dispatch', p.kind, p.kind === 'plan' ? p.intent! : p.slug, '--repo-dir', dir, '--go', ...(flag(args, 'local') ? ['--local'] : [])]
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status !== 0) failed++
    out(`${r.status === 0 ? 'started' : 'FAILED '} ${p.kind} ${p.slug}${r.status === 0 ? '' : `: ${(r.stderr || r.stdout).trim().split('\n').pop()}`}`)
  }
  process.exitCode = failed ? 1 : 0
}
