import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mergeSensors, withSchedule, SCHEDULES } from '../src/install.ts'
import { nodeOk } from '../src/doctor.ts'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
const chb = (args: string[], cwd: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args], { cwd, encoding: 'utf8', env: { ...process.env, UB_TOOLS_DIR: path.join(cwd, 'no-tools') } })

test('--force refreshes ub sensors but keeps the repo\'s blocks, cadence and timeout', () => {
  const week4 = JSON.stringify({ sensors: [{ id: 'ub-crap', cmd: 'old', cadence: 'turn', blocks: true, timeoutMs: 5, guide: 'old' }] })
  const s = JSON.parse(mergeSensors(week4, true).text).sensors.find((x: { id: string }) => x.id === 'ub-crap')
  assert.equal(s.blocks, true); assert.equal(s.cadence, 'turn'); assert.equal(s.timeoutMs, 5)
  assert.match(s.cmd, /gate crap/); assert.notEqual(s.guide, 'old')
})

test('--schedule: presets and a cron set the coordinator\'s cron line; anything else is refused', () => {
  const yml = fs.readFileSync(path.resolve(path.dirname(CHB), '../templates/chb-coordinate.yml'), 'utf8')
  assert.ok(yml.includes(`- cron: '${SCHEDULES.day!.cron}'`), 'the template runs on the day preset')
  const night = withSchedule(yml, 'night')
  assert.match(night, /- cron: '23 21-23,0-6 \* \* \*' # hourly every night/)
  assert.equal(night.split('\n').length, yml.split('\n').length)
  assert.match(withSchedule(yml, '5 22-23,0-5 * * 1-5'), /- cron: '5 22-23,0-5 \* \* 1-5' # custom schedule, UTC/)
  for (const bad of ['nightly', '23 * * *', "23 * * * *' ; rm -rf"]) assert.throws(() => withSchedule(yml, bad), /--schedule/)
})

test('install --coordinate --schedule night, then --schedule always rewrites only the cron; --schedule alone needs the workflow', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-schedule-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.rig'))
  fs.writeFileSync(path.join(dir, '.rig/sensors.json'), JSON.stringify({ sensors: [] }))
  let r = chb(['install', dir, '--schedule', 'night'], dir)
  assert.equal(r.status, 1); assert.match(r.stderr, /add --coordinate/)
  r = chb(['install', dir, '--coordinate', '--schedule', 'bogus'], dir)
  assert.equal(r.status, 1); assert.ok(!fs.existsSync(path.join(dir, '.rig/ub')), 'a bad schedule changes nothing')
  const wf = path.join(dir, '.github/workflows/chb-coordinate.yml')
  r = chb(['install', dir, '--coordinate', '--schedule', 'night'], dir)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /hourly every night/)
  assert.match(fs.readFileSync(wf, 'utf8'), /- cron: '23 21-23,0-6 \* \* \*'/)
  fs.appendFileSync(wf, '# my edit\n')
  r = chb(['install', dir, '--schedule', 'always'], dir)
  assert.equal(r.status, 0, r.stderr)
  const t = fs.readFileSync(wf, 'utf8')
  assert.match(t, /- cron: '23 \* \* \* \*'/); assert.match(t, /# my edit/)
})

test('doctor: node version floor', () => {
  assert.equal(nodeOk('22.17.9'), false); assert.equal(nodeOk('22.18.0'), true); assert.equal(nodeOk('24.1.0'), true); assert.equal(nodeOk('20.19.0'), false)
})

test('install → edit skill → install --force → upgrade, in a scratch rig repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-install-'))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  fs.mkdirSync(path.join(dir, '.rig'))
  fs.writeFileSync(path.join(dir, '.rig/sensors.json'), JSON.stringify({ sensors: [{ id: 'lint', cmd: 'x' }] }))
  fs.writeFileSync(path.join(dir, 'CODEOWNERS'), '* @ck\n')
  let r = chb(['install', dir, '--ci', '--ledger', '--owner', '@ck'], dir)
  assert.equal(r.status, 0, r.stderr)
  for (const f of ['.rig/ub/bin/chb.ts', '.rig/ub/src/gate.ts', '.rig/ub/VERSION', '.claude/skills/policy-craft/SKILL.md', '.claude/skills/verify-app/SKILL.md', '.github/workflows/ub-gates.yml', '.github/workflows/chb-ledger.yml'])
    assert.ok(fs.existsSync(path.join(dir, f)), f)
  assert.match(fs.readFileSync(path.join(dir, 'CODEOWNERS'), 'utf8'), /\/\.rig\/ub-baseline\.json @ck/)
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /\.metrics\//)
  // the vendored copy runs on its own, with no package.json above it
  r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '.rig/ub/bin/chb.ts', 'version'], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.stdout.trim(), fs.readFileSync(path.join(dir, '.rig/ub/VERSION'), 'utf8').trim())

  const skill = path.join(dir, '.claude/skills/policy-craft/SKILL.md')
  fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace('<you, e.g. @cwijayasundara>', '@ck'))
  const sensors = path.join(dir, '.rig/sensors.json')
  const j = JSON.parse(fs.readFileSync(sensors, 'utf8')); for (const s of j.sensors) if (s.id === 'ub-crap') s.blocks = true
  fs.writeFileSync(sensors, JSON.stringify(j))
  r = chb(['install', dir, '--force'], dir)
  assert.equal(r.status, 0, r.stderr)
  assert.match(fs.readFileSync(skill, 'utf8'), /owner: @ck/, 'an edited skill is never overwritten')
  assert.equal(JSON.parse(fs.readFileSync(sensors, 'utf8')).sensors.find((s: { id: string }) => s.id === 'ub-crap').blocks, true, 'week-4 blocking survives --force')

  fs.writeFileSync(path.join(dir, '.rig/ub/VERSION'), '0.0.1\n')
  fs.writeFileSync(path.join(dir, '.rig/ub/src/stale.ts'), '')
  r = chb(['upgrade', dir], dir)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /was 0\.0\.1/)
  assert.ok(!fs.existsSync(path.join(dir, '.rig/ub/src/stale.ts')), 'upgrade replaces the vendored tree')

  r = chb(['doctor', '--repo-dir', dir], dir)
  assert.equal(r.status, 1, 'no baseline and no tools: doctor fails')
  assert.match(r.stdout, /✗ no \.rig\/ub-baseline\.json/); assert.match(r.stdout, /✓ ub sensors registered/)
})
