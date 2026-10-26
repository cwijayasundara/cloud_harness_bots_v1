// `chb gate <crap|dry|mutate>` and `chb baseline <write|check>`: run Uncle Bob's tool, read its snapshot, judge it
// against .rig/ub-baseline.json, print the findings, and end with ONE number on the last line so a rig sensor can use
// it as a ratchet ("ratchet": "down"). Exit codes: 0 pass, 1 blocking findings, 2 the tool or the setup failed.
//
// Every result records how it was produced (run or not, thresholds, tool args, unscored functions, uncommitted source).
// `chb proof` refuses a result that was not a full, default-threshold run on committed code: an agent cannot make a
// pass by re-judging an old snapshot, raising --max, adding --no-coverage, or gating a working tree HEAD does not hold.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { readCrap, readDry, readMutate, METRICS } from './snapshots.ts'
import { judgeCrap, judgeDry, judgeMutate, buildBaseline, loosened, parseBaseline, formatVerdict, type Verdict, type Baseline } from './judge.ts'
import { changedSource, repoSource, dirtySource, defaultBase, mergeBase, showAt, repoRoot } from './git.ts'
import { type Args, flag, opt, out, warn, die } from './cli.ts'

export const BASELINE = '.rig/ub-baseline.json'
export const RESULTS = '.rig/ub/results'
export type Gate = 'crap' | 'dry' | 'mutate'
const TOOL: Record<Gate, string> = { crap: 'crapper', dry: 'dryer', mutate: 'mutator' }
// Exit codes each tool uses for "ran fine" (READMEs): mutator exits 3 when a mutant survives, which is a finding, not a failure.
const OK_EXIT: Record<Gate, number[]> = { crap: [0], dry: [0], mutate: [0, 3] }
// Tool flags that change what is measured: a result produced with one is not proof.
const DISTRUSTED_ARGS = ['--no-coverage', '--threshold', '--min-lines', '--min-nodes', '--since-last-run', '--scan']

export const toolsDir = (): string => process.env.UB_TOOLS_DIR || path.join(os.homedir(), '.ub-tools')
const toolFile = (gate: Gate): string => path.join(toolsDir(), TOOL[gate], TOOL[gate])

export function toolPath(gate: Gate): string {
  const p = toolFile(gate)
  if (!fs.existsSync(p)) die(`${TOOL[gate]} not found at ${p}: run \`chb tools install\` or set UB_TOOLS_DIR`, 2)
  return p
}

// In another workflow's CI job (rig-check runs every sensor at its ci cadence) the tools are not installed; the
// separate, required `ub-gates` check judges the gates there. Anywhere else a missing tool is a setup failure.
const deferToUbGates = (gate: Gate): boolean =>
  process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_WORKFLOW !== 'ub-gates' && !fs.existsSync(toolFile(gate))

export function runTool(gate: Gate, args: string[], root: string): void {
  const exe = toolPath(gate)
  warn(`$ ${TOOL[gate]} ${args.join(' ')}`.slice(0, 400))
  const r = spawnSync(exe, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: Number(process.env.CHB_TOOL_TIMEOUT_MS ?? 30 * 60_000) })
  if (r.error) die(`${TOOL[gate]} could not run: ${r.error.message}`, 2)
  if (!OK_EXIT[gate].includes(r.status ?? -1)) {
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n')
    die(`${TOOL[gate]} failed (exit ${r.status}${gate === 'mutate' && r.status === 2 ? ': the baseline tests fail, fix them first' : ''})\n${tail}`, 2)
  }
}

// crapper and dryer replace their snapshot only on a successful analysis; remove it first so a run that selects
// nothing cannot leave yesterday's snapshot to be judged. mutator's snapshots are differential by design, so they
// stay, and its forms are filtered to the files this run targeted.
function clearSnapshot(gate: Gate, root: string): void {
  if (gate === 'crap') fs.rmSync(path.join(root, METRICS, 'crap.edn'), { force: true })
  if (gate === 'dry') fs.rmSync(path.join(root, METRICS, 'dry.edn'), { force: true })
}

export const readBaseline = (root: string): Baseline => parseBaseline(fs.existsSync(path.join(root, BASELINE)) ? fs.readFileSync(path.join(root, BASELINE), 'utf8') : null)

// Compared with the baseline where the branch started, so debt main paid down after the branch was cut is not "added".
export function baselineLoosening(root: string, base: string | null, current: Baseline): string[] {
  if (!base || process.env.CHB_ALLOW_BASELINE_LOOSEN === '1') return []
  const mb = mergeBase(base, root)
  const before = mb ? showAt(mb, BASELINE, root) : null
  return before ? loosened(parseBaseline(before), current) : []
}

export type GateResult = {
  gate: Gate; at: string; scope: 'changed' | 'all'; base: string | null; files: string[]; head: string | null
  verdict: Verdict; loosened: string[]; pass: boolean
  provenance: { run: boolean; thresholds: { crap: number; dry: number }; toolArgs: string[]; unscored: number; dirty: string[] }
  untrusted: string[] // why this result is not proof; empty when it is
}

export function untrustedReasons(p: GateResult['provenance'], baseline: Baseline): string[] {
  const r: string[] = []
  if (!p.run) r.push('judged an existing snapshot (--no-run)')
  if (p.thresholds.crap > baseline.thresholds.crap) r.push(`CRAP bar raised to ${p.thresholds.crap}`)
  if (p.thresholds.dry > baseline.thresholds.dry) r.push(`duplicate bar raised to ${p.thresholds.dry}`)
  const bad = p.toolArgs.filter(a => DISTRUSTED_ARGS.some(d => a === d || a.startsWith(`${d}=`)))
  if (bad.length) r.push(`tool run with ${bad.join(' ')}`)
  if (p.unscored) r.push(`${p.unscored} function(s) had no CRAP score (no coverage)`)
  if (p.dirty.length) r.push(`uncommitted source judged (${p.dirty.slice(0, 3).join(', ')}${p.dirty.length > 3 ? ' …' : ''}): commit, then rerun`)
  return r
}

export function cmdGate(args: Args): void {
  const gate = args.pos[0] as Gate
  if (!['crap', 'dry', 'mutate'].includes(gate)) die('usage: chb gate <crap|dry|mutate> [--scope changed|all] [--base <ref>] [--no-run] [--strict] [-- <tool args>]')
  const root = repoRoot()
  const scope = (opt(args, 'scope') ?? 'changed') as 'changed' | 'all'
  if (scope !== 'changed' && scope !== 'all') die('--scope is changed or all')
  if (deferToUbGates(gate)) return out(`${gate}: skipped in ${process.env.GITHUB_WORKFLOW}: the tools run in the required ub-gates check\n0`)
  const base = opt(args, 'base') ?? defaultBase(root)
  const baseline = readBaseline(root)
  let files: string[] = []
  if (scope === 'changed') { try { files = changedSource(base, root) } catch (e) { die(`${gate}: ${(e as Error).message}`, 2) } }
  const loose = baselineLoosening(root, base, baseline)
  const run = !flag(args, 'no-run')
  const thresholds = { crap: num(opt(args, 'max')) ?? baseline.thresholds.crap, dry: num(opt(args, 'min')) ?? baseline.thresholds.dry }
  const tree = scope === 'all' || gate === 'dry' ? repoSource(root) : []
  const targets = scope === 'changed' ? files : tree
  const provenance = { run, thresholds, toolArgs: args.rest, unscored: 0, dirty: dirtySource(root) }
  const at = new Date().toISOString()

  // Nothing to measure: no tool run, no stale snapshot read. A loosened baseline still blocks.
  if (!targets.length || (scope === 'changed' && !files.length)) {
    const verdict: Verdict = { gate, findings: [], blocking: 0, total: 0, notes: [scope === 'changed' ? 'no changed source files' : 'no source files'] }
    return finish(root, { gate, at, scope, base, files, head: head(root), verdict, loosened: loose, pass: !loose.length, provenance: { ...provenance, run: true }, untrusted: [] }, flag(args, 'strict'))
  }

  const only = new Set(targets)
  let verdict: Verdict
  if (run) clearSnapshot(gate, root)
  if (gate === 'crap') {
    if (run) runTool('crap', [...targets, ...args.rest], root)
    const entries = readCrap(root)
    provenance.unscored = entries.filter(e => e.crap === null).length
    verdict = judgeCrap(entries, baseline, thresholds.crap)
  } else if (gate === 'dry') {
    // The whole repo's source, so a new function that copies an old one is caught; then keep the pairs that touch a changed file.
    if (run) runTool('dry', ['--threshold', String(thresholds.dry), '--edn', ...args.rest, ...tree], root)
    verdict = judgeDry(readDry(root), baseline, thresholds.dry, scope === 'changed' ? new Set(files) : only)
  } else {
    if (run) runTool('mutate', [...targets, ...args.rest], root)
    verdict = judgeMutate(readMutate(root), baseline, only)
  }
  const r: GateResult = { gate, at, scope, base, files, head: head(root), verdict, loosened: loose, pass: verdict.blocking === 0 && loose.length === 0, provenance, untrusted: [] }
  r.untrusted = untrustedReasons(provenance, baseline)
  finish(root, r, flag(args, 'strict'))
}

function finish(root: string, r: GateResult, strict: boolean): void {
  fs.mkdirSync(path.join(root, RESULTS), { recursive: true })
  fs.writeFileSync(path.join(root, RESULTS, `${r.gate}.json`), JSON.stringify(r, null, 2) + '\n')
  const lines = [formatVerdict(r.verdict)]
  if (r.scope === 'changed') lines.push(`  scope ${r.files.length} changed source file(s) since ${r.base ?? '(no base)'}`)
  for (const l of r.loosened) lines.push(`  BLOCK baseline loosened: ${l}. Only a person may loosen ${BASELINE}; set CHB_ALLOW_BASELINE_LOOSEN=1 when you mean it.`)
  for (const u of r.untrusted) lines.push(`  note  not proof: ${u}`)
  // The last line is the ratchet number: blocking findings for a changed-scope check, every finding for the whole tree.
  lines.push(String(r.scope === 'changed' ? r.verdict.blocking + r.loosened.length : r.verdict.total))
  out(lines.join('\n'))
  process.exitCode = (r.scope === 'changed' || strict) && !r.pass ? 1 : 0
}

export function cmdBaseline(args: Args): void {
  const sub = args.pos[0]
  const root = repoRoot()
  if (sub === 'check') {
    const base = opt(args, 'base') ?? defaultBase(root)
    const mb = base ? mergeBase(base, root) : null
    const before = mb ? showAt(mb, BASELINE, root) : null
    if (!before) return out(`baseline: nothing to compare with at the merge-base with ${base ?? '(no base)'}`)
    const l = loosened(parseBaseline(before), readBaseline(root))
    out(l.length ? l.map(x => `loosened: ${x}`).join('\n') : 'baseline: not loosened')
    process.exitCode = l.length ? 1 : 0
    return
  }
  if (sub !== 'write') die('usage: chb baseline write [--skip crap,dry,mutate] [--no-run] [--allow-loosen] | chb baseline check [--base <ref>]')
  const skip = new Set((opt(args, 'skip') ?? '').split(',').filter(Boolean))
  const run = !flag(args, 'no-run')
  const keep = fs.existsSync(path.join(root, BASELINE)) ? readBaseline(root) : undefined
  const pick = (g: Gate) => !skip.has(g)
  if (run) {
    const src = repoSource(root)
    if (!src.length) die('no tracked source files in a language the tools read', 2)
    for (const g of ['crap', 'dry'] as const) if (pick(g)) clearSnapshot(g, root)
    if (pick('crap')) runTool('crap', src, root)
    if (pick('dry')) runTool('dry', ['--threshold', String(keep?.thresholds.dry ?? 0.8), '--edn', ...src], root)
    if (pick('mutate')) runTool('mutate', src, root)
  }
  const next = buildBaseline({ crap: pick('crap') ? readCrap(root) : undefined, dry: pick('dry') ? readDry(root) : undefined, mutate: pick('mutate') ? readMutate(root) : undefined, keep })
  const l = keep && keep.at !== 'none' ? loosened(keep, next) : []
  if (l.length && !flag(args, 'allow-loosen')) die(`refusing to loosen ${BASELINE} (pass --allow-loosen if a person means it):\n${l.map(x => `  ${x}`).join('\n')}`, 1)
  fs.mkdirSync(path.dirname(path.join(root, BASELINE)), { recursive: true })
  fs.writeFileSync(path.join(root, BASELINE), JSON.stringify(next, null, 2) + '\n')
  out(`wrote ${BASELINE}: ${Object.keys(next.crap).length} CRAP, ${Object.values(next.dry).reduce((a, b) => a + b, 0)} duplicate, ${Object.values(next.mutate).reduce((a, b) => a + b, 0)} survivor entries. Commit it with CODEOWNERS review.`)
}

const num = (s: string | undefined): number | undefined => (s === undefined ? undefined : Number.isFinite(Number(s)) ? Number(s) : die(`not a number: ${s}`))
const head = (root: string): string | null => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout?.trim() || null
