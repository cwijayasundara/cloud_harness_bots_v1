// End-to-end over the GitHub glue with a recording fake `gh` on PATH that serves repo-scoped REST endpoints, keyed by
// "<METHOD> <path without query>" (the --jq projection is applied by the fake's fixtures, as gh would print it).
// Covers: the exact endpoints chb calls, the proof fetch, the "only proof.json after the proof" compare, label moves,
// paginated file lists with rename sources, and the head-guarded merge.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
const R = 'repos/o/r'

const proof = (head: string | null, pass = true, type = 'refactor') => ({ version: 1, slug: 'x', type, at: '', head, base: 'main', verify: { pass: true, at: '', blocks: [], fresh: true }, gates: { crap: null, dry: null, mutate: null }, review: { verdict: 'pass', openHigh: 0, open: 0 }, diff: { files: 1, added: 10, deleted: 5 }, pass, reasons: pass ? [] : ['crap gate: 1 blocking finding(s)'] })

type Spec = { n: number; branch: string; sha: string; labels?: string[]; checks?: string[]; failing?: string[]; state?: string; changed?: number; reviews?: { user: string; state: string }[]; files?: string[]; proof?: unknown; compare?: Record<string, unknown> }
const nd = (xs: unknown[]) => xs.map(x => JSON.stringify(x)).join('\n') + (xs.length ? '\n' : '')

function server(specs: Spec[]): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  const listed = (s: Spec) => ({ number: s.n, title: `refactor: pr ${s.n}`, url: `https://github.com/o/r/pull/${s.n}`, branch: s.branch, sha: s.sha, draft: false, updated: new Date().toISOString(), labels: s.labels ?? [] })
  r[`GET ${R}/pulls`] = nd(specs.map(listed))
  for (const s of specs) {
    r[`GET ${R}/pulls/${s.n}`] = { ...listed(s), mergeable: s.state === 'dirty' ? false : true, state: s.state ?? 'clean', additions: 10, deletions: 5, changed: s.changed ?? (s.files?.length ?? 1) }
    r[`GET ${R}/pulls/${s.n}/reviews`] = nd(s.reviews ?? [{ user: 'ck', state: 'APPROVED' }])
    r[`GET ${R}/commits/${s.sha}/check-runs`] = nd([...(s.checks ?? ['rig-check']).map(name => ({ name, status: 'completed', conclusion: 'success' })), ...(s.failing ?? []).map(name => ({ name, status: 'completed', conclusion: 'failure' }))])
    r[`GET ${R}/commits/${s.sha}/status`] = ''
    r[`GET ${R}/pulls/${s.n}/files`] = (s.files ?? ['src/a.ts']).join('\n') + '\n'
    const slug = s.branch.replace(/^sdlc\//, '')
    r[`GET ${R}/contents/.rig/changes/${slug}/proof.json`] = s.proof === undefined ? 404 : s.proof
    for (const [k, v] of Object.entries(s.compare ?? {})) r[`GET ${R}/compare/${k}`] = v
  }
  return r
}

function fakeGh(responses: Record<string, unknown>): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh-'))
  const log = path.join(dir, 'calls.jsonl')
  fs.writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses))
  fs.writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path')
const args = process.argv.slice(2), dir = ${JSON.stringify(dir)}
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n')
if (args[0] !== 'api') { process.stderr.write('graphql-backed gh command used: ' + args.join(' ')); process.exit(9) }
const x = args.indexOf('-X'), method = x >= 0 ? args[x + 1] : 'GET'
const ep = args.find(a => a.startsWith('repos/')).split('?')[0]
if (method !== 'GET') process.exit(0)
const r = JSON.parse(fs.readFileSync(path.join(dir, 'responses.json'), 'utf8'))
const v = r[method + ' ' + ep]
if (v === undefined || v === 404) { process.stderr.write('HTTP 404: ' + ep); process.exit(1) }
process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
`, { mode: 0o755 })
  return { dir, log }
}

const run = (args: string[], ghDir: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` } })
const calls = (log: string) => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as string[])
const writes = (log: string) => calls(log).filter(c => c.includes('-X')).map(c => `${c[c.indexOf('-X') + 1]} ${c.find(a => a.startsWith('repos/'))}${c.filter(a => a.startsWith('labels[]=') || a.startsWith('sha=')).map(a => ' ' + a).join('')}`)

test('ledger over REST: classifies from proof.json, accepts proof-only commits, moves labels, never uses GraphQL', () => {
  const { dir, log } = fakeGh(server([
    { n: 1, branch: 'sdlc/ok', sha: 'a000001', proof: proof('a000001') },                                         // ready
    { n: 2, branch: 'sdlc/later', sha: 'c000003', labels: ['chb:working'], proof: proof('b000002'),                // proof.json-only commit after → ready
      compare: { 'b000002...c000003': { status: 'ahead', files: ['.rig/changes/later/proof.json'] } } },
    { n: 3, branch: 'sdlc/code-after', sha: 'e000005', proof: proof('d000004'),                                    // code after → stale
      compare: { 'd000004...e000005': { status: 'ahead', files: ['.rig/changes/code-after/proof.json', 'src/x.ts'] } } },
    { n: 4, branch: 'sdlc/failing', sha: 'f000006', proof: proof('f000006', false) },                              // proof fails → blocked
    { n: 5, branch: 'feature/manual', sha: 'a000007' },                                                             // not rig → missing
    { n: 6, branch: 'sdlc/forged', sha: 'a000008', proof: proof(null) },                                            // no head → stale
    { n: 7, branch: 'sdlc/review-edited', sha: 'a00000a', proof: proof('a000009'),                                  // review.md after → stale
      compare: { 'a000009...a00000a': { status: 'ahead', files: ['.rig/changes/review-edited/review.md', '.rig/changes/review-edited/proof.json'] } } },
    { n: 8, branch: 'sdlc/conflict', sha: 'a00000b', state: 'dirty', proof: proof('a00000b') },                    // conflict → blocked
    { n: 9, branch: 'sdlc/ci-red', sha: 'a00000c', failing: ['ub-gates'], proof: proof('a00000c') },               // red check → blocked
    { n: 10, branch: 'sdlc/asked', sha: 'a00000d', proof: proof('a00000d'),                                         // changes requested → blocked
      reviews: [{ user: 'ck', state: 'APPROVED' }, { user: 'rev', state: 'CHANGES_REQUESTED' }] },
  ]))
  const r = run(['ledger', '--repo', 'o/r', '--labels', '--json'], dir)
  assert.equal(r.status, 0, r.stderr)
  const rows = JSON.parse(r.stdout).rows as { number: number; status: string; proof: string }[]
  assert.deepEqual(rows.map(x => [x.number, x.status, x.proof]), [
    [1, 'ready', 'pass'], [2, 'ready', 'pass'], [3, 'working', 'stale'], [4, 'blocked', 'fail'], [5, 'working', 'missing'],
    [6, 'working', 'stale'], [7, 'working', 'stale'], [8, 'blocked', 'pass'], [9, 'blocked', 'pass'], [10, 'blocked', 'pass']])
  assert.ok(calls(log).every(c => c[0] === 'api'), 'REST only')
  const w = writes(log)
  assert.ok(w.includes('POST repos/o/r/issues/2/labels labels[]=chb:ready'))
  assert.ok(w.includes('DELETE repos/o/r/issues/2/labels/chb%3Aworking'))
  assert.equal(w.filter(x => x.startsWith('DELETE')).length, 1, 'never removes a label the PR does not have')
})

test('merge over REST: dry by default; --go merges guarded by the head sha; refusals', () => {
  const ok: Spec = { n: 9, branch: 'sdlc/tidy', sha: 'abc1234', checks: ['rig-check', 'ub-gates'], files: ['src/a.ts', '.rig/changes/tidy/approval.json', '.rig/changes/tidy/proof.json'], proof: proof('abc1234') }
  let g = fakeGh(server([ok]))
  let r = run(['merge', '9', '--repo', 'o/r'], g.dir)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /AUTO-MERGE[\s\S]*dry run/)
  assert.deepEqual(writes(g.log), [])
  r = run(['merge', '9', '--repo', 'o/r', '--go'], g.dir)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(writes(g.log), ['POST repos/o/r/labels', 'POST repos/o/r/issues/9/labels labels[]=chb:automerged', 'PUT repos/o/r/pulls/9/merge sha=abc1234', 'DELETE repos/o/r/git/refs/heads/sdlc/tidy'])
  assert.ok(calls(g.log).some(c => c.includes('--paginate') && c.some(a => a.startsWith('repos/o/r/pulls/9/files'))))

  // moving a protected file away shows up through previous_filename
  g = fakeGh(server([{ ...ok, files: ['docs/old-gates.yml', '.github/workflows/ub-gates.yml'] }]))
  r = run(['merge', '9', '--repo', 'o/r', '--go'], g.dir)
  assert.equal(r.status, 1); assert.match(r.stdout, /protected paths: .*\.github\/workflows\/ub-gates\.yml/)

  // a tier-0 auto-build (no person approved its plan) is never also merged by no person
  g = fakeGh(server([{ ...ok, files: ['src/a.ts', '.rig/changes/tidy/proof.json'] }]))
  r = run(['merge', '9', '--repo', 'o/r', '--go'], g.dir)
  assert.equal(r.status, 1); assert.match(r.stdout, /no person approved its plan/)
  assert.ok(!writes(g.log).some(w => w.startsWith('PUT')), 'nothing merged')

  // a partial file list is refused, never judged
  g = fakeGh(server([{ ...ok, changed: 120 }]))
  r = run(['merge', '9', '--repo', 'o/r', '--go'], g.dir)
  assert.equal(r.status, 2); assert.match(r.stderr, /listed 3 of 120 files/)

  // without the ub-gates check the agent-written proof alone is not enough
  g = fakeGh(server([{ ...ok, checks: ['rig-check'] }]))
  r = run(['merge', '9', '--repo', 'o/r', '--go'], g.dir)
  assert.equal(r.status, 1); assert.match(r.stdout, /ub-gates has not run/)

  g = fakeGh(server([{ ...ok, proof: proof('abc1234', true, 'feature') }]))
  r = run(['merge', '9', '--repo', 'o/r', '--go'], g.dir)
  assert.equal(r.status, 1); assert.match(r.stdout, /a person merges this[\s\S]*type feature/)
  assert.ok(!writes(g.log).some(w => w.startsWith('PUT')))
})

test('report over REST: merged PRs in the window, lead time, auto-merges, reverts', () => {
  const now = Date.now(), iso = (h: number) => new Date(now - h * 36e5).toISOString()
  const closed = [
    { number: 21, title: 'refactor: a', created: iso(30), merged: iso(20), updated: iso(20), labels: ['chb:automerged'] },
    { number: 22, title: 'Revert "a"', created: iso(10), merged: iso(8), updated: iso(8), labels: [] },
    { number: 23, title: 'closed, not merged', created: iso(10), merged: null, updated: iso(9), labels: [] },
    { number: 24, title: 'merged long ago', created: iso(500), merged: iso(400), updated: iso(400), labels: [] },
  ]
  const r: Record<string, unknown> = { [`GET ${R}/pulls`]: nd(closed) }
  for (const p of closed) r[`GET ${R}/pulls/${p.number}`] = { additions: 3, deletions: 2 }
  const g = fakeGh(r)
  const out = run(['report', '--repo', 'o/r', '--days', '7', '--json'], g.dir)
  assert.equal(out.status, 0, out.stderr)
  const s = JSON.parse(out.stdout)
  assert.deepEqual([s.merged, s.leadHoursMedian, s.autoMerged, s.reverts, s.linesChanged], [2, 6, 1, 1, 10])
  assert.ok(calls(g.log).some(c => c.some(a => a.includes('pulls?state=closed&sort=updated'))))
})
