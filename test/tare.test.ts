// Tare's checkable lines, on real git repos: each check's catch, its false-positive guards, settings read from the base,
// what is judged (the index, not the working tree), odd paths and git configs, CI's detached checkout, and the fix line and
// count. Plus chb nightly, the dispatch round cap, the reviewer, and the gates' fix lines.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { depsOf, globToRe } from '../src/tare.ts'
import { buildsSoFar, reviewPrompt, buildPrompt, command, MAX_ROUNDS } from '../src/dispatch.ts'
import { formatVerdict } from '../src/judge.ts'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
const { GITHUB_HEAD_REF: _h, GITHUB_BASE_REF: _b, ...ENV } = process.env
const chb = (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args], { cwd, encoding: 'utf8', env: { ...ENV, CHB_BASE: 'main', ...env } })
const sh = (cmd: string, cwd: string) => { const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
const write = (root: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c) } }
const GIT = 'git -c user.name=t -c user.email=t@t -c commit.gpgsign=false'
const stage = (dir: string, files: Record<string, string>) => { write(dir, files); sh('git add -A', dir) }
const commit = (dir: string, msg: string, files: Record<string, string>) => { stage(dir, files); sh(`${GIT} commit -q --allow-empty -m "${msg}"`, dir); return sh('git rev-parse --short HEAD', dir) }
const last = (s: string) => Number(s.trim().split('\n').pop())
const tare = (check: string, dir: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) => chb(['tare', check, ...extra], dir, env)

function repo(files: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tare-'))
  sh('git init -q -b main', dir)
  commit(dir, 'init', { 'src/a.js': 'export const a = 1\n', 'package.json': '{"dependencies":{"left-pad":"1"}}\n', ...files })
  sh('git switch -q -c sdlc/x', dir)
  return dir
}

test('placeholders: comment markers and stubs in what is being committed; tests, abstract methods, masks and unstaged work exempt', () => {
  const dir = repo({ 'src/old.js': '// TODO: legacy, not ours\n' })
  commit(dir, 'work', {
    'src/b.js': 'export function b() {\n  // TODO handle errors\n  throw new Error("not implemented")\n}\nconst ssn = "XXX-XX-XXXX"\n',
    'src/c.py': 'def c():\n    raise NotImplementedError\n',
    'src/base.py': 'class Base(ABC):\n    @abstractmethod\n    def run(self):\n        raise NotImplementedError\n',
    'test/b.test.py': 'with pytest.raises(NotImplementedError):\n    c()\n',
    'README.md': 'TODO: docs are fine\n',
  })
  write(dir, { 'src/scratch.go': 'func x() { panic("TODO") }\n', 'src/a.js': 'export const a = 1 // FIXME unstaged\n' })
  const r = tare('placeholders', dir)
  assert.equal(r.status, 1)
  assert.equal(last(r.stdout), 3, r.stdout)
  assert.match(r.stdout, /BLOCK placeholders src\/b\.js:2: a TODO-style marker/)
  assert.match(r.stdout, /src\/b\.js:3: a stub/); assert.match(r.stdout, /src\/c\.py:2: a stub/)
  assert.match(r.stdout, /fix: do it now, or delete the marker/)
  for (const no of [/old\.js/, /README/, /base\.py/, /b\.test\.py/, /scratch\.go/, /src\/a\.js/, /:5:/]) assert.doesNotMatch(r.stdout, no)
  sh('git add src/a.js', dir)
  assert.equal(last(tare('placeholders', dir).stdout), 4, 'staged now: judged')
})

test('placeholders: settings come from the base, so a change cannot loosen its own check; bad regexes are notes, not crashes', () => {
  const dir = repo({ '.rig/tare.json': JSON.stringify({ placeholders: { ignore: ['raise NotImplementedError', '(broken'] } }) })
  commit(dir, 'w', { 'src/c.py': 'def c():\n    raise NotImplementedError\n', 'src/d.js': '// TODO x\n' })
  const r = tare('placeholders', dir)
  assert.equal(last(r.stdout), 1, r.stdout); assert.match(r.stdout, /note {2}\.rig\/tare\.json placeholders\.ignore: "\(broken" is not a valid regex/)
  commit(dir, 'loosen', { '.rig/tare.json': JSON.stringify({ placeholders: { ignore: ['.*'] } }) })
  assert.equal(last(tare('placeholders', dir).stdout), 1, 'the branch edited tare.json: ignored')
})

test('placeholders: paths with spaces and non-ASCII names, and diff.noprefix, are still judged', () => {
  const dir = repo()
  sh('git config diff.noprefix true && git config diff.mnemonicPrefix true && git config core.quotePath true', dir)
  commit(dir, 'w', { 'src/a b.py': '# TODO one\n', 'src/é.py': '# FIXME two\n' })
  const r = tare('placeholders', dir)
  assert.equal(last(r.stdout), 2, r.stdout); assert.match(r.stdout, /src\/a b\.py:1/); assert.match(r.stdout, /src\/é\.py:1/)
})

test('frozen-tests: reproduction committed first, then never edited, including the commit being made', () => {
  const dir = repo()
  commit(dir, 'test: reproduce', { 'test/a.test.js': 'expect a == 2\n' })
  commit(dir, 'fix: a', { 'src/a.js': 'export const a = 2\n' })
  assert.equal(last(tare('frozen-tests', dir, ['--type', 'bugfix']).stdout), 0)
  commit(dir, 'tweak', { 'test/a.test.js': 'expect a == 3\n', 'src/a.js': 'export const a = 3\n' })
  const r = tare('frozen-tests', dir, ['--type', 'bugfix'])
  assert.equal(r.status, 1); assert.match(r.stdout, /frozen test edited in \w{8}, after it was committed in \w{8}/)
  assert.match(r.stdout, /fix: change the code to make the test pass, not the test/)
  stage(dir, { 'test/a.test.js': 'expect anything\n' })
  assert.match(tare('frozen-tests', dir, ['--type', 'refactor']).stdout, /frozen test edited in the commit being made/)
  write(dir, { 'test/a.test.js': 'unstaged edit\n' }); sh('git restore --staged test/a.test.js', dir)
  assert.equal(last(tare('frozen-tests', dir, ['--type', 'refactor']).stdout), 1, 'unstaged edits are not the commit')
  assert.equal(last(tare('frozen-tests', dir, ['--type', 'feature']).stdout), 0, 'features grow their tests')

  const together = repo()
  stage(together, { 'test/a.test.js': 'x\n', 'src/a.js': 'export const a = 2\n' })
  assert.match(tare('frozen-tests', together, ['--type', 'bugfix']).stdout, /source changes in the commit being made with no a test that reproduces the bug committed before them/)

  const fixFirst = repo()
  commit(fixFirst, 'fix', { 'src/a.js': 'export const a = 2\n' })
  commit(fixFirst, 'test', { 'test/a.test.js': 'x\n' })
  assert.match(tare('frozen-tests', fixFirst, ['--type', 'bugfix']).stdout, /source changes in \w{8} with no a test/)
})

test('frozen-tests and deps: the change is found from the PR branch in CI\'s detached checkout', () => {
  const dir = repo()
  commit(dir, 'plan', { '.rig/changes/x/intent.md': '---\ntype: bugfix\n---\nParse dates with date-fns.\n' })
  commit(dir, 'fix', { 'src/a.js': 'export const a = 9\n', 'package.json': '{"dependencies":{"left-pad":"1","date-fns":"3"}}\n' })
  sh('git checkout -q --detach', dir)
  const ci = { GITHUB_HEAD_REF: 'sdlc/x' }
  assert.match(tare('frozen-tests', dir, [], ci).stdout, /\(bugfix change x\)[\s\S]*no a test that reproduces the bug/)
  assert.equal(last(tare('deps', dir, [], ci).stdout), 0, 'date-fns is in the brief')
  assert.equal(last(tare('deps', dir).stdout), 1, 'without the PR branch there is no brief')
})

test('deps: new direct dependencies must be named in the brief (intent or spec) or allowed on the base', () => {
  const dir = repo({ '.rig/changes/x/intent.md': '---\ntype: feature\n---\nAdd date parsing with date-fns. Uses typing_extensions.\n', '.rig/state/active': 'x\n', 'requirements.txt': 'flask==3\n', '.rig/tare.json': JSON.stringify({ deps: { allow: ['Requests'] } }) })
  commit(dir, 'deps', {
    'package.json': '{"dependencies":{"left-pad":"1","date-fns":"3","@acme/ui":"workspace:*"},"devDependencies":{"lodash":"4"}}\n',
    'requirements.txt': 'flask==3\nrequests>=2  # http\ntyping-extensions\nleftover\n', 'package-lock.json': '{"packages":{"node_modules/anything":{}}}\n',
    'test/fixtures/app/package.json': '{"dependencies":{"express":"4"}}\n',
    '.rig/changes/x/plan.md': '## Decisions\n- use leftover\n',
  })
  const r = tare('deps', dir)
  assert.equal(last(r.stdout), 2, r.stdout)
  assert.match(r.stdout, /package\.json: new dependency lodash/); assert.match(r.stdout, /requirements\.txt: new dependency leftover/)
  for (const no of [/date-fns/, /left-pad/, /anything/, /@acme/, /express/, /requests/, /typing/]) assert.doesNotMatch(r.stdout, no)
})

test('deps: manifest parsers', () => {
  assert.deepEqual([...depsOf('pyproject.toml', '[project]\nname = "x"\ndependencies = [\n  "requests[socks]>=2",\n  "httpx>=0.27",  # comment ]\n  "Pydantic_Core",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n[dependency-groups]\ntest = ["pytest-cov", {include-group = "lint"}]\n[tool.poetry.dependencies]\npython = "^3.12"\nrich = "*"\n')].sort(), ['httpx', 'pydantic-core', 'pytest', 'pytest-cov', 'requests', 'rich'])
  assert.deepEqual([...depsOf('go.mod', 'module m\nrequire github.com/a/b v1.0.0\nrequire (\n\tgolang.org/x/net v0.1.0 // indirect\n\tgithub.com/c/d v2.0.0\n)\n')].sort(), ['github.com/a/b', 'github.com/c/d'])
  assert.deepEqual([...depsOf('Cargo.toml', '[package]\nname = "x"\n[dependencies]\nserde = "1"\nanyhow.workspace = true\n[dev-dependencies]\ntokio = { version = "1" }\n[dependencies.rand]\nversion = "0.8"\n')].sort(), ['anyhow', 'rand', 'serde', 'tokio'])
  assert.deepEqual([...depsOf('requirements.txt', '-r base.txt\ngit+https://x/y.git\n./local\nDjango>=4 ; python_version>"3"\n')], ['django'])
  assert.equal(depsOf('package.json', 'not json').size, 0)
})

test('scope: secret files, logs and root build output; fixtures, templates and lockfiles exempt; its own fix passes', () => {
  const dir = repo({ 'big.lock.dir/.keep': '' })
  commit(dir, 'stray', {
    '.env': 'KEY=1\n', '.env.production': 'X=1\n', '.env.local.example': 'KEY=\n', 'debug.log': 'x\n', 'dist/bundle.js': '1\n',
    'build/ci/Dockerfile': 'FROM x\n', 'src/coverage/report.ts': 'x\n', 'tests/fixtures/server.key': 'k\n', 'docs/note.md': 'n\n',
    'package-lock.json': 'x'.repeat(1_200_000), 'assets/video.bin': 'x'.repeat(1_200_000),
  })
  const r = tare('scope', dir)
  assert.equal(last(r.stdout), 5, r.stdout)
  for (const f of ['.env', '.env.production', 'debug.log', 'dist/bundle.js']) assert.match(r.stdout, new RegExp(`BLOCK scope ${f.replace(/\./g, '\\.')}: a file that never belongs`))
  assert.match(r.stdout, /assets\/video\.bin: a 1\.2 MB file/)
  for (const no of [/example/, /Dockerfile/, /coverage/, /server\.key/, /note\.md/, /package-lock/]) assert.doesNotMatch(r.stdout, no)
  // Following the fix line clears the finding: the commit being made no longer has the file.
  sh('git rm -q --cached .env .env.production debug.log assets/video.bin && git rm -q -r --cached dist', dir)
  assert.equal(last(tare('scope', dir).stdout), 0)
  const allowed = repo({ '.rig/tare.json': JSON.stringify({ scope: { allow: ['^dist/'], stray: ['^build/'] } }) })
  commit(allowed, 'w', { 'dist/bundle.js': '1\n', 'build/out.js': '1\n' })
  const a = tare('scope', allowed).stdout
  assert.doesNotMatch(a, /dist\/bundle/); assert.match(a, /build\/out\.js/)
  assert.ok(globToRe('src/**').test('src/a/b.ts') && globToRe('src/*.ts').test('src/a.ts') && !globToRe('src/*.ts').test('src/a/b.ts') && globToRe('dist/').test('dist/x/y.js'))
})

test('tare all: sums the checks and writes a result; no base or a first commit is reported, not a crash', () => {
  const dir = repo()
  commit(dir, 'w', { 'src/b.js': '// FIXME\n', 'x.log': '1\n' })
  const r = tare('all', dir)
  assert.equal(last(r.stdout), 2); assert.ok(fs.existsSync(path.join(dir, '.rig/ub/results/tare-all.json')))
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'nobase-')); sh(`git init -q -b trunk && ${GIT} commit -q --allow-empty -m x`, orphan)
  const nb = tare('all', orphan, [], { CHB_BASE: '' })
  assert.equal(nb.status, 0); assert.match(nb.stdout, /not judged: no base branch found/)
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'unborn-')); sh('git init -q -b main', fresh); write(fresh, { 'a.log': 'x' }); sh('git add -A', fresh)
  assert.match(tare('all', fresh).stdout, /not judged: first commit/)
})

test('chb nightly: like rig, skips disabled sensors, warns on known red, runs {files} on the whole tree', () => {
  const dir = repo({ '.rig/sensors.json': JSON.stringify({ knownRed: ['red'], sensors: [
    { id: 'mut', cmd: 'echo survived {files}; exit 3', cadence: 'nightly', blocks: false },
    { id: 'red', cmd: 'exit 1', cadence: 'nightly', blocks: true },
    { id: 'off', cmd: 'exit 1', cadence: 'nightly', blocks: true, enabled: false },
    { id: 'ok', cmd: 'true', cadence: 'nightly', blocks: true },
    { id: 'lint', cmd: 'exit 1', cadence: 'commit', blocks: true },
  ] }) })
  const r = chb(['nightly'], dir)
  assert.equal(r.status, 0, r.stdout); assert.match(r.stdout, /nightly: 3 sensor\(s\), 2 failed/)
  assert.match(r.stdout, /warn mut[\s\S]*survived \./); assert.match(r.stdout, /warn red \(known red\)/)
  assert.doesNotMatch(r.stdout, /lint|off/)
  write(dir, { '.rig/sensors.json': JSON.stringify({ sensors: [{ id: 'mut', cmd: 'exit 3', cadence: 'nightly', blocks: true }] }) })
  assert.equal(chb(['nightly'], dir).status, 1)
  write(dir, { '.rig/sensors.json': '{ broken' })
  assert.match(chb(['nightly'], dir).stderr, /not valid JSON/)
})

test('dispatch: two build sessions per change and repo, a reviewer without edit tools, round cap in the prompt', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chbhome-')), log = path.join(home, 'dispatch.jsonl')
  fs.writeFileSync(log, [{ kind: 'build', slug: 'cart', repo: 'https://github.com/o/r' }, { kind: 'build', slug: 'cart', dir: 'https://github.com/o/r' }, { kind: 'build', slug: 'other', repo: 'https://github.com/o/r' }, { kind: 'plan', repo: 'https://github.com/o/r' }].map(x => JSON.stringify(x)).join('\n') + '\nnot json\n')
  assert.equal(buildsSoFar(log, 'cart', 'https://github.com/o/r'), 2); assert.equal(buildsSoFar(log, 'cart', 'https://github.com/o/other'), 0)
  assert.match(buildPrompt('cart'), new RegExp(`at most ${MAX_ROUNDS} rounds; then stop and report status=needs-human`))
  assert.match(buildPrompt('cart'), /tare all/)
  assert.match(reviewPrompt('cart', 'main'), /you did not write.*do not edit any code/s)
  assert.deepEqual(command('p', true, true), ['claude', '-p', 'p', '--disallowedTools', 'Edit', 'MultiEdit', 'NotebookEdit'])
  assert.deepEqual(command('p', false, true), ['claude', '--cloud', 'p'])
  // The cap is enforced before anything starts: a third --go for the same change in the same repo is refused.
  const clone = repo({ '.rig/sensors.json': '{"sensors":[]}' })
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-')) + '/r.git'
  sh(`git init -q --bare ${origin} && git remote add origin ${origin} && git push -q origin HEAD:refs/heads/sdlc/cart`, clone)
  fs.appendFileSync(log, [1, 2].map(() => JSON.stringify({ kind: 'build', slug: 'cart', repo: origin.replace(/\.git$/, '') })).join('\n') + '\n')
  const third = chb(['dispatch', 'build', 'cart', '--repo-dir', clone, '--go'], clone, { CHB_HOME: home })
  assert.equal(third.status, 1); assert.match(third.stderr, /cart: 2 build session\(s\) already dispatched\. It needs a person now/)
  const dry = chb(['dispatch', 'review', 'cart', '--repo-dir', clone, '--local'], clone, { CHB_HOME: home })
  assert.match(dry.stdout, /\)" --disallowedTools Edit MultiEdit NotebookEdit$/m)
})

test('gates: every blocking finding carries a fix line', () => {
  const s = formatVerdict({ gate: 'crap', findings: [{ gate: 'crap', key: 'a.py:f', level: 'new', value: 30, baseline: null, message: 'a.py:f CRAP 30' }, { gate: 'crap', key: 'b.py:g', level: 'legacy', value: 40, baseline: 40, message: 'b.py:g CRAP 40' }], blocking: 1, total: 2, notes: [] })
  assert.equal((s.match(/fix: add tests/g) ?? []).length, 1)
})
