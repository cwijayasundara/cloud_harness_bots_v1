#!/usr/bin/env node
// The pilot's dry run: a team of agents on rig's own sample sprint, for $0.
//
//   node pilot/dry-run.mjs --rig <rig_v1 checkout> [--out <dir>]
//
// It builds a sandbox repo with a local origin, onboards rig, adds rig's sample sprint (3 intents: stock-model, then
// stock-endpoint and cart-stock-limit, which both depend on it) with a `scope:` on each, and then runs "hours":
//   - `chb coordinate --go --emit` chooses, exactly as the GitHub Actions workflow does;
//   - each chosen session runs side by side (`chb dispatch … --local --go --no-log`), with a scripted stand-in for
//     Claude (pilot/scripted-claude.mjs) that makes the branch, plan, code, tests and proof a session would;
//   - the pilot then plays YOU, and says so: it approves plans that are waiting and merges builds with a passing proof.
// --auto: the tier-0 auto-build path instead. YOU turn rig's plan gate off once and set CHB_AUTO_BUILD=tier0, then
// approve nothing: every plan must reach a passing proof without a person, and only the merges are yours.
// It proves the plumbing (rig's readiness and approvals, one writer per file, parallel sessions, caps, merging), not a
// model's code. The real run is the same sprint with the workflow and real sessions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CHB = path.resolve(HERE, '../bin/chb.ts')
const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const RIG = path.resolve(arg('rig') ?? process.env.CHB_PILOT_RIG ?? '')
if (!fs.existsSync(path.join(RIG, 'scripts/sdlc.ts'))) { console.error('usage: node pilot/dry-run.mjs --rig <rig_v1 checkout> [--out <dir>]   (git clone https://github.com/cwijayasundara/rig_v1)'); process.exit(2) }
const OUT = path.resolve(arg('out') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chb-pilot-')))
const AUTO = process.argv.includes('--auto')
const NAME = process.env.CHB_GIT_NAME ?? 'Chaminda Wijayasundara', EMAIL = process.env.CHB_GIT_EMAIL ?? 'cwijayasundara@gmail.com'

fs.rmSync(OUT, { recursive: true, force: true })
const DIR = path.join(OUT, 'repo'), ORIGIN = path.join(OUT, 'origin.git'), BIN = path.join(OUT, 'bin'), HOME = path.join(OUT, 'chb-home')
for (const d of [DIR, BIN, HOME]) fs.mkdirSync(d, { recursive: true })
fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, 'scripted-claude.mjs')}" "$@"\n`, { mode: 0o755 })
const ENV = { ...process.env, PATH: `${BIN}${path.delimiter}${process.env.PATH}`, CHB_HOME: HOME, CHB_AUTO_BUILD: AUTO ? 'tier0' : 'off', GIT_AUTHOR_NAME: NAME, GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: NAME, GIT_COMMITTER_EMAIL: EMAIL }
delete ENV.NODE_TEST_CONTEXT
const run = (cmd, args, { cwd = DIR, env = {}, ok = true } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...ENV, ...env } })
  if (ok && r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}${r.stderr}`)
  return r
}
const git = (...args) => run('git', args).stdout.trim()
const sdlc = (args, { human = false, cwd = DIR } = {}) => run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(cwd, '.rig/bin/sdlc.ts'), ...args], { cwd, env: { CLAUDE_PROJECT_DIR: cwd, ...(human ? { SDLC_HUMAN: '1' } : {}) } })
const chb = args => run(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args])
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(DIR, rel)), { recursive: true }); fs.writeFileSync(path.join(DIR, rel), text) }
// rig commits some human actions itself (approvals, since rig aa1e72f), so commit only what is left
const commit = (msg, cwd = DIR) => {
  run('git', ['add', '-A'], { cwd })
  if (run('git', ['diff', '--cached', '--quiet'], { cwd, ok: false }).status !== 0) run('git', ['commit', '-q', '-m', msg], { cwd })
}
const say = s => console.log(s)

// ---------- the repo, onboarded the way rig's own e2e does it ----------
run('git', ['init', '-q', '--bare', ORIGIN], { cwd: OUT })
git('init', '-q', '-b', 'main'); git('config', 'user.name', NAME); git('config', 'user.email', EMAIL); git('remote', 'add', 'origin', ORIGIN)
write('package.json', JSON.stringify({ name: 'shop-app', version: '0.1.0', type: 'module', scripts: { start: 'node src/server.js', test: 'node --test', 'test-fast': 'node --test', lint: 'node --check src/index.js' } }, null, 2) + '\n')
write('src/index.js', 'export {}\n')
write('test/smoke.test.js', "import { test } from 'node:test'\nimport '../src/index.js'\ntest('loads', () => {})\n")
write('scripts/contract.mjs', fs.readFileSync(path.join(RIG, 'tests/e2e/fixtures/tooling/scripts/contract.mjs'), 'utf8'))
commit('chore: scaffold')
run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RIG, 'scripts/sdlc.ts'), 'init'], { env: { CLAUDE_PROJECT_DIR: DIR } })
write('.rig/sensors.json', JSON.stringify({ contracts: { files: ['api/openapi.yaml', 'contracts/examples/**'], covers: ['src/http/**', 'src/server.js'], validate: 'node scripts/contract.mjs validate', run: 'node scripts/contract.mjs run' }, sensors: [{ id: 'unit', cmd: 'npm test', cadence: 'turn', blocks: true, count: 'exit', guide: 'Run the unit suite before claiming done; fix the code, never the tests.' }] }, null, 2) + '\n')
write('CLAUDE.md', '# shop-app\n\nsdlc routes all work in this repo: start with /rig:start; use superpowers skills only when an sdlc skill names one.\n\n## Map\n- src/\n')
run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(RIG, 'scripts/sdlc.ts'), 'init', '--full'], { env: { CLAUDE_PROJECT_DIR: DIR } })
sdlc(['sync']); commit('chore: onboard rig')
say(`pilot: sandbox ${OUT}; rig ${spawnSync('git', ['-C', RIG, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).stdout.trim()}`)

// ---------- the sprint: rig's sample chart, each intent given the files it writes ----------
const FX = path.join(RIG, 'tests/e2e/prd/chart-fixture')
fs.cpSync(path.join(FX, 'product'), path.join(DIR, '.rig/product'), { recursive: true })
fs.cpSync(path.join(FX, 'repo'), DIR, { recursive: true })
const SCOPES = { 'stock-model': 'src/catalog/**', 'stock-endpoint': 'src/http/**', 'cart-stock-limit': 'src/cart/**' }
for (const [slug, scope] of Object.entries(SCOPES)) {
  const f = `.rig/product/sprints/sprint-1/intents/${slug}.md`
  write(f, fs.readFileSync(path.join(DIR, f), 'utf8').replace('estimate_days:', `scope: [${scope}]\nestimate_days:`))
}
const check = sdlc(['chart', 'check', '1', '--cases'], { cwd: DIR })
say(`rig: ${check.stdout.trim().split('\n').pop()}`)
commit('product: sprint 1 chart')
say(`YOU (played by the pilot): ${sdlc(['approve', 'chart-1'], { human: true }).stdout.trim().split('\n')[0]}`)
commit('approve chart-1')
say(`YOU (played by the pilot): ${sdlc(['autonomy', 'set', '2', '--why', 'pilot'], { human: true }).stdout.trim().split('\n')[0]}`)
commit('autonomy: rung 2 for the pilot')
if (AUTO) {
  const f = path.join(DIR, '.rig/sensors.json')
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), gates: { plan: false } }, null, 2) + '\n')
  sdlc(['sync']); commit('chore: plan gate off for tier-0 auto-builds')
  say("YOU (played by the pilot): rig's plan gate off (gates.plan: false) and CHB_AUTO_BUILD=tier0; no plan will be approved")
}
git('push', '-q', '-u', 'origin', 'main')

// ---------- the hours ----------
const timeline = []
const builtAuto = new Set() // changes the coordinator started a build for as tier 0
const parallel = jobs => Promise.all(jobs.map(j => new Promise(resolve => {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'dispatch', j.kind, j.arg, '--repo-dir', DIR, '--local', '--go', '--no-log'], { cwd: DIR, env: ENV })
  let o = ''
  p.stdout.on('data', d => { o += d }); p.stderr.on('data', d => { o += d })
  p.on('close', code => resolve({ ...j, code, result: o.split('\n').find(l => l.startsWith('CHB-RESULT')) ?? o.trim().split('\n').pop() }))
})))
const branches = () => { git('fetch', '-q', '--prune', 'origin'); return git('for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/sdlc/').split('\n').filter(Boolean) }
const has = (ref, f) => run('git', ['cat-file', '-e', `${ref}:${f}`], { ok: false }).status === 0

for (let hour = 1; hour <= 8; hour++) {
  const c = chb(['coordinate', '--repo-dir', DIR, '--base', 'origin/main', '--go', '--emit', path.join(OUT, 'jobs.json')])
  const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'jobs.json'), 'utf8'))
  say(`\n── hour ${hour}: coordinate`)
  say(c.stdout.split('\n').filter(l => /^(coordinate|  (flight|start|wait))/.test(l)).join('\n'))
  for (const m of c.stdout.matchAll(/^  start   build (\S+): tier 0/gm)) builtAuto.add(m[1])
  const results = await parallel(jobs)
  for (const r of results) say(`   session ${r.kind} ${r.slug}: ${r.code === 0 ? r.result : `FAILED: ${r.result}`}`)
  timeline.push({ hour, started: jobs.map(j => `${j.kind}:${j.slug}`), failed: results.filter(r => r.code !== 0).length })
  // YOU: approve every plan that waits for you, then merge every build whose proof passes.
  let acted = 0
  for (const b of branches()) {
    const slug = b.replace('origin/sdlc/', '')
    if (!AUTO && has(b, `.rig/changes/${slug}/plan.md`) && !has(b, `.rig/changes/${slug}/approval.json`)) {
      const wt = path.join(OUT, `approve-${slug}`)
      git('worktree', 'add', '-q', '-B', `sdlc/${slug}`, wt, b)
      const a = sdlc(['approve', slug], { human: true, cwd: wt })
      commit(`approve: ${slug}`, wt); run('git', ['push', '-q', 'origin', `sdlc/${slug}`], { cwd: wt })
      git('worktree', 'remove', '--force', wt)
      say(`   YOU (played by the pilot) approve ${slug}: ${a.stdout.trim().split('\n')[0]}`); acted++
    } else if (has(b, `.rig/changes/${slug}/proof.json`) && JSON.parse(run('git', ['show', `${b}:.rig/changes/${slug}/proof.json`]).stdout).pass) {
      git('checkout', '-q', 'main'); git('pull', '-q', '--ff-only', 'origin', 'main')
      git('merge', '-q', '--no-ff', '-m', `Merge sdlc/${slug} (#${hour})`, b)
      write(`.rig/changes/${slug}/pr.md`, `# ${slug}\n\nMerged by the pilot standing in for you.\n`)
      commit(`pr: ${slug} shipped`); git('push', '-q', 'origin', 'main'); git('push', '-q', 'origin', '--delete', `sdlc/${slug}`)
      say(`   YOU (played by the pilot) merge ${slug}`); acted++
    }
  }
  if (!jobs.length && !acted && !branches().length) { say(`\nhour ${hour}: nothing in flight, nothing ready: the sprint is done`); break }
}

// ---------- what it proved ----------
const shipped = Object.keys(SCOPES).filter(s => has('origin/main', `.rig/changes/${s}/pr.md`))
const widest = Math.max(...timeline.map(t => t.started.length))
const authors = [...new Set(git('log', '--all', '--format=%ae').split('\n'))]
const checks = [
  [`all ${Object.keys(SCOPES).length} intents shipped`, shipped.length === Object.keys(SCOPES).length, shipped.join(', ')],
  ['stock-model ran first and alone (its dependants waited for it)', timeline[0]?.started.join() === 'plan:stock-model', timeline[0]?.started.join()],
  ['two sessions ran side by side in one hour (disjoint scopes)', widest >= 2, `widest hour: ${widest}`],
  ['no session failed', timeline.every(t => !t.failed), timeline.map(t => t.failed).join(',')],
  [`every commit is by ${EMAIL}`, authors.length === 1 && authors[0] === EMAIL, authors.join(', ')],
  ...(AUTO ? [
    ['no plan was approved: every build was tier 0', !git('log', '--all', '--format=', '--name-only').split('\n').some(f => /^\.rig\/changes\/[^/]+\/approval\.json$/.test(f)), 'an approval.json was committed'],
    ['every build started as tier 0', builtAuto.size === Object.keys(SCOPES).length, [...builtAuto].join(', ')],
  ] : []),
]
say('\n── what the dry run proved')
for (const [what, okay, detail] of checks) say(`  ${okay ? 'ok  ' : 'FAIL'} ${what}${okay ? '' : `: ${detail}`}`)
say(`\nsandbox kept in ${OUT} (the repo, its origin and the dispatch log)`)
process.exitCode = checks.every(c => c[1]) ? 0 : 1
