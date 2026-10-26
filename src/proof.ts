// `chb proof [<slug>]`: one machine-readable record of why a change is done, written to .rig/changes/<slug>/proof.json
// and committed with the change. The Foreman bot reads this file from the PR branch instead of reading the diff:
// rig's verify.json, the three gate results (each stamped with the HEAD it judged), the review verdict and the diff size.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Args, flag, opt, out, die } from './cli.ts'
import { git, defaultBase, repoRoot } from './git.ts'
import { RESULTS, type GateResult } from './gate.ts'
import { CHANGES, activeSlug, frontmatter, toType, parseVerify, parseReview, readChangeFile, type ChangeType, type Review } from './rig.ts'

export type GateSummary = { pass: boolean; blocking: number; total: number; scope: string; head: string | null; stale: boolean; untrusted: string[] } | null
export type Proof = {
  version: 1
  slug: string
  type: ChangeType
  at: string
  head: string | null
  base: string | null
  verify: { pass: boolean; at: string | null; blocks: string[]; fresh: boolean | null } | null
  gates: { crap: GateSummary; dry: GateSummary; mutate: GateSummary }
  review: { verdict: Review['verdict']; openHigh: number; open: number }
  diff: { files: number; added: number; deleted: number }
  pass: boolean
  reasons: string[]
}

export const REQUIRED_GATES = (process.env.CHB_REQUIRED_GATES ?? 'crap,dry').split(',').filter(Boolean) as ('crap' | 'dry' | 'mutate')[]

// Pure: the verdict from the pieces. Kept separate so the merge policy and the tests share one definition of "done".
export function decide(p: Omit<Proof, 'pass' | 'reasons'>, required = REQUIRED_GATES): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!p.verify) reasons.push('no verify.json: run /rig:test')
  else if (!p.verify.pass) reasons.push(`verify failed: ${p.verify.blocks.slice(0, 3).join('; ')}`)
  else if (p.verify.fresh === false) reasons.push('verify.json judged another tree: rerun /rig:test')
  else if (p.verify.fresh === null) reasons.push('cannot tell whether verify.json is current (no .rig/bin/sdlc.ts stamp)')
  for (const g of required) {
    const s = p.gates[g]
    if (!s) reasons.push(`${g} gate not run: chb gate ${g}`)
    else if (s.stale) reasons.push(`${g} gate judged ${s.head?.slice(0, 7) ?? 'an unknown commit'}, not HEAD: rerun chb gate ${g}`)
    else if (s.untrusted.length) reasons.push(`${g} gate result is not proof: ${s.untrusted.join('; ')}`)
    else if (!s.pass) reasons.push(`${g} gate: ${s.blocking} blocking finding(s)`)
  }
  if (p.review.verdict === 'missing') reasons.push('no review.md: /rig:pr writes it; run chb proof after /rig:pr')
  if (p.review.openHigh) reasons.push(`review: ${p.review.openHigh} open critical/high finding(s)`)
  return { pass: reasons.length === 0, reasons }
}

function gateSummary(root: string, gate: 'crap' | 'dry' | 'mutate', head: string | null): GateSummary {
  const f = path.join(root, RESULTS, `${gate}.json`)
  if (!fs.existsSync(f)) return null
  const r = JSON.parse(fs.readFileSync(f, 'utf8')) as GateResult
  return { pass: r.pass, blocking: r.verdict.blocking + r.loosened.length, total: r.verdict.total, scope: r.scope, head: r.head, stale: !head || !r.head || r.head !== head, untrusted: r.untrusted ?? ['result written by an older chb'] }
}

// rig's own tree stamp (the working tree with .rig/ left out), the same check rig's verifyFresh makes.
let stampCache: { root: string; v: string | null } | null = null
export function rigStamp(root: string): string | null {
  if (stampCache?.root === root) return stampCache.v
  const sdlc = path.join(root, '.rig/bin/sdlc.ts')
  let v: string | null = null
  if (fs.existsSync(sdlc)) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', sdlc, 'stamp'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
    const t = r.status === 0 ? r.stdout.trim() : ''
    v = t && t !== 'none' ? t : null
  }
  stampCache = { root, v }
  return v
}

export function buildProof(root: string, slug: string, base: string | null): Proof {
  const head = git(['rev-parse', 'HEAD'], root)?.trim() || null
  const v = parseVerify(readChangeFile(root, slug, 'verify.json'))
  const review = parseReview(readChangeFile(root, slug, 'review.md'))
  const mb = base ? git(['merge-base', base, 'HEAD'], root)?.trim() : null
  const stat = (mb ? git(['diff', '--numstat', mb], root) : '') ?? ''
  const rows = stat.split('\n').filter(Boolean).map(l => l.split('\t'))
  const diff = { files: rows.length, added: rows.reduce((n, r) => n + (Number(r[0]) || 0), 0), deleted: rows.reduce((n, r) => n + (Number(r[1]) || 0), 0) }
  const p = {
    version: 1 as const, slug, type: toType(frontmatter(readChangeFile(root, slug, 'intent.md') ?? '').type), at: new Date().toISOString(), head, base,
    verify: v ? { pass: v.pass, at: v.at, blocks: v.blocks, fresh: rigStamp(root) === null ? null : v.tree === rigStamp(root) } : null,
    gates: { crap: gateSummary(root, 'crap', head), dry: gateSummary(root, 'dry', head), mutate: gateSummary(root, 'mutate', head) },
    review: { verdict: review.verdict, openHigh: review.open.filter(o => o.severity === 'critical' || o.severity === 'high').length, open: review.open.length },
    diff,
  }
  return { ...p, ...decide(p) }
}

export function cmdProof(args: Args): void {
  const root = repoRoot()
  const slug = args.pos[0] ?? activeSlug(root)
  if (!slug || !fs.existsSync(path.join(root, CHANGES, slug))) die('usage: chb proof [<slug>] [--base <ref>] [--json] (no active rig change found)')
  const p = buildProof(root, slug, opt(args, 'base') ?? defaultBase(root))
  fs.writeFileSync(path.join(root, CHANGES, slug, 'proof.json'), JSON.stringify(p, null, 2) + '\n')
  if (flag(args, 'json')) out(JSON.stringify(p))
  else out([`proof ${slug} (${p.type}): ${p.pass ? 'PASS' : 'NOT DONE'}`, ...p.reasons.map(r => `  - ${r}`), `wrote ${CHANGES}/${slug}/proof.json: commit it with the change`].join('\n'))
  process.exitCode = p.pass ? 0 : 1
}
