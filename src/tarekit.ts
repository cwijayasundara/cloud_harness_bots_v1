// Keeping Tare honest over time (Masterstock improvement plan, phases 2–4):
//   chb tare status   [--tare SKILL.md] [--log log.md] [--repos …|--workspace …]  provenance, checks that make lines removable, copies that drifted
//   chb tare sync     --tare SKILL.md --repos …|--workspace … [--write]          make every repo's copy the canonical one
//   chb tare variants --tare SKILL.md --out <dir>                               one Tare per removed line, plus a replay arms file
//
// The Tare log sits next to SKILL.md (log.md): one entry per rule, `- key: <words that find the line> | added <date> |
// source: <evidence> | check: <sensor id or none>`. A line nobody can trace is opinion; a line whose check already blocks
// in every repo is dead weight; a line whose removal changes no replay outcome should go (variants + chb replay).
import fs from 'node:fs'
import path from 'node:path'
import { type Args, flag, opt, out, die } from './cli.ts'
import { tareLines, repoDirs } from './lessons.ts'
import { pkgRoot } from './pkg.ts'
import { TARE_PATH } from './dispatch.ts'
import { DEFAULT_ARMS, type Arm } from './replay.ts'

export type LogEntry = { key: string; added: string; source: string; check: string | null }

export function parseLog(text: string): LogEntry[] {
  return text.split('\n').filter(l => l.startsWith('- key: ')).map(l => {
    const f = Object.fromEntries(l.slice(2).split(' | ').map(p => { const i = p.indexOf(' '); const k = p.slice(0, i).replace(/:$/, ''); return [k, p.slice(i + 1).trim()] }))
    return { key: f.key ?? '', added: f.added ?? '', source: f.source ?? '', check: f.check && f.check !== 'none' ? f.check : null }
  }).filter(e => e.key)
}

const read = (f: string): string => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const defaultTare = (): string => path.join(pkgRoot(), 'skills/tare/SKILL.md')
const tareArg = (args: Args): string => path.resolve(opt(args, 'tare') ?? defaultTare())

export type Status = {
  lines: number; bodyLines: number; untraced: string[]; staleLog: string[]
  checks: { check: string; line: string; blocking: string[]; advisory: string[]; missing: string[] }[]
  drift: { repo: string; state: 'same' | 'differs' | 'missing' }[]
}

export function status(tareText: string, logText: string, repos: string[]): Status {
  const lines = tareLines(tareText), log = parseLog(logText)
  const has = (line: string, e: LogEntry) => line.toLowerCase().includes(e.key.toLowerCase())
  const sensors = repos.map(r => ({ repo: path.basename(r), list: ((): { id: string; blocks?: boolean; enabled?: boolean }[] => { try { return (JSON.parse(read(path.join(r, '.rig/sensors.json'))) as { sensors?: { id: string; blocks?: boolean }[] }).sensors ?? [] } catch { return [] } })() }))
  const checks: Status['checks'] = []
  for (const e of log.filter(e => e.check)) {
    const line = lines.find(l => has(l, e)) ?? e.key
    const c = { check: e.check!, line, blocking: [] as string[], advisory: [] as string[], missing: [] as string[] }
    for (const s of sensors) { const x = s.list.find(y => y.id === e.check && y.enabled !== false); (x ? (x.blocks ? c.blocking : c.advisory) : c.missing).push(s.repo) }
    checks.push(c)
  }
  return {
    lines: lines.length, bodyLines: tareText.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').filter(l => l.trim()).length,
    untraced: lines.filter(l => !log.some(e => has(l, e))),
    staleLog: log.filter(e => !lines.some(l => has(l, e))).map(e => e.key),
    checks,
    drift: repos.map(r => { const copy = path.join(r, TARE_PATH); return { repo: path.basename(r), state: !fs.existsSync(copy) ? 'missing' : read(copy) === tareText ? 'same' : 'differs' } }),
  }
}

export function renderStatus(s: Status, repos: number): string {
  const L = [`Tare: ${s.lines} rule(s), ${s.bodyLines} non-empty line(s) (plan target: 30 or fewer)`]
  for (const u of s.untraced) L.push(`  untraced  "${u.slice(0, 90)}": no log entry says where it came from; add one, or delete the line`)
  for (const k of s.staleLog) L.push(`  stale log "${k}": no Tare line has these words any more`)
  for (const c of s.checks) {
    if (!repos) { L.push(`  check     ${c.check} enforces "${c.line.slice(0, 60)}" (pass --repos or --workspace to see where it blocks)`); continue }
    if (c.blocking.length === repos) L.push(`  removable "${c.line.slice(0, 70)}": ${c.check} blocks in all ${repos} repo(s). Once it has blocked for a week, delete the line and mark the log entry`)
    else L.push(`  check     ${c.check}: blocking in ${c.blocking.length}, advisory in ${c.advisory.length}, missing in ${c.missing.length} of ${repos} repo(s)${c.missing.length ? ` (chb install . in ${c.missing.join(', ')})` : ''}`)
  }
  for (const d of s.drift.filter(d => d.state !== 'same')) L.push(`  drift     ${d.repo}: its ${TARE_PATH} ${d.state === 'missing' ? 'is missing' : 'differs from the canonical Tare'} (chb tare sync --write)`)
  if (L.length === 1) L.push('  every line traced, nothing removable yet, no drift')
  return L.join('\n')
}

export function cmdTareStatus(args: Args): void {
  const tare = tareArg(args)
  if (!fs.existsSync(tare)) die(`${tare} not found (pass --tare <SKILL.md>)`)
  const log = opt(args, 'log') ?? path.join(path.dirname(tare), 'log.md')
  const repos = opt(args, 'repos') || opt(args, 'workspace') ? repoDirs(args) : []
  const s = status(read(tare), read(log), repos)
  out(flag(args, 'json') ? JSON.stringify(s, null, 2) : renderStatus(s, repos.length))
}

export function cmdTareSync(args: Args): void {
  const tare = tareArg(args)
  if (!fs.existsSync(tare)) die(`${tare} not found (pass --tare <SKILL.md>)`)
  const repos = repoDirs(args)
  if (!repos.length) die('usage: chb tare sync --tare <SKILL.md> --repos <dir,…> | --workspace <dir> [--write]')
  const text = read(tare), write = flag(args, 'write')
  const lines: string[] = []
  for (const r of repos) {
    const copy = path.join(r, TARE_PATH)
    if (read(copy) === text) { lines.push(`same     ${path.basename(r)}`); continue }
    if (write) { fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.writeFileSync(copy, text) }
    lines.push(`${write ? 'written ' : 'differs '} ${path.basename(r)}`)
  }
  out([...lines, write ? `Commit ${TARE_PATH} in each written repo through a reviewed PR (.claude/ is protected).` : 'Dry run: pass --write to copy the canonical Tare into the repos that differ.'].join('\n'))
}

// One variant per rule: Tare with that bullet (and its continuation lines) removed. Replay each against the full Tare;
// a line whose removal changes no outcome is not earning its tokens.
export function variants(text: string): { index: number; line: string; text: string }[] {
  const all = text.split('\n')
  const fmEnd = all[0] === '---' ? all.indexOf('---', 1) + 1 : 0
  const outp: { index: number; line: string; text: string }[] = []
  for (let i = fmEnd; i < all.length; i++) {
    if (!/^- /.test(all[i]!)) continue
    let j = i + 1
    while (j < all.length && /^\s{2,}\S/.test(all[j]!)) j++
    outp.push({ index: outp.length + 1, line: all.slice(i, j).map(l => l.trim()).join(' ').slice(2), text: [...all.slice(0, i), ...all.slice(j)].join('\n') })
  }
  return outp
}

export function cmdTareVariants(args: Args): void {
  const tare = tareArg(args), dir = opt(args, 'out')
  if (!fs.existsSync(tare) || !dir) die('usage: chb tare variants --tare <SKILL.md> --out <dir>')
  const vs = variants(read(tare))
  fs.mkdirSync(dir, { recursive: true })
  const base = DEFAULT_ARMS.find(a => a.name === 'rig')!.prompt // the rig arm's prompt, as chb replay runs it
  const arms: Arm[] = [{ name: 'tare-full', tare: path.resolve(tare), prompt: base }]
  const index: string[] = ['# Tare variants', '', 'Each file is Tare without one rule. Replay them against tare-full; delete a rule whose removal changes no outcome.', '']
  for (const v of vs) {
    const f = path.resolve(dir, `without-${String(v.index).padStart(2, '0')}.md`)
    fs.writeFileSync(f, v.text)
    arms.push({ name: `tare-minus-${String(v.index).padStart(2, '0')}`, tare: f, prompt: base })
    index.push(`- ${path.basename(f)}: without "${v.line.slice(0, 100)}"`)
  }
  fs.writeFileSync(path.join(dir, 'arms.json'), JSON.stringify(arms, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'README.md'), index.join('\n') + '\n')
  out(`${vs.length} variant(s) and arms.json in ${dir}. Each arm costs a full replay: start with one model and one run, e.g.\n  chb replay run --arms ${path.join(dir, 'arms.json')} --models sonnet --runs 1\n  chb replay report --baseline tare-full`)
}
