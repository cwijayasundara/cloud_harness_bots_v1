import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseEdn } from '../src/edn.ts'
import { readCrap, readDry, readMutate } from '../src/snapshots.ts'
import { judgeCrap, judgeDry, judgeMutate, buildBaseline, loosened, emptyBaseline, parseBaseline } from '../src/judge.ts'
import { changedSource, isSource, repoSource } from '../src/git.ts'

test('edn: the shapes the tools write, from their READMEs', () => {
  const crap = parseEdn('{:entries [{:name "place" :namespace "demo.Board" :complexity 3 :coverage 75.0 :crap 3.1} {:name "x" :namespace "n" :complexity 1 :coverage nil :crap nil}]}')
  assert.deepEqual(crap, { entries: [{ name: 'place', namespace: 'demo.Board', complexity: 3, coverage: 75, crap: 3.1 }, { name: 'x', namespace: 'n', complexity: 1, coverage: null, crap: null }] })
  const mut = parseEdn('{:version 1 :outcomes {"[\\"src/a.py\\",\\"a\\",\\"defn/f\\",10,11,\\">\\",\\">=\\"]" :survived} :forms [] ; comment\n #_ :ignored}')
  assert.equal((mut as any).outcomes['["src/a.py","a","defn/f",10,11,">",">="]'], 'survived')
  assert.deepEqual(parseEdn('#{1 2} '), [1, 2])
  assert.deepEqual(parseEdn('[-1.5e2 42N "a\\nb" \\c #inst "2026"]'), [-150, 42, 'a\nb', 'c', '2026'])
  assert.throws(() => parseEdn('{:a}'), /odd/)
  assert.throws(() => parseEdn('[1 2'), /missing/)
})

const fixture = (files: Record<string, string>): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-'))
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c) }
  return d
}

const SNAP = {
  '.metrics/crap.edn': '{:entries [{:name "big" :namespace "app.core" :complexity 6 :coverage 0.0 :crap 42.0} {:name "old" :namespace "app.core" :complexity 5 :coverage 10.0 :crap 23.2} {:name "ok" :namespace "app.core" :complexity 1 :coverage 100.0 :crap 1.0}]}',
  '.metrics/dry.edn': '{:candidates [{:score 0.95 :language "python" :left {:file "src/a.py" :start-line 1 :end-line 9} :right {:file "src/b.py" :start-line 3 :end-line 12}} {:score 0.81 :language "python" :left {:file "src/c.py" :start-line 1 :end-line 9} :right {:file "src/d.py" :start-line 1 :end-line 9}} {:score 0.5 :language "python" :left {:file "src/e.py" :start-line 1 :end-line 9} :right {:file "src/f.py" :start-line 1 :end-line 9}}]}',
  '.metrics/mutate/app.core.edn': '{:version 1 :source "src/app/core.py" :namespace "app.core" :forms [{:id "defn/big" :kind "defn" :file "src/app/core.py" :line 2 :end-line 9 :killed 3 :survived 2 :uncovered 1 :sites 6} {:id "defn/ok" :kind "defn" :killed 2 :survived 0 :uncovered 0 :sites 2}]}',
}

test('judges: new debt blocks, baseline debt warns, worse-than-baseline blocks', () => {
  const root = fixture(SNAP)
  const crap = readCrap(root), dry = readDry(root), mut = readMutate(root)
  assert.equal(crap.length, 3); assert.equal(dry.length, 3); assert.equal(mut.length, 2)

  const none = emptyBaseline()
  assert.deepEqual([judgeCrap(crap, none).blocking, judgeDry(dry, none).blocking, judgeMutate(mut, none).blocking], [2, 2, 1])

  const base = buildBaseline({ crap, dry, mutate: mut })
  assert.deepEqual(base.crap, { 'app.core#big': 42, 'app.core#old': 23.2 })
  assert.deepEqual(base.dry, { 'src/a.py|src/b.py': 1, 'src/c.py|src/d.py': 1 })
  assert.deepEqual(base.mutate, { 'app.core#defn/big': 2 })
  assert.equal(judgeCrap(crap, base).blocking, 0)
  assert.equal(judgeCrap(crap, base).total, 2)
  assert.equal(judgeDry(dry, base).blocking, 0)
  assert.equal(judgeMutate(mut, base).blocking, 0)

  const worse = crap.map(e => (e.name === 'old' ? { ...e, crap: 30 } : e))
  const v = judgeCrap(worse, base)
  assert.equal(v.blocking, 1)
  assert.match(v.findings.find(f => f.level === 'new')!.message, /worse than baseline 23.2/)
  // a second copy of an already-known duplicate pair is new
  assert.equal(judgeDry([...dry, dry[0]!], base).blocking, 1)
  // changed scope: only pairs touching a changed file
  assert.equal(judgeDry(dry, emptyBaseline(), 0.8, new Set(['src/d.py'])).total, 1)
  assert.equal(judgeMutate(mut, emptyBaseline(), new Set(['src/other.py'])).total, 0)
  assert.match(judgeMutate(mut, base).notes[0]!, /1 mutation site/)
})

test('loosened: added keys, raised values and relaxed thresholds; tightening is fine', () => {
  const a = parseBaseline(JSON.stringify({ thresholds: { crap: 10, dry: 0.8 }, crap: { 'n#f': 20 }, dry: {}, mutate: { 'n#defn/g': 2 } }))
  assert.deepEqual(loosened(a, { ...a, crap: { 'n#f': 12 }, mutate: {} }), [])
  assert.deepEqual(loosened(a, { ...a, thresholds: { crap: 15, dry: 0.8 }, crap: { 'n#f': 25, 'n#h': 11 } }), ['crap threshold raised 10 → 15', 'crap n#f raised 20 → 25', 'crap n#h added to the baseline (11)'])
})

test('changed source: committed and uncommitted work since the merge-base, tests excluded', () => {
  const root = fixture({ 'src/a.py': 'x = 1\n', 'README.md': '#\n' })
  const g = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  g('init', '-q', '-b', 'main'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root')
  g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base')
  g('checkout', '-q', '-b', 'work')
  fs.writeFileSync(path.join(root, 'src/b.py'), 'y = 2\n'); fs.mkdirSync(path.join(root, 'tests')); fs.writeFileSync(path.join(root, 'tests/test_b.py'), '')
  g('add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'b')
  fs.writeFileSync(path.join(root, 'src/a.py'), 'x = 3\n'); fs.writeFileSync(path.join(root, 'src/c.ts'), '')
  assert.deepEqual(changedSource('main', root), ['src/a.py', 'src/b.py', 'src/c.ts'])
  assert.equal(isSource('src/x.test.ts'), false)
  assert.equal(isSource('pkg/foo_test.go'), false)
  assert.equal(isSource('node_modules/x/index.js'), false)
  assert.equal(isSource('src/x.d.ts'), false)
  assert.equal(isSource('src/main.rs'), true)
  // whole-tree runs only see the repo's own source: an ignored .venv never reaches the tools
  fs.mkdirSync(path.join(root, '.venv/lib'), { recursive: true }); fs.writeFileSync(path.join(root, '.venv/lib/site.py'), '')
  fs.writeFileSync(path.join(root, '.gitignore'), '.venv/\n')
  assert.deepEqual(repoSource(root), ['src/a.py', 'src/b.py', 'src/c.ts'])
})

test('review fixes: no base fails loudly, nested mutate snapshots, overload keys, provenance, skip lists', async () => {
  const { untrustedReasons } = await import('../src/gate.ts')
  // a changed-scope gate must never fall back to "nothing changed"
  const lone = fixture({ 'src/a.py': '' })
  execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: lone })
  assert.throws(() => changedSource(null, lone), /no base branch/)
  assert.throws(() => changedSource('main', lone), /no merge-base/)
  // mutator writes Go and Rust namespaces into subdirectories
  const nested = fixture({ '.metrics/mutate/github.com/x/pkg.edn': '{:source "pkg/a.go" :namespace "github.com/x/pkg" :forms [{:id "defn/F" :file "pkg/a.go" :line 1 :end-line 5 :killed 0 :survived 3 :uncovered 0 :sites 3}]}' })
  assert.equal(judgeMutate(readMutate(nested), emptyBaseline()).blocking, 1)
  // overloads share a key: the baseline keeps the worst, so neither overload reads as "worse than baseline"
  const over = [{ namespace: 'p.C', name: 'f', complexity: 6, coverage: 0, crap: 42 }, { namespace: 'p.C', name: 'f', complexity: 5, coverage: 0, crap: 30 }]
  const b = buildBaseline({ crap: over })
  assert.equal(b.crap['p.C#f'], 42)
  assert.equal(judgeCrap(over, b).blocking, 0)
  // a result is proof only from a full default run on committed code
  const clean = { run: true, thresholds: { crap: 10, dry: 0.8 }, toolArgs: [] as string[], unscored: 0, dirty: [] as string[] }
  assert.deepEqual(untrustedReasons(clean, emptyBaseline()), [])
  assert.equal(untrustedReasons({ ...clean, run: false, thresholds: { crap: 1000, dry: 1 }, toolArgs: ['--no-coverage'], unscored: 4, dirty: ['src/a.py'] }, emptyBaseline()).length, 6)
  assert.deepEqual(untrustedReasons({ ...clean, toolArgs: ['--use-existing-coverage'] }, emptyBaseline()), [])
  // skip lists mirror crapper, but build output only at the root
  assert.equal(isSource('build/gen.py'), false)
  assert.equal(isSource('src/build/compiler.ts'), true)
  assert.equal(isSource('pkg/testdata/x.go'), false)
  assert.equal(isSource('src/__tests__/a.ts'), false)
  assert.equal(isSource('conftest.py'), false)
})
