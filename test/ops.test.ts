import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../src/cli.ts'
import { decide, type Proof } from '../src/proof.ts'
import { classify, checkCounts, renderMarkdown, type PR } from '../src/ledger.ts'
import { mergeDecision, policyFromEnv } from '../src/merge.ts'
import { summarise, overnight, parseTouchLog, median } from '../src/report.ts'
import { parseReview, toType, frontmatter, slugFromBranch } from '../src/rig.ts'
import { planPrompt, buildPrompt, auditPrompt, command } from '../src/dispatch.ts'
import { mergeSensors, appendLines, UB_SENSORS, SENSORS } from '../src/install.ts'

const gate = (pass = true) => ({ pass, blocking: pass ? 0 : 2, total: 2, scope: 'changed', head: 'abc', stale: false, untrusted: [] as string[] })
const proof = (over: Partial<Proof> = {}): Proof => {
  const p = { version: 1 as const, slug: 'tidy-x', type: 'refactor' as const, at: '', head: 'abc', base: 'main', verify: { pass: true, at: '', blocks: [], fresh: true as boolean | null }, gates: { crap: gate(), dry: gate(), mutate: null }, review: { verdict: 'pass' as const, openHigh: 0, open: 0 }, diff: { files: 2, added: 40, deleted: 30 }, ...over }
  return { ...p, ...decide(p, ['crap', 'dry']) }
}
const pr = (over: Partial<PR> = {}): PR => ({ number: 7, title: 'refactor: tidy x', url: 'u', headRefName: 'sdlc/tidy-x', headRefOid: 'abc', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED', updatedAt: '2026-10-26T10:00:00Z', additions: 40, deletions: 30, changedFiles: 2, labels: [], statusCheckRollup: [{ name: 'rig-check', status: 'COMPLETED', conclusion: 'SUCCESS' }], ...over })
const NOW = new Date('2026-10-26T12:00:00Z')

test('args: options, booleans, passthrough', () => {
  const a = parseArgs(['crap', '--scope', 'all', '--json', 'x', '--max=12', '--', '--use-existing-coverage'])
  assert.deepEqual(a.pos, ['crap', 'x']); assert.equal(a.opts.scope, 'all'); assert.equal(a.opts.max, '12')
  assert.ok(a.flags.has('json')); assert.deepEqual(a.rest, ['--use-existing-coverage'])
})

test('proof: verify, required gates (fresh), and open high review findings decide done', () => {
  assert.equal(proof().pass, true)
  assert.match(proof({ verify: null }).reasons[0]!, /no verify.json/)
  assert.match(proof({ gates: { crap: null, dry: gate(), mutate: null } }).reasons[0]!, /crap gate not run/)
  assert.match(proof({ gates: { crap: { ...gate(), stale: true }, dry: gate(), mutate: null } }).reasons[0]!, /not HEAD/)
  assert.match(proof({ review: { verdict: 'changes-needed', openHigh: 1, open: 1 } }).reasons[0]!, /1 open critical\/high/)
  assert.match(proof({ verify: { pass: true, at: '', blocks: [], fresh: false } }).reasons[0]!, /another tree/)
  assert.match(proof({ verify: { pass: true, at: '', blocks: [], fresh: null } }).reasons[0]!, /cannot tell/)
  assert.match(proof({ gates: { crap: { ...gate(), untrusted: ['judged an existing snapshot (--no-run)'] }, dry: gate(), mutate: null } }).reasons[0]!, /not proof: judged an existing snapshot/)
})

test('review.md: verdict and open findings, fixed ones excluded', () => {
  const r = parseReview('verdict: changes-needed\n\n## Findings\n- [severity: high] [category: tests] a.ts:3: x → add a test\n- [severity: high] [category: tests] b.ts:4: y → z → fixed\n- [severity: medium] [category: design] c.ts:1: q → r\n\n## Dismissed\n- [severity: high] d.ts:1 nope\n')
  assert.equal(r.verdict, 'changes-needed')
  assert.deepEqual(r.open.map(o => o.severity), ['high', 'medium'])
  assert.equal(parseReview(null).verdict, 'missing')
  assert.equal(toType(frontmatter('---\ntype: incident\n---\n').type), 'bugfix')
  assert.equal(slugFromBranch('sdlc/a-b'), 'a-b'); assert.equal(slugFromBranch('feature/x'), null)
})

test('ledger: ready only on facts; conflicts, failures, stale proof and stalls are visible', () => {
  assert.deepEqual(checkCounts([{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }, { state: 'FAILURE' }]), { ok: 1, pending: 1, failed: 1 })
  assert.equal(classify(pr(), proof(), true, NOW).status, 'ready')
  assert.equal(classify(pr({ mergeable: 'CONFLICTING' }), proof(), true, NOW).status, 'blocked')
  assert.equal(classify(pr(), null, false, NOW).status, 'working')
  assert.equal(classify(pr(), proof(), false, NOW).proof, 'stale')
  assert.equal(classify(pr(), proof({ verify: null }), true, NOW).status, 'blocked')
  const stalled = classify(pr({ updatedAt: '2026-10-24T10:00:00Z' }), null, false, NOW)
  assert.equal(stalled.status, 'blocked'); assert.match(stalled.reasons[0]!, /stalled: no update for 50 h/)
  assert.match(renderMarkdown([classify(pr(), proof(), true, NOW)], 'now'), /1 ready · 0 blocked · 0 working/)
})

test('merge policy: small green refactor merges; features, big diffs, harness edits and missing checks do not', () => {
  const p = { ...policyFromEnv(), types: ['chore', 'refactor'], maxLines: 150, requiredChecks: ['rig-check'] }
  const ok = [{ name: 'rig-check', ok: true }]
  const row = classify(pr(), proof(), true, NOW)
  assert.equal(mergeDecision(row, proof(), ['src/x.ts', '.rig/changes/tidy-x/approval.json'], ok, p).merge, true)
  assert.match(mergeDecision(row, proof({ type: 'feature' }), ['src/x.ts'], ok, p).reasons.join(), /type feature is not auto-mergeable/)
  assert.match(mergeDecision(row, proof(), ['.rig/sensors.json'], ok, p).reasons.join(), /protected paths/)
  assert.match(mergeDecision(row, proof(), ['package.json'], ok, p).reasons.join(), /protected paths/)
  assert.match(mergeDecision(row, proof(), ['src/x.ts'], [], p).reasons.join(), /rig-check has not run/)
  assert.match(mergeDecision(classify(pr({ additions: 200 }), proof(), true, NOW), proof(), ['src/x.ts'], ok, p).reasons.join(), /> 150/)
})

test('report: lead time, overnight in London time, touch log', () => {
  assert.equal(median([3, 1, 2]), 2); assert.equal(median([1, 2, 3, 4]), 2.5); assert.equal(median([]), null)
  assert.equal(overnight('2026-10-26T22:30:00Z', 'Europe/London'), true) // 22:30 GMT
  assert.equal(overnight('2026-07-01T06:30:00Z', 'Europe/London'), true) // 07:30 BST, before the 08:00 cut-off
  assert.equal(overnight('2026-07-01T07:30:00Z', 'Europe/London'), false) // 08:30 BST
  assert.equal(overnight('2026-10-26T12:00:00Z', 'Europe/London'), false)
  const t = parseTouchLog('# at,minutes,note\n2026-10-26T08:00:00Z,6,approved 2 plans\nbad line\n2026-10-20T08:00:00Z,9,old')
  assert.equal(t.length, 2)
  const s = summarise([{ number: 1, title: 'Revert "x"', createdAt: '2026-10-25T22:00:00Z', mergedAt: '2026-10-26T08:00:00Z', additions: 5, deletions: 5, labels: [{ name: 'chb:automerged' }] }], t, new Date('2026-10-21T00:00:00Z'), 'Europe/London', { crap: 3, dry: 1, mutate: 0 }, { crap: 5, dry: 1, mutate: 2 })
  assert.deepEqual([s.merged, s.leadHoursMedian, s.autoMerged, s.reverts, s.overnight, s.handsOnMinutes], [1, 10, 1, 1, 1, 6])
})

test('dispatch: plan stops at the human gate; build refuses without approval; audit plans one fix', () => {
  const p = planPrompt('.rig/product/sprints/sprint-1/intents/cart.md')
  assert.match(p, /^\/rig:start \.rig\/product/); assert.match(p, /Never run \/rig:approve/); assert.match(p, /CHB-RESULT kind=plan/)
  assert.match(p, /do not answer it yourself: write it under `## Open questions`/)
  const b = buildPrompt('cart')
  assert.match(b, /approval\.json is present; if it is missing, stop/); assert.match(b, /Never edit \.rig\/ub-baseline\.json/)
  assert.match(auditPrompt('main', false), /Make no code changes in this step/)
  assert.doesNotMatch(auditPrompt('main', false), /gate mutate/)
  assert.deepEqual(command('x', false), ['claude', '--cloud', 'x']); assert.deepEqual(command('x', true), ['claude', '-p', 'x'])
})

test('install: sensors appended once, existing ids kept unless forced; ignore lines deduplicated', () => {
  const base = JSON.stringify({ stack: 'node', sensors: [{ id: 'lint', cmd: 'eslint' }, { id: 'ub-dry', cmd: 'mine' }], knownRed: [] })
  const m = mergeSensors(base, false)
  assert.deepEqual(m.kept, ['ub-dry']); assert.equal(m.added.length, SENSORS.length - 1)
  const j = JSON.parse(m.text)
  assert.equal(j.sensors.length, 1 + SENSORS.length); assert.equal(j.stack, 'node'); assert.deepEqual(j.knownRed, [])
  assert.equal(JSON.parse(mergeSensors(base, true).text).sensors.find((s: any) => s.id === 'ub-dry').cmd.includes('gate dry'), true)
  // rig's check never runs "nightly", so no ub sensor may use it
  assert.ok(SENSORS.every(s => s.cadence !== 'nightly' && s.blocks === false))
  assert.equal(appendLines('node_modules/\n.metrics/\n', ['.metrics/', 'x/'], '# h'), 'node_modules/\n.metrics/\n\n# h\nx/\n')
  assert.equal(appendLines('a\n', ['a'], '# h'), 'a\n')
})
