// `chb install <rig repo>`: wire this package into a rig_v1 repo, the way rig vendors itself, so a clone or a cloud
// session needs nothing installed globally:
//   .rig/ub/{bin,src}                    the chb CLI, vendored (protect it with CODEOWNERS)
//   .rig/sensors.json                    three ub-* sensors appended (advisory: "blocks": false until week 4 of the rollout)
//   .claude/skills/policy-craft          ub-mode adapted to rig's stages (a rig policy skill: owner + source)
//   .claude/skills/verify-app            a template the repo fills in: launch, check, drive, capture, clean up
//   .gitignore                           tool output (.metrics/, .rig/ub/results/, mutation workers)
//   CODEOWNERS (if present)              the baseline and the vendored CLI
//   .github/workflows/ub-gates.yml       only with --ci: the gates as a PR check, tools installed in CI
//   .github/workflows/chb-ledger.yml     only with --ledger: the hourly PR ledger, no Grok Bot needed
// --ub-mode also fetches Uncle Bob's ub-mode SKILL.md into ~/.claude/skills/ub-mode (it ships without a licence,
// so it is fetched from his repo, never copied into yours).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pkgRoot, version as pkgVersion } from './pkg.ts'
import { spawnSync } from 'node:child_process'
import { type Args, flag, opt, out, die } from './cli.ts'

const PKG = pkgRoot()
export const NODE = 'node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts'

export type Sensor = { id: string; cmd: string; cadence: 'edit' | 'turn' | 'commit' | 'ci' | 'nightly'; blocks: boolean; guide: string; ratchet?: 'down' | 'up'; timeoutMs?: number }

export const UB_SENSORS: Sensor[] = [
  { id: 'ub-crap', cmd: `${NODE} gate crap`, cadence: 'commit', blocks: false, timeoutMs: 900_000,
    guide: 'Every function you add or touch scores CRAP under 10 (CRAP = CC² × (1 − coverage)³ + CC): split it, test it, or both. Never edit .rig/ub-baseline.json to pass.' },
  { id: 'ub-dry', cmd: `${NODE} gate dry`, cadence: 'commit', blocks: false, timeoutMs: 300_000,
    guide: 'No new structural duplicate at similarity 0.8 or above that touches a changed file: extract the shared shape once.' },
  { id: 'ub-mutate', cmd: `${NODE} gate mutate`, cadence: 'ci', blocks: false, timeoutMs: 1_800_000,
    guide: 'No surviving mutant in changed code: a test must fail when the code changes. Cover the uncovered, kill the survivors, delete dead code.' },
]
// No whole-tree "total" ratchet sensors: rig_v1 (26 Oct 2026) accepts a "nightly" cadence but its `check` runs only
// stop|commit|ship|ci, so a nightly sensor never runs. The whole-tree trend is the Auditor bot's nightly
// `chb gate <g> --scope all` and `chb report`. A loosened baseline is flagged at commit by ub-crap and ub-dry (blocking from
// week 4) and always blocked by the ub-gates CI check, which also judges with the base branch's baseline.

// Pure: append the ub sensors to a sensors.json text, keeping every other byte's meaning. --force replaces same ids.
export function mergeSensors(text: string, force: boolean): { text: string; added: string[]; kept: string[] } {
  const j = JSON.parse(text) as { sensors?: (Partial<Sensor> & { id: string })[] }
  const list = j.sensors ?? []
  const added: string[] = [], kept: string[] = []
  for (const s of UB_SENSORS) {
    const i = list.findIndex(x => x.id === s.id)
    if (i < 0) { list.push(s); added.push(s.id) }
    // --force refreshes the command and guide but keeps the repo's own choices: blocking (week 4), cadence, timeout.
    else if (force) { const was = list[i]!; list[i] = { ...s, blocks: was.blocks ?? s.blocks, cadence: was.cadence ?? s.cadence, timeoutMs: was.timeoutMs ?? s.timeoutMs }; added.push(s.id) }
    else kept.push(s.id)
  }
  j.sensors = list
  return { text: JSON.stringify(j, null, 2) + '\n', added, kept }
}

export const IGNORE = ['.metrics/', '.rig/ub/results/', 'target/mutation-workers/', 'target/mutator-backup/', 'target/coverage/']

export function appendLines(text: string, lines: string[], header: string): string {
  const have = new Set(text.split('\n').map(l => l.trim()))
  const missing = lines.filter(l => !have.has(l))
  if (!missing.length) return text
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${header}\n${missing.join('\n')}\n`
}

function copyDir(from: string, to: string, filter: (f: string) => boolean): number {
  let n = 0
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) n += copyDir(a, b, filter)
    else if (filter(e.name)) { fs.copyFileSync(a, b); n++ }
  }
  return n
}

export async function fetchUbMode(): Promise<string> {
  const url = 'https://raw.githubusercontent.com/unclebob/ub-mode/master/SKILL.md'
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  const dir = path.join(os.homedir(), '.claude', 'skills', 'ub-mode')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), await r.text())
  return dir
}

// The vendored CLI only: what `chb upgrade` refreshes, leaving sensors, skills, workflows and the baseline alone.
export function vendor(target: string): string {
  fs.rmSync(path.join(target, '.rig/ub/src'), { recursive: true, force: true })
  fs.rmSync(path.join(target, '.rig/ub/bin'), { recursive: true, force: true })
  const n = copyDir(path.join(PKG, 'src'), path.join(target, '.rig/ub/src'), f => f.endsWith('.ts')) + copyDir(path.join(PKG, 'bin'), path.join(target, '.rig/ub/bin'), f => f.endsWith('.ts'))
  fs.writeFileSync(path.join(target, '.rig/ub/VERSION'), `${pkgVersion()}\n`)
  return `vendored chb ${pkgVersion()} into .rig/ub (${n} files)`
}

export function cmdUpgrade(args: Args): void {
  const target = path.resolve(args.pos[0] ?? '.')
  if (!fs.existsSync(path.join(target, '.rig/ub/VERSION'))) die(`${target} has no vendored chb: run chb install first`)
  const was = fs.readFileSync(path.join(target, '.rig/ub/VERSION'), 'utf8').trim()
  out(`${vendor(target)} (was ${was}). Sensors, skills, workflows and the baseline are unchanged. Commit .rig/ub through a reviewed PR.`)
}

export function cmdInstall(args: Args): void {
  const target = path.resolve(args.pos[0] ?? '.')
  const sensorsFile = path.join(target, '.rig', 'sensors.json')
  if (!fs.existsSync(sensorsFile)) die(`${target} is not an initialised rig repo (no .rig/sensors.json): run /rig:init there first`)
  const force = flag(args, 'force')
  const done: string[] = []

  done.push(vendor(target))

  const m = mergeSensors(fs.readFileSync(sensorsFile, 'utf8'), force)
  fs.writeFileSync(sensorsFile, m.text)
  done.push(`.rig/sensors.json: added ${m.added.join(', ') || 'nothing'}${m.kept.length ? `; kept existing ${m.kept.join(', ')} (--force replaces)` : ''}`)
  // rig keeps CLAUDE.md's guides block in step with sensors.json and refuses a commit when they drift: re-sync it.
  const sdlc = path.join(target, '.rig/bin/sdlc.ts')
  if (m.added.length && fs.existsSync(sdlc)) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', sdlc, 'sync'], { cwd: target, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: target } })
    done.push(r.status === 0 ? 'rig sync: CLAUDE.md guides block updated for the new sensors' : `rig sync failed (run \`node .rig/bin/sdlc.ts sync\` yourself): ${(r.stderr || r.stdout).trim().split('\n').pop()}`)
  }

  // Skills are the repo's once written (owner, source, the filled-in verify steps): never overwritten, even with --force.
  for (const skill of ['policy-craft', 'verify-app']) {
    const to = path.join(target, '.claude/skills', skill, 'SKILL.md')
    if (fs.existsSync(to)) { done.push(`.claude/skills/${skill}: exists, kept`); continue }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(PKG, 'skills', skill, 'SKILL.md'), to)
    done.push(`.claude/skills/${skill}/SKILL.md written${skill === 'verify-app' ? ' (a template: fill in its launch and drive steps)' : ''}`)
  }

  const gi = path.join(target, '.gitignore')
  const giText = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : ''
  const giNext = appendLines(giText, IGNORE, '# chb / Uncle Bob tools output')
  if (giNext !== giText) { fs.writeFileSync(gi, giNext); done.push('.gitignore: tool output ignored') }

  const owner = opt(args, 'owner')
  const co = ['.github/CODEOWNERS', 'CODEOWNERS'].map(f => path.join(target, f)).find(f => fs.existsSync(f))
  if (co && owner) {
    const t = fs.readFileSync(co, 'utf8'), nx = appendLines(t, [`/.rig/ub-baseline.json ${owner}`, `/.rig/ub/ ${owner}`], '# chb: only a person loosens the baseline or changes the gates')
    if (nx !== t) { fs.writeFileSync(co, nx); done.push(`${path.relative(target, co)}: baseline and .rig/ub owned by ${owner}`) }
  } else done.push(`CODEOWNERS: add \`/.rig/ub-baseline.json <you>\` and \`/.rig/ub/ <you>\`${co ? ' (pass --owner @you to do it)' : ' (no CODEOWNERS file found)'}`)

  const workflow = (name: string, note: string) => {
    const to = path.join(target, '.github/workflows', name)
    if (fs.existsSync(to) && !force) return done.push(`.github/workflows/${name}: exists, kept (--force replaces)`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(path.join(PKG, 'templates', name), to)
    done.push(`.github/workflows/${name} written: ${note}`)
  }
  if (flag(args, 'ci')) workflow('ub-gates.yml', 'make "ub-gates" a required check; chb merge requires it')
  if (flag(args, 'ledger')) workflow('chb-ledger.yml', 'hourly PR ledger (labels + a "chb PR ledger" issue); set repo variable CHB_AUTOMERGE=true to let it auto-merge')

  out([`chb install → ${target}`, ...done.map(d => `  - ${d}`), '', 'Next:',
    '  1. chb tools install            (once per machine, and on the Grok Bot computer)',
    `  2. cd ${target} && ${NODE} baseline write --skip mutate   (record today's debt; add mutate later, it is slow)`,
    '  3. review the diff, commit on a branch, open a PR: sensors.json and .claude/ are protected, so a code owner approves it',
    '  4. ROLLOUT.md week 4: flip "blocks" to true on ub-crap and ub-dry'].join('\n'))

  if (flag(args, 'ub-mode')) fetchUbMode().then(d => out(`ub-mode fetched into ${d} (user scope; not committed)`), e => { out(`ub-mode fetch failed: ${(e as Error).message}`); process.exitCode = 2 })
}
