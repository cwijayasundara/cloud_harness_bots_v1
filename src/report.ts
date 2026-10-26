// `chb report [--days 7]`: the measures from the proposal, computed from GitHub and the repo, never estimated.
//   merged changes, median lead time, auto-merged share, reverts (escaped defects), overnight yield,
//   your hands-on minutes per merged change (from a touch log the Foreman appends to), and the debt trend in
//   .rig/ub-baseline.json (CRAP entries, duplicate pairs, surviving mutants) now vs the start of the window.
import fs from 'node:fs'
import { type Args, flag, opt, out } from './cli.ts'
import { mergedSince } from './github.ts'
import { git, repoRoot } from './git.ts'
import { repoName } from './ledger.ts'
import { parseBaseline, type Baseline } from './judge.ts'
import { BASELINE } from './gate.ts'

export type Merged = { number: number; title: string; createdAt: string; mergedAt: string; additions: number; deletions: number; labels: { name: string }[] }
export type Touch = { at: string; minutes: number; note: string }

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export const localHour = (iso: string, tz: string): number =>
  Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso)))

// "Overnight": created after the evening hand-off and merged-ready by the morning brief; here, created 20:00–07:59 local.
export const overnight = (iso: string, tz: string): boolean => { const h = localHour(iso, tz); return h >= 20 || h < 8 }

export const debt = (b: Baseline) => ({
  crap: Object.keys(b.crap).length,
  dry: Object.values(b.dry).reduce((a, c) => a + c, 0),
  mutate: Object.values(b.mutate).reduce((a, c) => a + c, 0),
})

export function parseTouchLog(text: string): Touch[] {
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { const [at, m, ...note] = l.split(','); return { at: at ?? '', minutes: Number(m), note: note.join(',').trim() } }).filter(t => Number.isFinite(t.minutes) && !Number.isNaN(Date.parse(t.at)))
}

export function summarise(prs: Merged[], touches: Touch[], since: Date, tz: string, debtNow: ReturnType<typeof debt>, debtThen: ReturnType<typeof debt> | null) {
  const lead = prs.map(p => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 36e5)
  const minutes = touches.filter(t => Date.parse(t.at) >= since.getTime()).reduce((a, t) => a + t.minutes, 0)
  return {
    merged: prs.length,
    leadHoursMedian: median(lead),
    autoMerged: prs.filter(p => p.labels.some(l => l.name === 'chb:automerged')).length,
    reverts: prs.filter(p => /^revert/i.test(p.title)).length,
    overnight: prs.filter(p => overnight(p.createdAt, tz)).length,
    linesChanged: prs.reduce((a, p) => a + p.additions + p.deletions, 0),
    handsOnMinutes: minutes,
    handsOnMinutesPerChange: prs.length ? Math.round((minutes / prs.length) * 10) / 10 : null,
    debtNow, debtThen,
  }
}

export function cmdReport(args: Args): void {
  const days = Number(opt(args, 'days') ?? 7)
  const tz = process.env.CHB_TZ ?? 'Europe/London'
  const since = new Date(Date.now() - days * 864e5)
  const repo = repoName(opt(args, 'repo'))
  const prs: Merged[] = mergedSince(repo, since)
  const logFile = opt(args, 'touch-log')
  const touches = logFile && fs.existsSync(logFile) ? parseTouchLog(fs.readFileSync(logFile, 'utf8')) : []
  const root = repoRoot()
  const nowB = fs.existsSync(`${root}/${BASELINE}`) ? parseBaseline(fs.readFileSync(`${root}/${BASELINE}`, 'utf8')) : null
  const then = git(['rev-list', '-1', `--before=${since.toISOString()}`, 'HEAD'], root)?.trim()
  const thenText = then ? git(['show', `${then}:${BASELINE}`], root) : null
  const s = summarise(prs, touches, since, tz, debt(nowB ?? parseBaseline(null)), thenText ? debt(parseBaseline(thenText)) : null)
  if (flag(args, 'json')) return out(JSON.stringify({ repo, days, since: since.toISOString(), ...s }))
  const d = (k: 'crap' | 'dry' | 'mutate') => `${s.debtNow[k]}${s.debtThen ? ` (was ${s.debtThen[k]})` : ''}`
  out([
    `# ${repo} · last ${days} days`, '',
    '| Measure | Value |', '| --- | --- |',
    `| Merged changes | ${s.merged} |`,
    `| Median lead time, opened → merged | ${s.leadHoursMedian === null ? 'n/a' : `${Math.round(s.leadHoursMedian * 10) / 10} h`} |`,
    `| Auto-merged | ${s.autoMerged} |`,
    `| Reverts (escaped defects) | ${s.reverts} |`,
    `| Opened overnight (20:00–08:00 ${tz}) | ${s.overnight} |`,
    `| Your hands-on minutes | ${logFile ? `${s.handsOnMinutes} (${s.handsOnMinutesPerChange ?? 'n/a'} per change)` : 'no --touch-log given'} |`,
    `| Baseline CRAP entries ≥ bar | ${d('crap')} |`,
    `| Baseline duplicate pairs | ${d('dry')} |`,
    `| Baseline surviving mutants | ${d('mutate')} |`,
  ].join('\n'))
}
