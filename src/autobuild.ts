// The tier-0 auto-build path (CHB_AUTO_BUILD=tier0): a planned change is built without a person's approval when nothing a
// person's approval would catch, and no risk signal rig can see before the code exists, is present.
//
// rig's rule stands: a model never approves. chb never writes approval.json and never sets SDLC_HUMAN. Instead a person
// turns rig's plan gate off for the repo ("gates": {"plan": false} in .rig/sensors.json, a protected file, so through a
// reviewed PR). It is read from the base, so a change cannot turn it off for itself. A change with no approval is then
// built only when all of these hold:
//   - what rig's approvalRefusal checks before a person may approve: spec.md and plan.md exist, neither has an open
//     question, and every plan.md ## Files path is inside spec.md's ## Blast radius (the spec must have one);
//   - not tier 1 by rig's one-way-door signal: plan.md lists no ## Contracts;
//   - not tier 2: rig's `sdlc.ts weight <slug>` says light (no always-human path or access action in the blast radius,
//     and the intent did not ask for full planning);
//   - the branch changed only its own change folder and files inside the blast radius, and no harness file.
// Anything else waits for /rig:approve as before. Signals that exist only after the build (the diff's size, review
// findings) are rig-check's on the PR, and chb merge leaves a change that no person approved to a person.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { git } from './git.ts'
import { globToRe } from './tare.ts'
import { sectionPaths, approvalOf, type Approval } from './rig.ts'

export type Auto = { ok: boolean; why: string[] }

// CHB_AUTO_BUILD: unset or "off" is off; "tier0" is on; anything else is a mistake, not a quiet "off".
export function autoBuildOn(v = process.env.CHB_AUTO_BUILD): boolean {
  if (!v || v === 'off') return false
  if (v === 'tier0') return true
  throw new Error(`CHB_AUTO_BUILD=${v}: use tier0, or off`)
}

export function planGateOff(sensorsJson: string): boolean {
  try { return (JSON.parse(sensorsJson) as { gates?: { plan?: unknown } }).gates?.plan === false } catch { return false }
}

// ---------- rig's readings, restated (rig exposes approvalRefusal only through the human-only `approve`) ----------

// rig's section(): the body under `## <heading>`, up to the next `## ` heading.
const section = (text: string, heading: string): string => new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text.replace(/\r\n/g, '\n'))?.[1] ?? ''
const bullets = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(l => /^[-*]\s+\S/.test(l))

// rig's openQuestions: entries under `## Open questions` other than "none", and prose like "Q2 is still open".
export function openQuestions(text: string): string[] {
  const listed = section(text, 'Open questions').split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(l => l && !/^none\.?$/i.test(l))
  const prose = text.split('\n').filter(l => /\bQ\d+\b.*\b(?:still open|is open|unresolved)\b/i.test(l)).map(l => l.trim())
  return [...new Set([...listed, ...prose])]
}

// rig's outsideRadius: paths that neither equal a radius entry nor sit under a radius folder or glob.
const normPath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/:$/, '')
export function outsideRadius(paths: string[], radius: string[]): string[] {
  const entries = radius.map(normPath)
  const inside = (p: string): boolean => entries.some(r => r === p || p.startsWith(r.endsWith('/') ? r : `${r}/`) || (r.includes('*') && globToRe(r).test(p)))
  return paths.map(normPath).filter(p => !inside(p))
}

// rig's PROTECTED harness paths, plus every workflow and the agent briefs: never changed by a change no person approved.
// Built on first use: tare.ts reaches this module through dispatch.ts, so globToRe is not ready at load time.
const HARNESS = ['.rig/**', '.claude/**', '.claude-plugin/**', '.github/**', 'CLAUDE.md', 'AGENTS.md', 'CODEOWNERS']
const isHarness = (f: string): boolean => HARNESS.some(g => globToRe(g).test(f))

// ---------- the verdict ----------

export type AutoInput = { slug: string; spec: string; plan: string; diff: string[] }

// Pure: everything but rig's weight, which needs the branch checked out.
export function autoVerdict(i: AutoInput): Auto {
  const why: string[] = []
  if (!i.spec.trim()) why.push('no spec.md yet')
  if (!i.plan.trim()) why.push('no plan.md yet')
  if (why.length) return { ok: false, why }
  const open = [...openQuestions(i.spec).map(q => `spec.md: ${q}`), ...openQuestions(i.plan).map(q => `plan.md: ${q}`)]
  if (open.length) why.push(`${open.length} open question(s) for a person: ${open.slice(0, 2).join('; ')}${open.length > 2 ? ' …' : ''}`)
  const radius = /^##\s+Blast radius\s*$/m.test(i.spec) ? sectionPaths(i.spec, 'Blast radius') : null
  if (!radius) why.push('spec.md has no ## Blast radius, so nothing bounds what the build may touch')
  const planOut = radius ? outsideRadius(sectionPaths(i.plan, 'Files'), radius) : []
  if (planOut.length) why.push(`plan.md ## Files outside the blast radius: ${planOut.slice(0, 3).join(', ')}`)
  if (bullets(section(i.plan, 'Contracts')).length) why.push('plan.md lists contracts: a one-way door (rig tier 1)')
  const own = `.rig/changes/${i.slug}/`
  const changed = i.diff.filter(f => !f.startsWith(own))
  const harness = changed.filter(isHarness)
  if (harness.length) why.push(`the branch changes harness files: ${harness.slice(0, 3).join(', ')}`)
  const strays = radius ? outsideRadius(changed.filter(f => !harness.includes(f)), radius) : []
  if (strays.length) why.push(`the branch changes files outside the blast radius: ${strays.slice(0, 3).join(', ')}`)
  return { ok: !why.length, why }
}

// rig's `weight` verdict, as `sdlc.ts weight <slug> --json` prints it; null when rig could not give one.
export function weightVerdict(w: { weight?: string; reasons?: string[] } | null): Auto {
  if (!w || (w.weight !== 'light' && w.weight !== 'full')) return { ok: false, why: ["rig's `weight` gave no verdict (is rig up to date? /rig:upgrade)"] }
  return w.weight === 'light' ? { ok: true, why: [] } : { ok: false, why: [`rig plans it full (tier 2): ${(w.reasons ?? []).join('; ')}`] }
}

// ---------- reading a branch ----------

const show = (dir: string, ref: string, f: string): string => git(['show', `${ref}:${f}`], dir) ?? ''

export function branchApproval(dir: string, branch: string, slug: string): Approval {
  const ch = `.rig/changes/${slug}`
  return approvalOf(Object.fromEntries(['spec.md', 'plan.md', 'requirements.md'].map(n => [n, show(dir, branch, `${ch}/${n}`)])), show(dir, branch, `${ch}/approval.json`))
}

// rig's weight, run in a throwaway checkout of the branch. Only called once autoVerdict has passed, so the branch's own
// .rig/bin is the base's (it changed no harness file).
function rigWeight(dir: string, branch: string, slug: string): { weight?: string; reasons?: string[] } | null {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-weight-'))
  try {
    if (git(['worktree', 'add', '-q', '--detach', wt, branch], dir) === null) return null
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(wt, '.rig/bin/sdlc.ts'), 'weight', slug, '--json'], { cwd: wt, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: wt } })
    if (r.status !== 0) return null
    try { return JSON.parse(r.stdout) as { weight?: string; reasons?: string[] } } catch { return null }
  } finally {
    git(['worktree', 'remove', '--force', wt], dir)
    fs.rmSync(wt, { recursive: true, force: true })
  }
}

// The whole judgement for one unapproved change branch.
export function judgeAuto(dir: string, base: string, branch: string, slug: string): Auto {
  const ch = `.rig/changes/${slug}`
  const mb = git(['merge-base', base, branch], dir)?.trim()
  if (!mb) return { ok: false, why: [`no merge-base with ${base}`] }
  const diff = (git(['diff', '--name-only', '--no-renames', mb, branch], dir) ?? '').split('\n').filter(Boolean)
  const v = autoVerdict({ slug, spec: show(dir, branch, `${ch}/spec.md`), plan: show(dir, branch, `${ch}/plan.md`), diff })
  return v.ok ? weightVerdict(rigWeight(dir, branch, slug)) : v
}
