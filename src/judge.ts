// Pure verdicts over the snapshots. A finding is "legacy" when the committed baseline already holds that debt at the
// same or a worse level (it warns), and "new" otherwise (it blocks). This is ub-mode's "Then Make it Right" as a
// ratchet per function: new code meets the bar, old code may not get worse, and nobody is blamed for debt they found.
import type { CrapEntry, DryCandidate, MutateForm } from './snapshots.ts'

export type Baseline = {
  version: 1
  at: string
  thresholds: { crap: number; dry: number }
  crap: Record<string, number>   // "<namespace>#<name>" → CRAP score at or above the threshold
  dry: Record<string, number>    // "<fileA>|<fileB>" (sorted) → candidate pairs at or above the threshold
  mutate: Record<string, number> // "<namespace>#<form id>" → surviving mutants
}

export type Finding = { gate: 'crap' | 'dry' | 'mutate'; key: string; level: 'new' | 'legacy'; value: number; baseline: number | null; message: string }
export type Verdict = { gate: Finding['gate']; findings: Finding[]; blocking: number; total: number; notes: string[] }

export const DEFAULTS = { crap: 10, dry: 0.8 } as const
export const EPS = 1e-6

export const emptyBaseline = (at = new Date().toISOString()): Baseline => ({ version: 1, at, thresholds: { ...DEFAULTS }, crap: {}, dry: {}, mutate: {} })

export const crapKey = (e: Pick<CrapEntry, 'namespace' | 'name'>): string => `${e.namespace}#${e.name}`
export const dryKey = (c: DryCandidate): string => [norm(c.left.file), norm(c.right.file)].sort().join('|')
export const mutateKey = (f: Pick<MutateForm, 'namespace' | 'id'>): string => `${f.namespace}#${f.id}`
export const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

const verdict = (gate: Finding['gate'], findings: Finding[], notes: string[] = []): Verdict =>
  ({ gate, findings, blocking: findings.filter(f => f.level === 'new').length, total: findings.length, notes })

// ub-mode: "Reduce each function under CRAP 10". A score at or above `max` is a finding.
export function judgeCrap(entries: CrapEntry[], base: Baseline, max = base.thresholds.crap): Verdict {
  const notes: string[] = []
  const unscored = entries.filter(e => e.crap === null).length
  if (unscored) notes.push(`${unscored} function(s) had no coverage, so no CRAP score (crapper --no-coverage, or a failed test run)`)
  const findings = entries.filter(e => e.crap !== null && e.crap >= max).sort((a, b) => (b.crap ?? 0) - (a.crap ?? 0)).map((e): Finding => {
    const key = crapKey(e), was = base.crap[key] ?? null
    const level = was !== null && (e.crap as number) <= was + 0.01 ? 'legacy' : 'new' // the baseline stores 2 decimals
    const why = was === null ? 'new function over the bar' : level === 'legacy' ? `legacy, baseline ${was}` : `worse than baseline ${was}`
    return { gate: 'crap', key, level, value: e.crap as number, baseline: was, message: `${key} CRAP ${round(e.crap as number)} (CC ${e.complexity}, coverage ${e.coverage ?? 'n/a'}%) ≥ ${max}: ${why}. Split it, test it, or both.` }
  })
  return verdict('crap', findings, notes)
}

// ub-mode: "eliminate duplication that ranks 0.8 or above". Pairs are counted per file pair, because line numbers move.
export function judgeDry(cands: DryCandidate[], base: Baseline, min = base.thresholds.dry, only?: Set<string>): Verdict {
  const hits = cands.filter(c => c.score >= min - EPS && (!only || only.has(norm(c.left.file)) || only.has(norm(c.right.file))))
  const byPair = new Map<string, DryCandidate[]>()
  for (const c of hits) byPair.set(dryKey(c), [...(byPair.get(dryKey(c)) ?? []), c])
  const findings: Finding[] = []
  for (const [key, list] of [...byPair].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const was = base.dry[key] ?? 0
    list.sort((a, b) => b.score - a.score).forEach((c, i) => {
      const level = i < was ? 'legacy' : 'new'
      findings.push({ gate: 'dry', key, level, value: c.score, baseline: was || null,
        message: `${norm(c.left.file)}:${c.left.startLine}-${c.left.endLine} ≈ ${norm(c.right.file)}:${c.right.startLine}-${c.right.endLine} score ${round(c.score)} ≥ ${min}: ${level === 'legacy' ? 'legacy duplicate' : 'new duplicate'}. Extract the shared shape once.` })
    })
  }
  return verdict('dry', findings)
}

// ub-mode: "Kill the survivors. Cover the uncovered. Delete dead code."
export function judgeMutate(forms: MutateForm[], base: Baseline, only?: Set<string>): Verdict {
  const notes: string[] = []
  const scoped = only ? forms.filter(f => only.has(norm(f.file)) || only.has(norm(f.source))) : forms
  const uncovered = scoped.reduce((n, f) => n + f.uncovered, 0)
  if (uncovered) notes.push(`${uncovered} mutation site(s) on uncovered lines were not run: cover them or delete the code`)
  const findings = scoped.filter(f => f.survived > 0).sort((a, b) => b.survived - a.survived).map((f): Finding => {
    const key = mutateKey(f), was = base.mutate[key] ?? null
    const level = was !== null && f.survived <= was ? 'legacy' : 'new'
    return { gate: 'mutate', key, level, value: f.survived, baseline: was,
      message: `${key} (${norm(f.file)}:${f.line}-${f.endLine}) ${f.survived} surviving mutant(s) of ${f.sites}: ${level === 'legacy' ? `legacy, baseline ${was}` : 'a test must fail when this code changes'}.` }
  })
  return verdict('mutate', findings, notes)
}

// Build a baseline from whole-tree snapshots: only debt at or over the bar is recorded.
export function buildBaseline(i: { crap?: CrapEntry[]; dry?: DryCandidate[]; mutate?: MutateForm[]; thresholds?: Partial<Baseline['thresholds']>; at?: string; keep?: Baseline }): Baseline {
  const b = emptyBaseline(i.at)
  b.thresholds = { ...DEFAULTS, ...i.keep?.thresholds, ...i.thresholds }
  // Max per key: Java overloads (and repeated mutate ids) share a key, and the worst one must not read as "worse than baseline".
  if (i.crap) for (const e of i.crap) { if (e.crap !== null && e.crap >= b.thresholds.crap) b.crap[crapKey(e)] = Math.max(b.crap[crapKey(e)] ?? 0, round(e.crap)) }
  if (!i.crap && i.keep) b.crap = { ...i.keep.crap }
  if (i.dry) for (const c of i.dry) if (c.score >= b.thresholds.dry - EPS) b.dry[dryKey(c)] = (b.dry[dryKey(c)] ?? 0) + 1
  if (!i.dry && i.keep) b.dry = { ...i.keep.dry }
  if (i.mutate) for (const f of i.mutate) if (f.survived > 0) b.mutate[mutateKey(f)] = Math.max(b.mutate[mutateKey(f)] ?? 0, f.survived)
  if (!i.mutate && i.keep) b.mutate = { ...i.keep.mutate }
  return b
}

// What an edit to the baseline loosens: a threshold relaxed, a key added, or a value raised. Only a person may do that,
// so the gates block on it, the same way rig blocks a loosened ratchets.json.
export function loosened(before: Baseline, after: Baseline): string[] {
  const out: string[] = []
  if (after.thresholds.crap > before.thresholds.crap) out.push(`crap threshold raised ${before.thresholds.crap} → ${after.thresholds.crap}`)
  if (after.thresholds.dry > before.thresholds.dry) out.push(`dry threshold raised ${before.thresholds.dry} → ${after.thresholds.dry}`)
  for (const g of ['crap', 'dry', 'mutate'] as const)
    for (const [k, v] of Object.entries(after[g])) {
      const was = before[g][k]
      if (was === undefined) out.push(`${g} ${k} added to the baseline (${v})`)
      else if (v > was + EPS) out.push(`${g} ${k} raised ${was} → ${v}`)
    }
  return out
}

export function parseBaseline(text: string | null): Baseline {
  if (!text) return emptyBaseline('none')
  const j = JSON.parse(text) as Partial<Baseline>
  return { version: 1, at: j.at ?? 'unknown', thresholds: { ...DEFAULTS, ...j.thresholds }, crap: j.crap ?? {}, dry: j.dry ?? {}, mutate: j.mutate ?? {} }
}

export const round = (n: number): number => Math.round(n * 100) / 100

// What the agent should do about a blocking finding: lint messages are instructions, not just verdicts.
export const FIX: Record<Finding['gate'], string> = {
  crap: 'add tests that reach the uncovered branches, or split the function until each part scores under the threshold; never edit .rig/ub-baseline.json',
  dry: 'move the shared logic into one function or module that both places call, then delete the copy',
  mutate: 'add an assertion that fails when this code changes (a surviving mutant means no test notices), or delete the code if nothing needs it',
}

export function formatVerdict(v: Verdict): string {
  const lines = [`${v.gate}: ${v.blocking} new, ${v.total - v.blocking} legacy`]
  for (const f of v.findings) {
    lines.push(`  ${f.level === 'new' ? 'BLOCK' : 'warn '} ${f.message}`)
    if (f.level === 'new') lines.push(`        fix: ${FIX[f.gate]}`)
  }
  for (const n of v.notes) lines.push(`  note  ${n}`)
  return lines.join('\n')
}
