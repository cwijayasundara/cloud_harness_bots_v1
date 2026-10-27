// Phase 3: rig's per-repo lessons read together (port proven rules, propose Tare lines, record more evidence), and the
// Tare log, status, sync and variants that keep Tare honest. Real files in temp dirs; rig's own formats.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseRigLessons, parseCandidates, propose, gather, cluster, similarity, covers, tareLines } from '../src/lessons.ts'
import { parseLog, status, variants } from '../src/tarekit.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHB = path.join(ROOT, 'bin/chb.ts')
const TARE = path.join(ROOT, 'skills/tare/SKILL.md')
const chb = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args], { encoding: 'utf8' })
const write = (root: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c) } }
const lesson = (id: string, text: string, key: string, seen: string, status = 'active') => `- ${id} | ${text} | key: ${key} | seen: ${seen} | first 2026-09-01 | last-fired 2026-10-01 | ${status}`

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'))
  write(ws, {
    'shop/.rig/lessons.md': ['# Lessons', lesson('L1', 'Never mock the database in integration tests; use the test container', 'tests', 'cart, refunds'), lesson('L3', 'Only shop has this one about invoice rounding', 'correctness', 'inv-a, inv-b'), lesson('L9', 'Old retired advice about mocking databases', 'tests', 'a, b', 'retired')].join('\n'),
    'shop/.rig/lessons-archive.md': lesson('L2', 'Remove console.log debugging before commit', 'correctness', 'a1, a2', 'promoted:no-console'),
    'shop/.rig/learn/candidates.json': JSON.stringify({ candidates: [{ key: 'tests', kind: 'finding', changes: ['x1', 'x2'], count: 2, sample: 'TODO left in code instead of finishing the handler', rung: 'rule' }] }),
    'billing/.rig/lessons.md': [lesson('L4', 'Do not mock the database in integration tests', 'tests', 'pay, ledger'), lesson('L5', 'Remove console.log statements before committing', 'correctness', 'b1, b2'), lesson('L6', 'TODO markers left in code', 'tests', 'b3, b4')].join('\n'),
    'notrig/README.md': 'not a rig repo\n',
  })
  return ws
}

test('lessons: rig formats are read, malformed and retired lines are left out', () => {
  const ls = parseRigLessons('r', [lesson('L1', 'x y z', 'tests', 'a, b'), '- L2 | broken line', '# heading'].join('\n'))
  assert.deepEqual(ls.map(l => [l.id, l.key, l.seen]), [['L1', 'tests', ['a', 'b']]])
  assert.deepEqual(parseCandidates('r', '{"candidates":[{"key":"k","kind":"finding","changes":["a","b"],"sample":"s","rung":"test"}]}').map(c => c.rung), ['test'])
  assert.deepEqual(parseCandidates('r', 'not json'), [])
  assert.ok(similarity('Never mock the database in integration tests', 'Do not mock the database in integration tests') > 0.5)
  assert.ok(similarity('Never mock the database', 'Invoice rounding uses banker\'s rounding') === 0)
  assert.ok(covers('TODO markers left in code', 'No TODOs, stubs or placeholder implementations in a PR.') >= 0.3)
  assert.equal(covers('Never mock the database in integration tests', 'Bugfix: write a test that reproduces the bug on the base branch and commit it before the fix.'), 0)
})

test('lessons: across repos, a proven rule is ported, a shared lesson becomes a Tare line, a covered one is more evidence', () => {
  const ws = workspace()
  const items = gather([path.join(ws, 'billing'), path.join(ws, 'shop')])
  const ps = propose(items, tareLines(fs.readFileSync(TARE, 'utf8')))
  const kinds = ps.map(p => `${p.kind}:${p.repos.join('+')}`)
  assert.deepEqual(kinds, ['PORT:billing+shop', 'TARE:billing+shop', 'SEEN:billing+shop'])
  assert.equal(ps[0]!.rule, 'no-console'); assert.equal(ps[0]!.from, 'shop'); assert.deepEqual(ps[0]!.to, ['billing'])
  assert.equal(ps[1]!.text, 'Do not mock the database in integration tests'); assert.match(ps[1]!.evidence.join(';'), /shop:L1 \(active; seen cart, refunds\)/)
  assert.match(ps[2]!.tareLine!, /^No TODOs/)
  assert.ok(!ps.some(p => /invoice|retired/i.test(p.text)), 'one repo, or retired: not proposed')
  assert.equal(cluster(items.filter(i => i.status !== 'retired')).length, 4, 'mock pair, console pair, TODO pair, invoice alone')
})

test('chb lessons: --workspace finds the rig repos and writes the proposal file', () => {
  const ws = workspace(), outFile = path.join(ws, 'tare-proposal.md')
  const r = chb(['lessons', '--workspace', ws, '--tare', TARE, '--out', outFile])
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /3 proposal\(s\) from 2 repo\(s\)/)
  const md = fs.readFileSync(outFile, 'utf8')
  assert.match(md, /\*\*PORT\*\* rule `no-console` from shop to billing/); assert.match(md, /\*\*TARE\*\* add: "Do not mock the database/); assert.match(md, /\*\*SEEN\*\* again/)
  assert.match(chb(['lessons', '--repos', path.join(ws, 'notrig')]).stderr, /not a rig repo/)
})

test('tare log: every v1 line is traced; status finds untraced lines, stale entries, removable lines and drift', () => {
  const tare = fs.readFileSync(TARE, 'utf8'), log = fs.readFileSync(path.join(ROOT, 'skills/tare/log.md'), 'utf8')
  const entries = parseLog(log)
  assert.equal(entries.find(e => e.key === 'No TODOs')!.check, 'tare-placeholders'); assert.equal(entries.find(e => e.key === 'Proceed, then present')!.check, null)
  const clean = status(tare, log, [])
  assert.deepEqual(clean.untraced, []); assert.deepEqual(clean.staleLog, [])

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'))
  const sensors = (blocks: boolean) => JSON.stringify({ sensors: [{ id: 'tare-scope', blocks }, { id: 'tare-placeholders', blocks: true }] })
  write(ws, { 'a/.rig/sensors.json': sensors(true), 'b/.rig/sensors.json': sensors(false), 'a/.claude/skills/tare/SKILL.md': tare, 'b/.claude/skills/tare/SKILL.md': 'old\n' })
  const edited = tare.replace('## Words', '- Prefer boring technology.\n\n## Words')
  const s = status(edited, log + '- key: Gone rule | added 2026-10-01 | source: x | check: none\n', [path.join(ws, 'a'), path.join(ws, 'b'), path.join(ws, 'c')])
  assert.deepEqual(s.untraced, ['Prefer boring technology.']); assert.deepEqual(s.staleLog, ['Gone rule'])
  const scope = s.checks.find(c => c.check === 'tare-scope')!
  assert.deepEqual([scope.blocking, scope.advisory, scope.missing], [['a'], ['b'], ['c']])
  assert.deepEqual(s.drift.map(d => d.state), ['differs', 'differs', 'missing'])
  const two = status(tare, log, [path.join(ws, 'a')])
  assert.deepEqual(two.checks.filter(c => c.blocking.length === 1).map(c => c.check).sort(), ['tare-placeholders', 'tare-scope'])
  assert.match(chb(['tare', 'status', '--repos', path.join(ws, 'a')]).stdout, /removable "No TODOs[\s\S]*tare-placeholders blocks in all 1 repo/)
})

test('chb tare sync: dry run lists drift; --write makes every copy the canonical one', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'))
  write(ws, { 'a/.rig/x': '', 'b/.rig/x': '', 'b/.claude/skills/tare/SKILL.md': fs.readFileSync(TARE, 'utf8') })
  const dry = chb(['tare', 'sync', '--workspace', ws])
  assert.match(dry.stdout, /differs\s+a[\s\S]*same\s+b[\s\S]*Dry run/)
  assert.ok(!fs.existsSync(path.join(ws, 'a/.claude/skills/tare/SKILL.md')))
  assert.match(chb(['tare', 'sync', '--workspace', ws, '--write']).stdout, /written\s+a/)
  assert.equal(fs.readFileSync(path.join(ws, 'a/.claude/skills/tare/SKILL.md'), 'utf8'), fs.readFileSync(TARE, 'utf8'))
})

test('chb tare variants: one Tare per removed rule, continuation lines included, and replay arms that use them', () => {
  const vs = variants('---\nname: t\n---\n# t\n- one\n  continued\n- two\n## x\n- three\n')
  assert.deepEqual(vs.map(v => v.line), ['one continued', 'two', 'three'])
  assert.equal(vs[0]!.text, '---\nname: t\n---\n# t\n- two\n## x\n- three\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'var-'))
  const r = chb(['tare', 'variants', '--out', dir])
  assert.equal(r.status, 0, r.stderr)
  const arms = JSON.parse(fs.readFileSync(path.join(dir, 'arms.json'), 'utf8')) as { name: string; tare: string }[]
  assert.equal(arms.length, tareLines(fs.readFileSync(TARE, 'utf8')).length + 1)
  assert.equal(arms[0]!.name, 'tare-full'); assert.ok(arms.every(a => fs.existsSync(a.tare)))
  assert.ok(!fs.readFileSync(arms[1]!.tare, 'utf8').includes('Read brain/index.md'))
  // chb replay refuses an arm whose Tare file is missing, before running anything.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'))
  spawnSync('sh', ['-c', 'git init -q -b main && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m x'], { cwd: repo })
  write(repo, { 'replay/tasks.json': JSON.stringify({ version: 1, repo: null, built: '', testCmd: 'true', tasks: [{ id: 't', title: 't', type: 'bugfix', prompt: 'p', base: 'x', solution: 'y', hidden: ['a'], size: { files: 1, added: 1, deleted: 0 }, valid: true }] }), 'arms.json': JSON.stringify([{ name: 'gone', tare: '/nonexistent.md', prompt: '{task}' }]) })
  const rr = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, 'replay', 'run', '--arms', 'arms.json', '--dry-run'], { cwd: repo, encoding: 'utf8' })
  assert.match(rr.stderr, /arm gone: Tare file \/nonexistent\.md not found/)
})
