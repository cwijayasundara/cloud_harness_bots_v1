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
import { fmList, sectionPaths, overlaps, choose, pendingPlans, type Flight, type Ready } from '../src/coordinate.ts'

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
  assert.ok(overlaps('src/api/**', 'src/api/users/x.ts')); assert.ok(overlaps('src/api/users.ts', 'src/api/*.ts'))
  assert.ok(overlaps('src/api/', 'src/api/x.ts')); assert.ok(!overlaps('src/web/**', 'src/api/x.ts'))
  assert.ok(overlaps('src/**', 'src/api/*.ts')); assert.ok(!overlaps('src/web/**', 'src/api/**'))
})

const flight = (slug: string, claims: string[], over: Partial<Flight> = {}): Flight => ({ slug, branch: `origin/sdlc/${slug}`, claims, approved: false, proofPass: false, builds: 0, ...over })
const r = (slug: string, sprint = 1): Ready => ({ slug, sprint })

test('choose: builds first, one writer per file, the WIP limit, unscoped work alone, deferred and later sprints last', () => {
  const scopes = new Map([['a', ['src/api/**']], ['b', ['src/api/users.ts']], ['c', ['src/web/**']], ['e', ['docs/x.md']], ['late', ['lib/z.ts']], ['d', []]])
  const flights = [flight('x', ['src/web/page.ts']), flight('y', ['src/y.ts'], { approved: true }), flight('z', [], { approved: true, builds: 2 }), flight('done', [], { approved: true, proofPass: true })]
  const { picks, skipped } = choose([r('late', 2), r('e'), r('d'), r('c'), r('b'), r('a'), r('x')], flights, scopes, { wip: 6, deferred: ['e'], maxBuilds: 2 })
  assert.deepEqual(picks.map(p => `${p.kind}:${p.slug}`), ['build:y', 'plan:b', 'plan:late'])
  const why = Object.fromEntries(skipped.map(s => [s.slug, s.why]))
  assert.match(why.z!, /2 build session\(s\) already: it needs a person/)
  assert.match(why.c!, /one writer per file: src\/web\/\*\* ↔ src\/web\/page\.ts \(x\)/)
  assert.match(why.a!, /src\/api\/\*\* ↔ src\/api\/users\.ts \(b\)/, 'b came first (stable order), so a waits')
  assert.match(why.d!, /declares no scope/)
  assert.match(why.e!, /limit \(6\)/, 'deferred goes last, after the limit filled')
  assert.equal(picks.find(p => p.slug === 'b')!.intent, '.rig/product/sprints/sprint-1/intents/b.md')
  // Nothing in flight: an unscoped intent runs, and alone.
  const alone = choose([r('d'), r('c')], [], scopes, { wip: 4, deferred: [], maxBuilds: 2 })
  assert.deepEqual(alone.picks.map(p => p.slug), ['d']); assert.match(alone.skipped[0]!.why, /limit/)
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
    '.rig/bin/sdlc.ts': "const fs = process.getBuiltinModule('fs'); if (process.argv[2] === 'ready') process.stdout.write(fs.readFileSync(process.env.CLAUDE_PROJECT_DIR + '/.rig/ready.json', 'utf8')); else process.exit(2)\n",
    '.rig/ready.json': JSON.stringify(['a', 'b', 'c', 'd'].map(s => ({ slug: s, sprint: 1 }))),
    '.rig/autonomy.json': JSON.stringify({ rung, since: '', deferred: [], history: [] }),
    [`${sprint}/a.md`]: intent('scope: [src/api/**]'), [`${sprint}/b.md`]: intent('scope: [src/api/users.ts]'),
    [`${sprint}/c.md`]: intent('scope:\n  - src/web/**'), [`${sprint}/d.md`]: intent(''), [`${sprint}/x.md`]: intent('scope: [src/web/page.ts]'), [`${sprint}/y.md`]: intent('scope: [src/y.ts]'),
    'src/web/page.ts': '1\n',
  })
  sh(`git add -A && ${GIT} commit -qm init && git remote add origin ${origin} && git push -q origin main && git fetch -q origin`, dir)
  // In flight on the remote: x (plan names src/web/page.ts) and y (approved, no proof yet).
  sh(`git switch -q -c sdlc/x && mkdir -p .rig/changes/x && printf '## Files\\n- src/web/page.ts\\n' > .rig/changes/x/plan.md && git add -A && ${GIT} commit -qm x && git push -q origin sdlc/x`, dir)
  sh(`git switch -q main && git switch -q -c sdlc/y && mkdir -p .rig/changes/y && echo '{}' > .rig/changes/y/approval.json && git add -A && ${GIT} commit -qm y && git push -q origin sdlc/y && git switch -q main`, dir)
  write(bin, { claude: `#!/bin/sh\nprintf '%s\\n' "$2" | head -1 >> ${root}/claude.log\n` }); fs.chmodSync(path.join(bin, 'claude'), 0o755)
  const run = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'coordinate', '--repo-dir', dir, '--base', 'origin/main', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CHB_HOME: home, PATH: `${bin}:${process.env.PATH}` } })
  return { root, dir, run, started: () => { try { return fs.readFileSync(path.join(root, 'claude.log'), 'utf8').trim().split('\n') } catch { return [] } } }
}

test('chb coordinate: dry run shows flights, starts and waits; --go starts them; a started plan holds its scope until its branch exists', () => {
  const w = world(1)
  const dry = w.run([])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /2 in flight, 4 ready, work-in-progress limit 4, autonomy rung 1/)
  assert.match(dry.stdout, /flight {2}x: claims src\/web\/page\.ts/); assert.match(dry.stdout, /flight {2}y \(approved\)/)
  assert.match(dry.stdout, /start {3}build y/); assert.match(dry.stdout, /start {3}plan a: ready; scope src\/api\/\*\*/)
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

test('chb coordinate: at rung 0 plans are listed but only builds start; JSON output; not a rig repo', () => {
  const w = world(0)
  const go = w.run(['--go', '--local'])
  assert.match(go.stdout, /rung 0: a person starts each intent/); assert.match(go.stdout, /started build y/); assert.doesNotMatch(go.stdout, /started plan/)
  assert.equal(w.started().length, 1)
  const j = JSON.parse(w.run(['--json']).stdout) as { picks: { kind: string; slug: string }[]; rung: number }
  assert.equal(j.rung, 0); assert.ok(j.picks.some(p => p.slug === 'a'))
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'norig-'))
  assert.match(spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'coordinate', '--repo-dir', bare], { encoding: 'utf8' }).stderr, /not a rig repo/)
})
