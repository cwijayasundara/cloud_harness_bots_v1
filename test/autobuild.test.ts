// The tier-0 auto-build path: the verdict, the coordinator's choice, and `chb dispatch build` taking the verdict again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { autoBuildOn, planGateOff, openQuestions, outsideRadius, autoVerdict, weightVerdict } from '../src/autobuild.ts'
import { choose, type Flight } from '../src/coordinate.ts'
import { buildPrompt } from '../src/dispatch.ts'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
const SPEC = '# Spec\n\n## Behaviours\n- B1: works\n\n## Blast radius\n- src/cart/**\n- test/cart.test.js\n\n## Open questions\nnone\n'
const PLAN = '# Plan\n\n## Files\n- src/cart/limit.js\n- test/cart.test.js\n\n## Contracts\nnone\n\n## Open questions\nnone\n'
const clean = { slug: 'cart', spec: SPEC, plan: PLAN, diff: ['.rig/changes/cart/spec.md', '.rig/changes/cart/plan.md'] }

test('settings: CHB_AUTO_BUILD is tier0 or off, nothing else; the plan gate is off only when sensors.json says false', () => {
  assert.equal(autoBuildOn(undefined), false); assert.equal(autoBuildOn(''), false); assert.equal(autoBuildOn('off'), false)
  assert.equal(autoBuildOn('tier0'), true)
  assert.throws(() => autoBuildOn('true'), /use tier0, or off/)
  assert.equal(planGateOff('{"gates":{"plan":false}}'), true)
  for (const t of ['{"gates":{"plan":true}}', '{}', '{"gates":{"plan":"false"}}', 'not json', '']) assert.equal(planGateOff(t), false, t)
})

test('rig\'s readings: open questions other than none, prose Qn still open; paths inside a radius by equality, folder or glob', () => {
  assert.deepEqual(openQuestions('## Open questions\nnone\n'), [])
  assert.deepEqual(openQuestions('## Open questions\n- None.\n'), [])
  assert.deepEqual(openQuestions('## Open questions\n- which db? (recommended: sqlite)\n## Next\n- x\n'), ['which db? (recommended: sqlite)'])
  assert.deepEqual(openQuestions('# Spec\nQ2 is still open, see below\n'), ['Q2 is still open, see below'])
  assert.deepEqual(outsideRadius(['src/cart/a.js', './test/cart.test.js', 'src/web/x.js', 'lib/z/y.js'], ['src/cart/**', 'test/cart.test.js', 'lib/z']), ['src/web/x.js'])
})

test('verdict: a clean plan is tier 0; each signal a person or rig would raise keeps it waiting, with the reason', () => {
  assert.deepEqual(autoVerdict(clean), { ok: true, why: [] })
  const why = (over: Partial<typeof clean>) => autoVerdict({ ...clean, ...over }).why.join(' | ')
  assert.match(why({ spec: '' }), /no spec\.md yet/)
  assert.match(why({ plan: '' }), /no plan\.md yet/)
  assert.match(why({ spec: SPEC.replace('## Open questions\nnone', '## Open questions\n- keep the old limit?') }), /1 open question\(s\) for a person: spec\.md: keep the old limit\?/)
  assert.match(why({ spec: SPEC.replace(/## Blast radius[\s\S]*?\n\n/, '') }), /no ## Blast radius/)
  assert.match(why({ plan: PLAN.replace('- src/cart/limit.js', '- src/billing/charge.js') }), /## Files outside the blast radius: src\/billing\/charge\.js/)
  assert.match(why({ plan: PLAN.replace('## Contracts\nnone', '## Contracts\n- api/cart.yaml') }), /one-way door/)
  assert.match(why({ diff: [...clean.diff, '.rig/sensors.json'] }), /harness files: \.rig\/sensors\.json/)
  assert.match(why({ diff: [...clean.diff, '.github/workflows/ci.yml', 'CLAUDE.md'] }), /harness files: \.github\/workflows\/ci\.yml, CLAUDE\.md/)
  assert.match(why({ diff: [...clean.diff, 'src/web/page.js'] }), /outside the blast radius: src\/web\/page\.js/)
  // a second build session: code inside the radius is fine
  assert.equal(autoVerdict({ ...clean, diff: [...clean.diff, 'src/cart/limit.js', 'test/cart.test.js'] }).ok, true)
  // another change's folder is not this change's
  assert.match(why({ diff: [...clean.diff, '.rig/changes/other/plan.md'] }), /harness files: \.rig\/changes\/other\/plan\.md/)
})

test('weight: only rig\'s "light" passes; full carries rig\'s reasons; no verdict waits', () => {
  assert.equal(weightVerdict({ weight: 'light', reasons: [] }).ok, true)
  assert.match(weightVerdict({ weight: 'full', reasons: ['always-human path in the blast radius: .github/'] }).why[0]!, /full \(tier 2\): always-human path/)
  assert.match(weightVerdict(null).why[0]!, /no verdict/)
  assert.equal(weightVerdict({ weight: 'heavy' }).ok, false)
})

const flight = (slug: string, over: Partial<Flight> = {}): Flight => ({ slug, branch: `origin/sdlc/${slug}`, claims: [], approval: 'missing', proofPass: false, builds: 0, buildRunning: false, ...over })
const opts = (over: Record<string, unknown> = {}) => ({ wip: 6, deferred: [] as string[], maxBuilds: 2, maxPlans: 2, rung: 2, plansSoFar: () => 0, ...over })

test('choose: a tier-0 change builds like an approved one, under the same caps; one that is not says why; no verdict means wait quietly', () => {
  const fl = [
    flight('t0', { auto: { ok: true, why: [] } }),
    flight('q', { auto: { ok: false, why: ['1 open question(s) for a person: spec.md: x'] } }),
    flight('quiet'),
    flight('capped', { auto: { ok: true, why: [] }, builds: 2 }),
    flight('ok', { approval: 'approved' }),
  ]
  const { picks, skipped } = choose([], fl, new Map(), opts())
  assert.deepEqual(picks.map(p => p.slug), ['t0', 'ok'])
  assert.match(picks[0]!.why, /tier 0 with rig's plan gate off \(no person approved it\)/)
  assert.match(picks[1]!.why, /^approved/)
  const why = Object.fromEntries(skipped.map(s => [s.slug, s.why]))
  assert.match(why.q!, /not tier 0, so it waits for \/rig:approve: 1 open question/)
  assert.match(why.capped!, /2 build session\(s\) already/)
  assert.equal(why.quiet, undefined)
  assert.match(choose([], fl, new Map(), opts({ rung: 1 })).skipped.find(s => s.slug === 't0')!.why, /builds start at rung 2/)
})

test('build prompt: an auto-build never writes approval.json and stops at anything that would have needed a person', () => {
  const p = buildPrompt('cart', true)
  assert.match(p, /no approval\.json by design/); assert.match(p, /Never write approval\.json/); assert.match(p, /status=needs-human/)
  assert.doesNotMatch(p, /Confirm .*approval\.json is present/)
  assert.match(buildPrompt('cart'), /Confirm \.rig\/changes\/cart\/approval\.json is present/)
})

// A repo with a local origin, rig's plan gate as given, and a stub `sdlc.ts weight` that answers `weight`.
function repo(gateOff: boolean, weight = 'light') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-auto-'))
  const dir = path.join(root, 'repo'), origin = path.join(root, 'origin.git')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', CHB_HOME: path.join(root, 'home') }
  delete (env as Record<string, string | undefined>).CHB_BASE
  const sh = (...args: string[]) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  const put = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t) }
  fs.mkdirSync(dir)
  spawnSync('git', ['init', '-q', '--bare', origin])
  sh('init', '-q', '-b', 'main'); sh('remote', 'add', 'origin', origin)
  put('.rig/sensors.json', JSON.stringify({ gates: { plan: !gateOff }, sensors: [] }))
  put('.rig/bin/sdlc.ts', `if (process.argv[2] === 'weight') console.log(JSON.stringify({ weight: ${JSON.stringify(weight)}, reasons: ${JSON.stringify(weight === 'light' ? [] : ['always-human path in the blast radius: .github/'])} }))\n`)
  put('src/index.js', 'export {}\n')
  sh('add', '-A'); sh('commit', '-q', '-m', 'base'); sh('push', '-q', 'origin', 'main')
  const branch = (files: Record<string, string>) => {
    sh('switch', '-q', '-c', 'sdlc/cart', 'main')
    for (const [f, t] of Object.entries(files)) put(f, t)
    sh('add', '-A'); sh('commit', '-q', '-m', 'plan: cart'); sh('push', '-q', 'origin', 'sdlc/cart'); sh('switch', '-q', 'main')
  }
  const dispatch = (autoEnv: string | undefined) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'dispatch', 'build', 'cart', '--repo-dir', dir], { cwd: dir, encoding: 'utf8', env: { ...env, CHB_AUTO_BUILD: autoEnv ?? '' } })
  return { branch, dispatch }
}
const change = (spec = SPEC) => ({ '.rig/changes/cart/spec.md': spec, '.rig/changes/cart/plan.md': PLAN })

test('dispatch build: tier 0 with the gate off gets the auto prompt; not tier 0 is refused with the reason; off or gate on is an ordinary build', () => {
  let r0 = repo(true); r0.branch(change())
  let r = r0.dispatch('tier0')
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /no approval\.json by design/)
  r = r0.dispatch(undefined)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Confirm \.rig\/changes\/cart\/approval\.json is present/)
  assert.equal(r0.dispatch('yes').status, 1)

  r0 = repo(true); r0.branch(change(SPEC.replace('## Open questions\nnone', '## Open questions\n- keep the old limit?')))
  r = r0.dispatch('tier0')
  assert.equal(r.status, 1); assert.match(r.stderr, /not approved and not tier 0, so a person runs \/rig:approve first: 1 open question/)

  r0 = repo(true, 'full'); r0.branch(change())
  r = r0.dispatch('tier0')
  assert.equal(r.status, 1); assert.match(r.stderr, /rig plans it full \(tier 2\)/)

  // the gate is read from the base: a branch that turns it off for itself is an ordinary build (it needs approval.json)
  r0 = repo(false); r0.branch({ ...change(), '.rig/sensors.json': JSON.stringify({ gates: { plan: false }, sensors: [] }) })
  r = r0.dispatch('tier0')
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /Confirm \.rig\/changes\/cart\/approval\.json is present/)
})
