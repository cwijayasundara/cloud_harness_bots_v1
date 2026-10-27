// chb replay end to end on a real git repo with scripted agents: tasks from commits, the fail→pass check, history-free
// workspaces, arm preparation (strip, Tare), hidden tests restored over an agent that tried to edit them, resumable runs,
// and the paired report. Plus the pure pieces: classification, usage parsing, the bootstrap verdicts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { changeType, isTestPath, isScoringConfig, usage, summarise, renderReport, testCommand, taskPrompt, carryOver, sh as spawnAsync, pool, resultFile, agentEnv, armPrompt, type Result } from '../src/replay.ts'
import { withTare, TARE_LINE, TARE_PATH } from '../src/dispatch.ts'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
// Without NODE_TEST_CONTEXT: a `node --test` started under this runner would report to it instead of exiting non-zero.
const { NODE_TEST_CONTEXT: _ctx, ...ENV } = process.env
const chb = (args: string[], cwd: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args], { cwd, encoding: 'utf8', env: ENV })
const sh = (cmd: string, cwd: string) => { const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
const write = (root: string, files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c) } }
const commit = (dir: string, msg: string, files: Record<string, string>) => { write(dir, files); sh(`git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m "${msg}"`, dir); return sh('git rev-parse HEAD', dir) }

const SUM_TEST = `import { test } from 'node:test'; import assert from 'node:assert'; import { sum } from '../src/sum.js'\ntest('empty', () => assert.equal(sum([]), 0))\n`

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-repo-'))
  sh('git init -q -b main', dir)
  commit(dir, 'init', {
    'package.json': '{"type":"module"}\n', 'src/sum.js': 'export const sum = xs => xs.reduce((a, b) => a + b)\n',
    'test/old.test.js': `import { test } from 'node:test'; import assert from 'node:assert'; import { sum } from '../src/sum.js'\ntest('two', () => assert.equal(sum([1, 2]), 3))\n`,
    'CLAUDE.md': '# repo notes\n', '.rig/sensors.json': '{"sensors":[]}\n',
  })
  const fix = commit(dir, 'fix: sum of an empty list is 0', { 'src/sum.js': 'export const sum = xs => xs.reduce((a, b) => a + b, 0)\n', 'test/sum.test.js': SUM_TEST })
  const docs = commit(dir, 'docs: readme', { 'README.md': 'hi\n' })
  const feat = commit(dir, 'feat: mean of a list\n\nAdds mean() next to sum().', {
    'src/mean.js': `import { sum } from './sum.js'\nexport const mean = xs => sum(xs) / xs.length\n`,
    'test/mean.test.js': `import { test } from 'node:test'; import assert from 'node:assert'; import { mean } from '../src/mean.js'\ntest('mean', () => assert.equal(mean([2, 4]), 3))\n`,
  })
  const weak = commit(dir, 'chore: tidy two', { 'src/two.js': 'export const two = 2\n', 'test/two.test.js': `import { test } from 'node:test'; import assert from 'node:assert'; import { sum } from '../src/sum.js'\ntest('again', () => assert.equal(sum([1, 1]), 2))\n` })

  // What the scripted agents use: the accepted source of each solution (tests excluded), and a log of what they saw.
  const sol = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-sol-')), log = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-log-'))
  for (const [id, sha] of [[`commit-${fix.slice(0, 10)}`, fix], [`commit-${feat.slice(0, 10)}`, feat]] as const) {
    fs.mkdirSync(path.join(sol, id)); sh(`git archive ${sha} src | tar -x -C ${path.join(sol, id)}`, dir)
  }
  const seen = `p="$(cat)"; n="$CHB_REPLAY_TASK-$CHB_REPLAY_ARM-$$"; printf '%s' "$p" > "${log}/$n.prompt"; find . -path ./.git -prune -o -print > "${log}/$n.files"; git rev-list --all --count > "${log}/$n.commits"`
  const usageLine = `echo '{"type":"result","is_error":false,"num_turns":4,"total_cost_usd":0.25,"usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":20}}'`
  write(sol, {
    'good.sh': `#!/bin/sh\n${seen}\ncp -R "${sol}/$CHB_REPLAY_TASK/." .\n${usageLine}\n`,
    'cheat.sh': `#!/bin/sh\n${seen}\nmkdir -p test && for f in sum mean; do printf "import { test } from 'node:test'\\ntest('ok', () => {})\\n" > test/$f.test.js; done\n${usageLine}\n`,
  })
  fs.chmodSync(path.join(sol, 'good.sh'), 0o755); fs.chmodSync(path.join(sol, 'cheat.sh'), 0o755)
  return { dir, fix, docs, feat, weak, sol, log }
}

test('replay: build → check → run → report on real commits with scripted agents', () => {
  const f = fixture()
  const b = chb(['replay', 'build', '--commits', [f.fix, f.docs, f.feat, f.weak].join(','), '--test-cmd', 'node --test {hidden}'], f.dir)
  assert.equal(b.status, 0, b.stderr)
  assert.match(b.stdout, /3 task\(s\), 3 new \(bugfix 1, feature 1, chore 1\)/)
  assert.match(b.stdout, /skipped commit-\w+: no test files changed/)
  const tf = JSON.parse(fs.readFileSync(path.join(f.dir, 'replay/tasks.json'), 'utf8'))
  const fixTask = tf.tasks.find((t: { type: string }) => t.type === 'bugfix')
  assert.deepEqual(fixTask.hidden, ['test/sum.test.js'])
  assert.equal(fixTask.base, sh(`git rev-parse ${f.fix}^1`, f.dir))

  const c = chb(['replay', 'check'], f.dir)
  assert.equal(c.status, 0, c.stderr)
  assert.match(c.stdout, /valid {3}commit-\w+ bugfix: ok/)
  assert.match(c.stdout, /valid {3}commit-\w+ feature: ok/)
  assert.match(c.stdout, /invalid commit-\w+ chore: hidden tests already pass at the start/)
  assert.match(c.stdout, /2 of 3 task\(s\) valid/)

  const tare = path.join(f.sol, 'tare.md'); fs.writeFileSync(tare, '# tare\n')
  const arms = path.join(f.sol, 'arms.json')
  fs.writeFileSync(arms, JSON.stringify([
    { name: 'bare', strip: ['.rig', '.claude', 'CLAUDE.md'], prompt: '{task}', agentCmd: path.join(f.sol, 'cheat.sh') },
    { name: 'rig+tare', tare: true, prompt: 'rig: {task}', agentCmd: path.join(f.sol, 'good.sh') },
  ]))
  const r = chb(['replay', 'run', '--arms', arms, '--tare', tare, '--runs', '2', '--jobs', '3', '--models', 'm1'], f.dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /8 run\(s\) to do \(0 already done\)/)
  assert.equal((r.stdout.match(/\] pass /g) ?? []).length, 4)
  assert.equal((r.stdout.match(/\] fail /g) ?? []).length, 4, 'editing the hidden tests must not pass: they are restored before scoring')

  // What the agents saw: one commit of history, no hidden tests, the arm's preparation, the prompt with Tare first.
  const logs = fs.readdirSync(f.log)
  for (const n of logs.filter(x => x.endsWith('.commits'))) assert.equal(fs.readFileSync(path.join(f.log, n), 'utf8').trim(), '1')
  for (const n of logs.filter(x => x.endsWith('.files'))) {
    const files = fs.readFileSync(path.join(f.log, n), 'utf8')
    // Each task's own hidden test is absent (the feature task starts after the fix, so sum.test.js is legitimately there).
    assert.doesNotMatch(files, /mean\.test\.js/)
    if (n.startsWith(`commit-${f.fix.slice(0, 10)}-`)) assert.doesNotMatch(files, /sum\.test\.js/)
    if (n.includes('-bare-')) { assert.doesNotMatch(files, /CLAUDE\.md|tare/); assert.doesNotMatch(files, /sensors\.json/) }
    else { assert.match(files, /CLAUDE\.md/); assert.match(files, /\.claude[\s\S]*tare/) }
  }
  const tarePrompt = logs.find(x => x.includes('-rig+tare-') && x.endsWith('.prompt'))!
  assert.ok(fs.readFileSync(path.join(f.log, tarePrompt), 'utf8').startsWith(`${TARE_LINE}\n\nrig: `))

  const again = chb(['replay', 'run', '--arms', arms, '--tare', tare, '--runs', '2', '--models', 'm1'], f.dir)
  assert.match(again.stdout, /0 run\(s\) to do \(8 already done\)/)

  const rep = chb(['replay', 'report', '--json'], f.dir)
  assert.equal(rep.status, 0, rep.stderr)
  const s = JSON.parse(rep.stdout) as ReturnType<typeof summarise>
  const good = s.arms.find(a => a.arm === 'rig+tare')!
  assert.equal(good.passRate, 1); assert.equal(good.costUsd, 0.25); assert.equal(good.turns, 4)
  assert.equal(s.arms.find(a => a.arm === 'bare')!.passRate, 0)
  // Two tasks is far too few to judge, however clean the difference looks.
  assert.equal(s.comparisons[0]!.verdict, 'too few tasks'); assert.equal(s.comparisons[0]!.delta, 1)
  const md = chb(['replay', 'report'], f.dir).stdout
  assert.match(md, /\| rig\+tare \| m1 \| 2 \| \+100\.0 \|/); assert.match(md, /need at least 10 tasks/); assert.doesNotMatch(md, /Kill rule/)

  // An agent that cannot start is not scored, leaves no result, and is retried on the next run.
  fs.writeFileSync(arms, JSON.stringify([{ name: 'broken', prompt: '{task}', agentCmd: '/nonexistent/agent' }]))
  const br = chb(['replay', 'run', '--arms', arms, '--runs', '1', '--models', 'm1'], f.dir)
  assert.equal(br.status, 0, br.stderr)
  assert.match(br.stdout, /2 run\(s\) not scored/)
  assert.equal(fs.readdirSync(path.join(f.dir, 'replay/results')).filter(x => x.includes('broken')).length, 0)
  assert.match(chb(['replay', 'run', '--arms', arms, '--runs', '1', '--models', 'm1', '--dry-run'], f.dir).stdout, /2 run\(s\) to do/)

  // Results for a task later marked invalid drop out of the report.
  const tf2 = JSON.parse(fs.readFileSync(path.join(f.dir, 'replay/tasks.json'), 'utf8'))
  tf2.tasks.find((t: { type: string }) => t.type === 'feature').valid = false
  fs.writeFileSync(path.join(f.dir, 'replay/tasks.json'), JSON.stringify(tf2))
  const s2 = JSON.parse(chb(['replay', 'report', '--json'], f.dir).stdout) as ReturnType<typeof summarise>
  assert.equal(s2.arms.find(a => a.arm === 'rig+tare')!.tasks, 1)
})

test('replay: only source changes are scored; tests, config and harness edits are not', () => {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-a-')), score = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-s-'))
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: agent })
  write(agent, { 'src/a.js': '1', 'src/gone.js': 'x', 'package.json': '{"scripts":{"test":"node --test"}}', 'test/a.test.js': 'real' })
  const start = commit(agent, 'start', {})
  write(score, { 'src/a.js': '1', 'src/gone.js': 'x', 'package.json': '{"scripts":{"test":"node --test"}}', 'test/a.test.js': 'real' })
  fs.rmSync(path.join(agent, 'src/gone.js'))
  commit(agent, 'agent', { 'src/a.js': '2', 'src/new.js': 'n', 'package.json': '{"scripts":{"test":"exit 0"}}', 'test/a.test.js': 'fake', 'conftest.py': 'skip', '__snapshots__/x.snap': 's', '.claude/skills/x/SKILL.md': 'x', 'src/types.d.ts': 'd' })
  assert.deepEqual(carryOver(agent, start, score).sort(), ['src/a.js', 'src/gone.js', 'src/new.js', 'src/types.d.ts'])
  assert.equal(fs.readFileSync(path.join(score, 'src/a.js'), 'utf8'), '2')
  assert.ok(!fs.existsSync(path.join(score, 'src/gone.js')))
  assert.match(fs.readFileSync(path.join(score, 'package.json'), 'utf8'), /node --test/)
  assert.equal(fs.readFileSync(path.join(score, 'test/a.test.js'), 'utf8'), 'real')
  for (const f of ['conftest.py', '__snapshots__/x.snap', '.claude/skills/x/SKILL.md']) assert.ok(!fs.existsSync(path.join(score, f)), f)
})

test('replay: processes — background children, unread stdin, timeouts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'))
  const bg = await spawnAsync('sleep 30 & echo done', dir, 5_000)
  assert.equal(bg.code, 0); assert.equal(bg.timedOut, false); assert.ok(bg.ms < 3_000, `took ${bg.ms}ms`)
  const unread = await spawnAsync('true', dir, 5_000, { input: 'x'.repeat(1_000_000) })
  assert.equal(unread.code, 0)
  const slow = await spawnAsync('sleep 5', dir, 300)
  assert.equal(slow.timedOut, true)
  const missing = await spawnAsync('', dir, 5_000, { argv: ['/nonexistent/claude'] })
  assert.ok(missing.spawnError)
})

test('replay: scheduling, result names, secrets, prompts', async () => {
  const active = new Map<string, number>(); let worst = 0, overall = 0, peak = 0
  await pool(['a', 'a', 'a', 'b', 'b', 'c'], 3, x => x, async x => {
    active.set(x, (active.get(x) ?? 0) + 1); overall++; worst = Math.max(worst, active.get(x)!); peak = Math.max(peak, overall)
    await new Promise(r => setTimeout(r, 20))
    active.set(x, active.get(x)! - 1); overall--
  })
  assert.equal(worst, 1, 'never two runs of one task at once'); assert.equal(peak, 3)
  assert.notEqual(resultFile('/r', { task: 't', arm: 'a/b', model: 'm', run: 1 }), resultFile('/r', { task: 't', arm: 'a_b', model: 'm', run: 1 }))
  process.env.GH_TOKEN = 'secret'
  assert.equal(agentEnv({ X: '1' }).GH_TOKEN, undefined); assert.equal(agentEnv({ X: '1' }).X, '1')
  delete process.env.GH_TOKEN
  const task = { id: 't', title: 't', type: 'bugfix' as const, prompt: "run echo $'hi' and $& here", base: '', solution: '', hidden: [], size: { files: 1, added: 1, deleted: 0 } }
  assert.equal(armPrompt({ name: 'x', prompt: 'PRE {task} POST' }, task), "PRE run echo $'hi' and $& here POST")
  assert.equal(testCommand('t {hidden}', ["$'x"]), String.raw`t '$'\''x'`)
})

test('replay: classification, prompts and test commands', () => {
  assert.equal(changeType('fix(api): x'), 'bugfix'); assert.equal(changeType('feat!: x'), 'feature')
  assert.equal(changeType('Refactor: x'), 'refactor'); assert.equal(changeType('deps: bump'), 'chore')
  assert.equal(changeType('Make it faster', ['bug']), 'bugfix'); assert.equal(changeType('Make it faster'), 'other')
  for (const f of ['test/a.ts', 'src/a.test.ts', 'pkg/a_test.go', 'tests/x.py', 'src/__tests__/a.js', 'app/test_x.py']) assert.ok(isTestPath(f), f)
  for (const f of ['src/a.ts', 'src/testing.ts', 'latest/a.ts', 'src/types.d.ts']) assert.ok(!isTestPath(f), f)
  for (const f of ['package.json', 'sub/conftest.py', 'vitest.config.mts', 'jest.config.js', 'pyproject.toml', 'src/__snapshots__/a.snap', 'go.mod']) assert.ok(isScoringConfig(f), f)
  for (const f of ['src/config.ts', 'src/package.ts']) assert.ok(!isScoringConfig(f), f)
  assert.equal(taskPrompt('fix: x', '<!-- template -->\nWhy it broke.\n'), 'fix: x\n\nWhy it broke.')
  assert.equal(testCommand('pytest {hidden} -q', ['tests/a b.py', "t/it's.py"]), `pytest 'tests/a b.py' 't/it'\\''s.py' -q`)
})

test('replay: usage from claude -p json output, and junk', () => {
  const u = usage('noise\n{"type":"result","total_cost_usd":1.5,"num_turns":12,"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"output_tokens":7}}\n')
  assert.deepEqual(u, { costUsd: 1.5, turns: 12, tokensIn: 15, tokensOut: 7, isError: false })
  assert.deepEqual(usage('plain text'), { costUsd: null, turns: null, tokensIn: null, tokensOut: null, isError: false })
  assert.equal(usage('{"is_error":true,"num_turns":1}').isError, true)
})

const res = (task: string, arm: string, run: number, pass: boolean, cost = 1): Result => ({ task, type: 'bugfix', arm, model: 'm', run, status: pass ? 'pass' : 'fail', pass, agentExit: 0, testExit: pass ? 0 : 1, costUsd: cost, turns: 3, tokensIn: null, tokensOut: null, wallMs: 60_000, diff: { files: 1, added: 3, deleted: 1 }, gates: null, at: '' })

test('replay: the paired bootstrap calls a coin flip a coin flip, and flags the kill rule', () => {
  // 10 tasks; rig+tare wins 3 and loses 3 against bare: no detectable difference, and it costs 3×.
  const rs: Result[] = []
  for (let t = 0; t < 10; t++) for (const run of [1, 2]) {
    rs.push(res(`t${t}`, 'bare', run, t < 5))
    rs.push(res(`t${t}`, 'rig+tare', run, (t < 2) || (t >= 5 && t < 8), 3))
  }
  const s = summarise(rs)
  const c = s.comparisons[0]!
  assert.equal(c.verdict, 'no detectable difference'); assert.equal(c.delta, 0); assert.equal(c.costRatio, 3)
  assert.ok(c.ci[0] < 0 && c.ci[1] > 0)
  assert.deepEqual(summarise(rs).comparisons[0]!.ci, c.ci, 'seeded: the same results print the same interval')
  const md = renderReport(s, 'bare')
  assert.match(md, /\*\*Kill rule:\*\* rig\+tare is not better than bare on m/)
  assert.match(md, /\| bare \| m \| 10 \| 20 \| 50% \| 50%–50% \|/)
})

test('dispatch: Tare is loaded by name when the repo has it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tare-'))
  assert.equal(withTare('do x', dir), 'do x')
  write(dir, { [TARE_PATH]: '# tare\n' })
  assert.equal(withTare('do x', dir), `${TARE_LINE}\n\ndo x`)
})
