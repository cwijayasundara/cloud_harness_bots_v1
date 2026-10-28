// The pilot dry run as a test, when a rig_v1 checkout is given (CHB_PILOT_RIG=<dir>); CI's pilot job runs it on rig's latest main.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RIG = process.env.CHB_PILOT_RIG
test('pilot: rig\'s sample sprint ships with two sessions side by side, every commit yours', { skip: !RIG && 'set CHB_PILOT_RIG=<rig_v1 checkout> to run' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-test-'))
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env
  const r = spawnSync(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pilot/dry-run.mjs'), '--rig', RIG!, '--out', out], { encoding: 'utf8', env, timeout: 600_000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /ok {3}two sessions ran side by side in one hour/)
})

test('pilot --auto: with rig\'s plan gate off and CHB_AUTO_BUILD=tier0, the sprint reaches passing proofs with no approval', { skip: !RIG && 'set CHB_PILOT_RIG=<rig_v1 checkout> to run' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-auto-'))
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env
  const r = spawnSync(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../pilot/dry-run.mjs'), '--rig', RIG!, '--out', out, '--auto'], { encoding: 'utf8', env, timeout: 600_000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /ok {3}no plan was approved: every build was tier 0/)
})
