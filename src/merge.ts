// `chb merge <pr> [--go]`: the auto-merge policy. Dry by default: it prints the decision and every reason.
// A PR merges itself only when ALL hold (the guide's "confident review, low blast radius", in rig's terms):
//   ledger status ready (checks green, no conflict, proof.json passes and is current)
//   the required checks are present and green (rig-check enforces rig's human-approval rule)
//   change type in CHB_AUTOMERGE_TYPES (default chore,refactor) and at most CHB_AUTOMERGE_MAX_LINES (default 150)
//   review.md verdict pass with no open critical/high finding
//   no file under a protected path (harness, CI, contracts, migrations, dependency manifests). A change's own records
//   (.rig/changes/<slug>/**, approval.json included) are not protected here: rig-check already judges them.
import { type Args, flag, opt, out, die } from './cli.ts'
import { getPRByNumber, prFiles, ensureLabel, addLabel, mergePR } from './github.ts'
import { classify, fetchProof, repoName, type Row } from './ledger.ts'
import type { Proof } from './proof.ts'

export const PROTECTED = [
  /^\.rig\/(?!changes\/)/, /^\.claude\//, /^\.github\//, /(^|\/)CODEOWNERS$/, /^CLAUDE\.md$/,
  /(^|\/)(migrations?|db\/migrate)\//, /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|poetry\.lock|requirements[^/]*\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(\.kts)?)$/,
  /(^|\/)(openapi|asyncapi)[^/]*\.(ya?ml|json)$/, /\.proto$/, /(^|\/)\.env/, /(^|\/)Dockerfile$/, /\.tf$/,
]

export type Policy = { types: string[]; maxLines: number; requiredChecks: string[] }
export const policyFromEnv = (): Policy => ({
  types: (process.env.CHB_AUTOMERGE_TYPES ?? 'chore,refactor').split(',').filter(Boolean),
  maxLines: Number(process.env.CHB_AUTOMERGE_MAX_LINES ?? 150),
  // ub-gates recomputes the gates in CI with the base branch's code and baseline: proof.json is agent-written, so the
  // merge trusts the CI checks for the gates and uses proof.json only for its type, review verdict and freshness.
  requiredChecks: (process.env.CHB_REQUIRED_CHECKS ?? 'rig-check,ub-gates').split(',').filter(Boolean),
})

// Pure.
export function mergeDecision(row: Row, proof: Proof | null, files: string[], checkNames: { name: string; ok: boolean }[], p: Policy): { merge: boolean; reasons: string[] } {
  const no: string[] = []
  if (row.status !== 'ready') no.push(`ledger status is ${row.status}: ${row.reasons.join('; ')}`)
  for (const c of p.requiredChecks) {
    const hit = checkNames.find(k => k.name === c)
    if (!hit) no.push(`required check ${c} has not run on this PR`)
    else if (!hit.ok) no.push(`required check ${c} is not green`)
  }
  if (!proof) no.push('no proof.json')
  else {
    if (!p.types.includes(proof.type)) no.push(`type ${proof.type} is not auto-mergeable (allowed: ${p.types.join(', ')}); a person merges it`)
    if (proof.review.verdict !== 'pass') no.push(`review verdict is ${proof.review.verdict}`)
    if (proof.review.openHigh) no.push(`${proof.review.openHigh} open critical/high review finding(s)`)
  }
  if (row.lines > p.maxLines) no.push(`${row.lines} changed lines > ${p.maxLines}`)
  const hot = files.filter(f => PROTECTED.some(r => r.test(f)))
  if (hot.length) no.push(`touches protected paths: ${hot.slice(0, 5).join(', ')}${hot.length > 5 ? ' …' : ''}`)
  return { merge: no.length === 0, reasons: no.length ? no : ['every auto-merge condition holds'] }
}

export function cmdMerge(args: Args): void {
  const n = args.pos[0]
  if (!n || !/^\d+$/.test(n)) die('usage: chb merge <pr number> [--repo owner/name] [--go]')
  const repo = repoName(opt(args, 'repo'))
  const pr = getPRByNumber(repo, Number(n))
  // Every file (REST pages through up to 3000; `gh pr view --json files` stops at 100), and the old path of a rename,
  // so moving a protected file away is seen as touching it.
  const files = prFiles(repo, Number(n))
  if (files.length < pr.changedFiles) die(`#${n}: listed ${files.length} of ${pr.changedFiles} files; refusing to judge a partial list`, 2)
  const { proof, current } = fetchProof(repo, pr)
  const row = classify(pr, proof, current, new Date())
  const names = (pr.statusCheckRollup ?? []).map(c => ({ name: c.name ?? c.context ?? '', ok: ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes((c.conclusion ?? c.state ?? '').toUpperCase()) }))
  const d = mergeDecision(row, proof, files, names, policyFromEnv())
  out([`#${pr.number} ${pr.title}: ${d.merge ? 'AUTO-MERGE' : 'a person merges this'}`, ...d.reasons.map(r => `  - ${r}`)].join('\n'))
  if (!d.merge) { process.exitCode = 1; return }
  if (!flag(args, 'go')) return out('dry run: pass --go to merge')
  ensureLabel(repo, 'chb:automerged', '5319e7')
  addLabel(repo, Number(n), 'chb:automerged')
  // sha=: GitHub refuses the merge if anything was pushed after the head this decision judged.
  mergePR(repo, Number(n), pr.headRefOid, pr.headRefName)
  out(`merged #${n} at ${pr.headRefOid.slice(0, 7)}`)
}
