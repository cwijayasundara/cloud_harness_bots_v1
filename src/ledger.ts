// `chb ledger`: the Foreman's sweep. One row per open PR, classified Working / Blocked / Ready from facts only (checks,
// conflicts, proof.json on the branch), never from a model's opinion. State lives in GitHub (labels chb:working,
// chb:blocked, chb:ready), so it survives any bot's context limit and shows on a GitHub Project board for free.
import fs from 'node:fs'
import path from 'node:path'
import { type Args, flag, opt, out } from './cli.ts'
import { ghTry } from './gh.ts'
import { die } from './cli.ts'
import { listOpenPRs, getPR, repoFromRemote, ensureLabel, addLabel, removeLabel } from './github.ts'
import { slugFromBranch } from './rig.ts'
import type { Proof } from './proof.ts'

export type Check = { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }
export type PR = {
  number: number; title: string; url: string; headRefName: string; headRefOid: string; isDraft: boolean
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; reviewDecision: string | null; updatedAt: string
  additions: number; deletions: number; changedFiles: number; labels: { name: string }[]; statusCheckRollup: Check[] | null
}
export type Status = 'working' | 'blocked' | 'ready'
export type Row = { number: number; title: string; url: string; branch: string; slug: string | null; status: Status; reasons: string[]; checks: { ok: number; pending: number; failed: number }; proof: 'pass' | 'fail' | 'missing' | 'stale'; ageHours: number; lines: number; labels: string[] }

export const LABELS: Record<Status, string> = { working: 'chb:working', blocked: 'chb:blocked', ready: 'chb:ready' }
const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

export function checkCounts(rollup: Check[] | null): Row['checks'] {
  const c = { ok: 0, pending: 0, failed: 0 }
  for (const k of rollup ?? []) {
    const done = (k.conclusion ?? k.state ?? '').toUpperCase()
    if (FAILED.has(done)) c.failed++
    else if (done === 'SUCCESS' || done === 'NEUTRAL' || done === 'SKIPPED') c.ok++
    else c.pending++
  }
  return c
}

// Pure. `proofCurrent` says whether every commit after proof.head only touched change records (.rig/changes/**).
export function classify(pr: PR, proof: Proof | null, proofCurrent: boolean, now: Date, stallHours = 24): Row {
  const checks = checkCounts(pr.statusCheckRollup)
  const ageHours = Math.round((now.getTime() - Date.parse(pr.updatedAt)) / 36e5)
  const proofState: Row['proof'] = !proof ? 'missing' : !proofCurrent ? 'stale' : proof.pass ? 'pass' : 'fail'
  const blocked: string[] = [], working: string[] = []
  if (pr.mergeable === 'CONFLICTING') blocked.push('merge conflict: rebase on the base branch')
  if (checks.failed) blocked.push(`${checks.failed} failing check(s)`)
  if (proofState === 'fail') blocked.push(`proof: ${proof!.reasons.slice(0, 2).join('; ')}`)
  if (pr.reviewDecision === 'CHANGES_REQUESTED') blocked.push('changes requested by a reviewer')
  if (pr.isDraft) working.push('draft')
  if (checks.pending) working.push(`${checks.pending} check(s) pending`)
  if (proofState === 'missing') working.push('no proof.json on the branch: run chb proof after /rig:pr')
  if (proofState === 'stale') working.push('proof.json is older than the code: rerun the gates and chb proof')
  if (!blocked.length && working.length && ageHours >= stallHours) blocked.push(`stalled: no update for ${ageHours} h`)
  const status: Status = blocked.length ? 'blocked' : working.length ? 'working' : 'ready'
  return { number: pr.number, title: pr.title, url: pr.url, branch: pr.headRefName, slug: slugFromBranch(pr.headRefName), status, reasons: blocked.length ? blocked : working, checks, proof: proofState, ageHours, lines: pr.additions + pr.deletions, labels: pr.labels.map(l => l.name) }
}

export function fetchProof(repo: string, pr: PR): { proof: Proof | null; current: boolean } {
  const slug = slugFromBranch(pr.headRefName)
  if (!slug) return { proof: null, current: false }
  const raw = ghTry(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/.rig/changes/${slug}/proof.json?ref=${encodeURIComponent(pr.headRefName)}`])
  if (!raw) return { proof: null, current: false }
  let proof: Proof
  try { proof = JSON.parse(raw) as Proof } catch { return { proof: null, current: false } }
  // Current only when proof.head is on this branch and nothing but this change's proof.json changed after it.
  // A proof with no head, or any later edit to code, verify.json or review.md, makes it stale.
  if (!proof.head || !/^[0-9a-f]{7,40}$/.test(proof.head)) return { proof, current: false }
  if (proof.head === pr.headRefOid) return { proof, current: true }
  const cmp = ghTry(['api', `repos/${repo}/compare/${proof.head}...${pr.headRefOid}`, '--jq', '{status: .status, files: [.files[] | .filename, (.previous_filename // empty)]}'])
  const c = cmp ? (JSON.parse(cmp) as { status: string; files: string[] }) : null
  return { proof, current: Boolean(c && c.status === 'ahead' && c.files.every(f => f === `.rig/changes/${slug}/proof.json`)) }
}

export const repoName = (r?: string): string => r ?? repoFromRemote() ?? die('no --repo owner/name and no github.com origin remote here')

export function sweep(repo: string, now = new Date()): Row[] {
  return listOpenPRs(repo).map(b => { const pr = getPR(repo, b); const { proof, current } = fetchProof(repo, pr); return classify(pr, proof, current, now) })
}

export function renderMarkdown(rows: Row[], at: string): string {
  const order: Status[] = ['blocked', 'ready', 'working']
  const lines = [`# PR ledger · ${at}`, '', `${rows.filter(r => r.status === 'ready').length} ready · ${rows.filter(r => r.status === 'blocked').length} blocked · ${rows.filter(r => r.status === 'working').length} working`, '', '| PR | Status | Proof | Checks ok/pend/fail | Lines | Age h | Why |', '| --- | --- | --- | --- | --- | --- | --- |']
  for (const s of order) for (const r of rows.filter(x => x.status === s))
    lines.push(`| [#${r.number}](${r.url}) ${r.title.replace(/\|/g, '/')} | ${r.status} | ${r.proof} | ${r.checks.ok}/${r.checks.pending}/${r.checks.failed} | ${r.lines} | ${r.ageHours} | ${r.reasons.join('; ').replace(/\|/g, '/')} |`)
  return lines.join('\n') + '\n'
}

export function applyLabels(repo: string, rows: Row[]): void {
  if (rows.length) for (const s of Object.values(LABELS)) ensureLabel(repo, s, s.endsWith('ready') ? '0e8a16' : s.endsWith('blocked') ? 'd73a4a' : 'fbca04')
  for (const r of rows) {
    if (!r.labels.includes(LABELS[r.status])) addLabel(repo, r.number, LABELS[r.status])
    for (const l of Object.values(LABELS)) if (l !== LABELS[r.status] && r.labels.includes(l)) removeLabel(repo, r.number, l)
  }
}

export function cmdLedger(args: Args): void {
  const repo = repoName(opt(args, 'repo'))
  const at = new Date().toISOString()
  const rows = sweep(repo)
  if (flag(args, 'labels')) applyLabels(repo, rows)
  const history = opt(args, 'history')
  if (history) { fs.mkdirSync(path.dirname(path.resolve(history)), { recursive: true }); fs.appendFileSync(history, JSON.stringify({ at, repo, rows }) + '\n') }
  const md = renderMarkdown(rows, at)
  const file = opt(args, 'out')
  if (file) fs.writeFileSync(file, md)
  out(flag(args, 'json') ? JSON.stringify({ at, repo, rows }) : md)
}
