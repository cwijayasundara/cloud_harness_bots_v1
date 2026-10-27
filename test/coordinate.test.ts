// chb coordinate: one writer per file across cloud sessions, under a work-in-progress limit, from rig's own readiness
// and autonomy. Unit tests for the overlap and scheduling rules; end to end with a real origin, in-flight branches, a
// stub `sdlc.ts ready` and a fake `claude` that records what it was asked to start.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { fmList, sectionPaths, overlaps, choose, pendingPlans, approvalOf, type Flight, type Ready } from '../src/coordinate.ts'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
const sh = (cmd: string, cwd: string) => { const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
const write = (root: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c) } }
const GIT = 'git -c user.name=t -c user.email=t@t -c commit.gpgsign=false'
const intent = (scope: string) => `---\ntype: feature\n${scope}\n---\n# intent\n`

test('rig formats: frontmatter lists in three forms, bullet paths under a heading', () => {
  assert.deepEqual(fmList('---\nscope: [src/a.ts, "src/b/**"]\n---\n', 'scope'), ['src/a.ts', 'src/b/**'])
  assert.deepEqual(fmList('---\nscope: ./src/a.ts\n---\n', 'scope'), ['src/a.ts'])
  assert.deepEqual(fmList('---\nscope:\n  - src/a.ts  # main\n  - src/b/\nother: x\n---\n', 'scope'), ['src/a.ts', 'src/b/'])
  assert.deepEqual(fmList('---\ntype: x\n---\n', 'scope'), [])
  assert.deepEqual(sectionPaths('# Plan\n## Files\n- `src/a.ts`: add x\n- modify: src/b.py\n- the README\n## Tests\n- tests/t.py\n', 'Files'), ['src/a.ts', 'src/b.py'])
})

test('overlap: paths exactly, globs and folders by matching, two globs by their literal folders', () => {
  assert.ok(overlaps('src/a.ts', 'src/a.ts')); assert.ok(!overlaps('src/a.ts', 'src/b.ts'))
  // A plain path also means the folder under it (rig's scope rule); trailing slashes, case and backslashes don't matter.
  assert.ok(overlaps('src/api', 'src/api/x.ts')); assert.ok(overlaps('src/api', 'src/api/**')); assert.ok(overlaps('src/a/', 'src/a'))
  assert.ok(overlaps('SRC/Api.ts', 'src/api.ts')); assert.ok(overlaps('src\\a.ts', 'src/a.ts'))
  assert.ok(overlaps('src/**/*.ts', 'src/a/b.ts')); assert.ok(!overlaps('src/**/*.ts', 'lib/a.ts'))
  // Braces and classes: judged by their literal folder, so unsure means yes.
  assert.ok(overlaps('src/{a,b}.ts', 'src/a.ts')); assert.ok(overlaps('src/[ab].ts', 'src/b.ts')); assert.ok(!overlaps('src/{a,b}.ts', 'lib/a.ts'))
  assert.ok(overlaps('src/api/**', 'src/api/users/x.ts')); assert.ok(overlaps('src/api/users.ts', 'src/api/*.ts'))
  assert.ok(overlaps('src/api/', 'src/api/x.ts')); assert.ok(!overlaps('src/web/**', 'src/api/x.ts'))
  assert.ok(overlaps('src/**', 'src/api/*.ts')); assert.ok(!overlaps('src/web/**', 'src/api/**'))
})

const flight = (slug: string, claims: string[], over: Partial<Flight> = {}): Flight => ({ slug, branch: `origin/sdlc/${slug}`, claims, approval: 'missing', proofPass: false, builds: 0, buildRunning: false, ...over })
const opts = (over: Record<string, unknown> = {}) => ({ wip: 6, deferred: [] as string[], maxBuilds: 2, maxPlans: 2, rung: 2, plansSoFar: () => 0, ...over })
const r = (slug: string, sprint = 1): Ready => ({ slug, sprint })

test('choose: builds first, one writer per file, the WIP limit, unscoped work alone, deferred and later sprints last', () => {
  const scopes = new Map([['a', ['src/api/**']], ['b', ['src/api/users.ts']], ['c', ['src/web/**']], ['e', ['docs/x.md']], ['late', ['lib/z.ts']], ['d', []]])
  const flights = [flight('x', ['src/web/page.ts']), flight('y', ['src/y.ts'], { approval: 'approved' }), flight('z', [], { approval: 'approved', builds: 2 }), flight('done', [], { approval: 'approved', proofPass: true })]
  const { picks, skipped } = choose([r('late', 2), r('e'), r('d'), r('c'), r('b'), r('a'), r('x')], flights, scopes, opts({ deferred: ['e'] }))
  assert.deepEqual(picks.map(p => `${p.kind}:${p.slug}`), ['build:y', 'plan:b', 'plan:late'])
  const why = Object.fromEntries(skipped.map(s => [s.slug, s.why]))
  assert.match(why.z!, /2 build session\(s\) already: it needs a person/)
  assert.match(why.c!, /one writer per file: src\/web\/\*\* ↔ src\/web\/page\.ts \(x\)/)
  assert.match(why.a!, /src\/api\/\*\* ↔ src\/api\/users\.ts \(b\)/, 'b came first (stable order), so a waits')
  assert.match(why.d!, /declares no scope/)
  assert.match(why.e!, /limit \(6\)/, 'deferred goes last, after the limit filled')
  assert.equal(picks.find(p => p.slug === 'b')!.intent, '.rig/product/sprints/sprint-1/intents/b.md')
  // Nothing in flight: an unscoped intent runs, and alone.
  const alone = choose([r('d'), r('c')], [], scopes, opts({ wip: 4 }))
  assert.deepEqual(alone.picks.map(p => p.slug), ['d']); assert.match(alone.skipped[0]!.why, /limit/)
})

test('choose: rig\'s rungs, stale approvals, a build still running, and a plan cap for intents that keep coming back', () => {
  const scopes = new Map([['a', ['src/a.ts']]])
  const fl = [flight('y', ['src/y.ts'], { approval: 'approved' }), flight('s', ['src/s.ts'], { approval: 'stale' }), flight('run', ['src/r.ts'], { approval: 'approved', buildRunning: true })]
  const at = (rung: number, plans = 0) => choose([r('a')], fl, scopes, opts({ rung, plansSoFar: () => plans }))
  const r0 = at(0), r1 = at(1), r2 = at(2), capped = at(2, 2)
  assert.deepEqual(r0.picks, []); assert.match(r0.skipped.find(s => s.slug === 'a')!.why, /rung 0: a person starts each intent/)
  assert.deepEqual(r1.picks.map(p => `${p.kind}:${p.slug}`), ['plan:a']); assert.match(r1.skipped.find(s => s.slug === 'y')!.why, /builds start at rung 2/)
  assert.deepEqual(r2.picks.map(p => `${p.kind}:${p.slug}`), ['build:y', 'plan:a'])
  assert.match(r2.skipped.find(s => s.slug === 's')!.why, /approval is stale/); assert.match(r2.skipped.find(s => s.slug === 'run')!.why, /may still be running/)
  assert.match(capped.skipped.find(s => s.slug === 'a')!.why, /2 plan session\(s\) already and it is ready again/)
})

const dg = (t: string) => createHash('sha256').update(t.replace(/\s+$/, '')).digest('hex').slice(0, 16)
test('approval: rig\'s hashes of spec, plan and requirements; anything else is missing or stale', () => {
  const files = { 'spec.md': '# spec\n', 'plan.md': '# plan\n\n' }
  assert.equal(approvalOf(files, JSON.stringify({ hashes: { 'spec.md': dg('# spec'), 'plan.md': dg('# plan') } })), 'approved')
  assert.equal(approvalOf(files, JSON.stringify({ hashes: { 'spec.md': dg('# spec'), 'plan.md': dg('# old plan') } })), 'stale')
  assert.equal(approvalOf({ ...files, 'requirements.md': 'r' }, JSON.stringify({ hashes: { 'spec.md': dg('# spec'), 'plan.md': dg('# plan') } })), 'stale')
  assert.equal(approvalOf(files, '{}'), 'missing'); assert.equal(approvalOf(files, ''), 'missing')
})

test('pending plans: dispatched recently for this repo, by slug', () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pl-')), 'dispatch.jsonl')
  const now = Date.parse('2026-10-27T10:00:00Z')
  fs.writeFileSync(log, [{ at: '2026-10-27T08:00:00Z', kind: 'plan', slug: 'a', repo: 'R' }, { at: '2026-10-26T08:00:00Z', kind: 'plan', slug: 'old', repo: 'R' }, { at: '2026-10-27T09:00:00Z', kind: 'plan', slug: 'b', repo: 'other' }, { at: '2026-10-27T09:00:00Z', kind: 'build', slug: 'c', repo: 'R' }].map(x => JSON.stringify(x)).join('\n') + '\n')
  assert.deepEqual(pendingPlans(log, 'R', 6, now).map(p => p.slug), ['a'])
})

function world(rung: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'))
  const origin = path.join(root, 'origin.git'), dir = path.join(root, 'repo'), bin = path.join(root, 'bin'), home = path.join(root, 'home')
  sh(`git init -q --bare ${origin} && git init -q -b main ${dir}`, root)
  const sprint = '.rig/product/sprints/sprint-1/intents'
  write(dir, {
    // Like rig's readyIntents: an intent whose change folder exists in this checkout has started.
    '.rig/bin/sdlc.ts': "const fs = process.getBuiltinModule('fs'); const d = process.env.CLAUDE_PROJECT_DIR; if (process.argv[2] === 'ready') process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(d + '/.rig/ready.json', 'utf8')).filter(r => !fs.existsSync(d + '/.rig/changes/' + r.slug)))); else process.exit(2)\n",
    '.rig/ready.json': JSON.stringify(['a', 'b', 'c', 'd', 's'].map(s => ({ slug: s, sprint: 1 }))),
    '.rig/autonomy.json': JSON.stringify({ rung, since: '', deferred: [], history: [] }),
    [`${sprint}/a.md`]: intent('scope: [src/api/**]'), [`${sprint}/b.md`]: intent('scope: [src/api/users.ts]'),
    [`${sprint}/c.md`]: intent('scope:\n  - src/web/**'), [`${sprint}/s.md`]: intent('scope: [src/s.ts]'), [`${sprint}/d.md`]: intent(''), [`${sprint}/x.md`]: intent('scope: [src/web/page.ts]'), [`${sprint}/y.md`]: intent('scope: [src/y.ts]'),
    'src/web/page.ts': '1\n',
  })
  sh(`git add -A && ${GIT} commit -qm init && git remote add origin ${origin} && git push -q origin main && git fetch -q origin`, dir)
  // In flight on the remote: x (plan names src/web/page.ts) and y (approved, no proof yet).
  sh(`git switch -q -c sdlc/x && mkdir -p .rig/changes/x && printf '## Files\\n- src/web/page.ts\\n' > .rig/changes/x/plan.md && git add -A && ${GIT} commit -qm x && git push -q origin sdlc/x`, dir)
  sh(`git switch -q main && git switch -q -c sdlc/y && mkdir -p .rig/changes/y && printf '# spec\\n' > .rig/changes/y/spec.md && printf '# plan\\n' > .rig/changes/y/plan.md && git add -A && ${GIT} commit -qm y`, dir)
  write(dir, { '.rig/changes/y/approval.json': JSON.stringify({ hashes: { 'spec.md': dg('# spec'), 'plan.md': dg('# plan') } }) })
  sh(`git add -A && ${GIT} commit -qm approve && git push -q origin sdlc/y && git switch -q main`, dir)
  // Squash-merged and shipped: s's commits are not ancestors of main, but main has its pr.md.
  sh(`git switch -q -c sdlc/s && echo s > src/s.ts && git add -A && ${GIT} commit -qm s && git push -q origin sdlc/s && git switch -q main && mkdir -p .rig/changes/s && echo shipped > .rig/changes/s/pr.md && echo s > src/s.ts && git add -A && ${GIT} commit -qm "s (#1)" && git push -q origin main && git fetch -q origin`, dir)
  write(bin, { claude: `#!/bin/sh\nprintf '%s\\n' "$2" | head -1 >> ${root}/claude.log\n` }); fs.chmodSync(path.join(bin, 'claude'), 0o755)
  const run = (args: string[], base = ['--base', 'origin/main']) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'coordinate', '--repo-dir', dir, ...base, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CHB_HOME: home, PATH: `${bin}:${process.env.PATH}` } })
  return { root, dir, run, started: () => { try { return fs.readFileSync(path.join(root, 'claude.log'), 'utf8').trim().split('\n') } catch { return [] } } }
}

test('chb coordinate: dry run shows flights, starts and waits; --go starts them; a started plan holds its scope until its branch exists', () => {
  const w = world(2)
  const dry = w.run([])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /against origin\/main: 2 in flight, 4 ready, work-in-progress limit 4, autonomy rung 2/)
  assert.doesNotMatch(dry.stdout, /flight {2}s/, 'squash-merged and shipped: not in flight')
  assert.match(dry.stdout, /flight {2}x: claims src\/web\/page\.ts/); assert.match(dry.stdout, /flight {2}y \(approved\)/)
  assert.match(dry.stdout, /start {3}build y/); assert.match(dry.stdout, /start {3}plan a: ready; writes src\/api\/\*\*/)
  assert.match(dry.stdout, /wait {4}b: one writer per file/); assert.match(dry.stdout, /wait {4}c: one writer per file: src\/web\/\*\* ↔ src\/web\/page\.ts \(x\)/)
  assert.match(dry.stdout, /wait {4}d: its intent declares no scope/); assert.match(dry.stdout, /dry run/)
  assert.deepEqual(w.started(), [])

  const go = w.run(['--go', '--local'])
  assert.equal(go.status, 0, go.stdout + go.stderr)
  assert.match(go.stdout, /started build y/); assert.match(go.stdout, /started plan a/)
  const prompts = w.started()
  assert.equal(prompts.length, 2); assert.ok(prompts.some(p => p.startsWith('Check out the branch sdlc/y'))); assert.ok(prompts.some(p => p.startsWith('/rig:start .rig/product/sprints/sprint-1/intents/a.md')))

  const again = w.run([])
  assert.match(again.stdout, /flight {2}a \(plan dispatched, no branch yet\): claims src\/api\/\*\*/)
  assert.doesNotMatch(again.stdout, /start {3}plan a/); assert.match(again.stdout, /wait {4}b: one writer per file: src\/api\/users\.ts ↔ src\/api\/\*\* \(a\)/)
})

test('chb coordinate: rung 1 starts plans only; a second run does not start the same build; JSON; not a rig repo', () => {
  const w = world(1)
  const go = w.run(['--go', '--local'])
  assert.match(go.stdout, /wait {4}y: approved, but rung 1: builds start at rung 2/); assert.match(go.stdout, /started plan a/); assert.doesNotMatch(go.stdout, /started build/)
  assert.equal(w.started().length, 1)
  const j = JSON.parse(w.run(['--json']).stdout) as { picks: { kind: string; slug: string }[]; rung: number }
  assert.equal(j.rung, 1); assert.ok(!j.picks.some(p => p.slug === 'a'), 'a is pending now')
  const w2 = world(2)
  w2.run(['--go', '--local'])
  const second = w2.run([])
  assert.match(second.stdout, /wait {4}y: a build session was started after its last commit and may still be running/)
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'norig-'))
  assert.match(spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'coordinate', '--repo-dir', bare], { encoding: 'utf8' }).stderr, /not a rig repo/)
})

test('chb coordinate: origin/HEAD on a change branch is not the base; a stale checkout does not re-plan shipped work', () => {
  const w = world(2)
  sh('git remote set-head origin sdlc/x', w.dir)
  const r = w.run([], [])
  assert.match(r.stdout, /against origin\/main: 2 in flight/)
  // The checkout is behind origin/main (s shipped there, so its change folder is missing here); ready is judged on
  // origin/main all the same, so s is not planned again.
  sh('git reset -q --hard HEAD~1', w.dir)
  assert.ok(!fs.existsSync(path.join(w.dir, '.rig/changes/s')))
  const stale = w.run([])
  assert.match(stale.stdout, /4 ready/); assert.doesNotMatch(stale.stdout, /plan s/)
})

test('chb coordinate: one run at a time per repo; --go refuses to act on a failed fetch', () => {
  const w = world(2)
  const home = path.join(w.root, 'home'); fs.mkdirSync(home, { recursive: true })
  const lockOf = () => fs.readdirSync(home).find(f => f.startsWith('coordinate-'))
  w.run([]) // creates and removes its lock
  assert.equal(lockOf(), undefined, 'the lock is released')
  // Hold the lock with this test's own (live) pid.
  const repoKey = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: w.dir, encoding: 'utf8' }).stdout.trim().replace(/\.git$/, '')
  const name = `coordinate-${createHash('sha1').update(repoKey).digest('hex').slice(0, 12)}.lock`
  fs.writeFileSync(path.join(home, name), String(process.pid))
  assert.match(w.run([]).stdout, /another coordinate run \(pid \d+\) is working on this repo; nothing done/)
  fs.rmSync(path.join(home, name))
  sh('git remote set-url origin /nonexistent/origin.git', w.dir)
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'coordinate', '--repo-dir', w.dir, '--base', 'origin/main', '--go', '--local'], { cwd: w.dir, encoding: 'utf8', env: { ...process.env, CHB_HOME: home } })
  assert.equal(r.status, 2); assert.match(r.stderr, /fetch origin failed: not starting sessions from stale branches/)
  assert.deepEqual(w.started(), [])
})

test('chb coordinate --emit: records the picks and writes a job list for a runner; dispatch --no-log does not count twice', () => {
  const w = world(2)
  const jobsFile = path.join(w.root, 'jobs.json'), log = path.join(w.root, 'home', 'dispatch.jsonl')
  const r = w.run(['--go', '--emit', jobsFile])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /emitted 2 job\(s\)/)
  assert.deepEqual(JSON.parse(fs.readFileSync(jobsFile, 'utf8')), [{ kind: 'build', arg: 'y', slug: 'y' }, { kind: 'plan', arg: '.rig/product/sprints/sprint-1/intents/a.md', slug: 'a' }])
  assert.deepEqual(w.started(), [], 'emit starts nothing itself')
  const rows = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { kind: string; slug: string; via?: string })
  assert.deepEqual(rows().map(x => `${x.kind}:${x.slug}:${x.via}`), ['build:y:emit', 'plan:a:emit'])
  // The runner's job: dispatch with --no-log runs the session and leaves the log as coordinate wrote it.
  const env = { ...process.env, CHB_HOME: path.join(w.root, 'home'), PATH: `${path.join(w.root, 'bin')}:${process.env.PATH}`, CHB_CLAUDE_ARGS: '--permission-mode bypassPermissions --max-budget-usd 3' }
  const d = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'dispatch', 'build', 'y', '--repo-dir', w.dir, '--local', '--go', '--no-log'], { cwd: w.dir, encoding: 'utf8', env })
  assert.equal(d.status, 0, d.stderr); assert.equal(rows().length, 2); assert.equal(w.started().length, 1)
  // An hour later the build that was emitted counts as running, and the plan as pending.
  const again = w.run([])
  assert.match(again.stdout, /wait {4}y: a build session was started after its last commit/); assert.match(again.stdout, /flight {2}a \(plan dispatched, no branch yet\)/)
})
