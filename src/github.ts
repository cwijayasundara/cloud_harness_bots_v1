// GitHub through repo-scoped REST endpoints only, called with `gh api`. GraphQL (`gh pr list/view/merge`,
// `gh repo view`) is blocked in Claude Code cloud sessions and some proxied environments, and search endpoints are
// account-scoped; REST under repos/{owner}/{repo}/… works everywhere a token for that repo works.
import { gh, ghTry } from './gh.ts'
import { git } from './git.ts'
import type { PR, Check } from './ledger.ts'

// `gh api --paginate --jq '.[] | …'` prints one compact JSON value per line.
export const lines = <T>(text: string): T[] => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l) as T)

export function repoFromRemote(cwd = process.cwd()): string | null {
  const url = git(['remote', 'get-url', 'origin'], cwd)?.trim() ?? ''
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(url)
  return m ? `${m[1]}/${m[2]}` : null
}

type ListPR = { number: number; title: string; url: string; branch: string; sha: string; draft: boolean; updated: string; labels: string[] }
type Detail = { mergeable: boolean | null; state: string; additions: number; deletions: number; changed: number }

export function listOpenPRs(repo: string): ListPR[] {
  return lines<ListPR>(gh(['api', '--paginate', `repos/${repo}/pulls?state=open&per_page=100`, '--jq',
    '.[] | {number, title, url: .html_url, branch: .head.ref, sha: .head.sha, draft, updated: .updated_at, labels: [.labels[].name]}']))
}

export function prDetail(repo: string, n: number): Detail {
  return JSON.parse(gh(['api', `repos/${repo}/pulls/${n}`, '--jq', '{mergeable, state: .mergeable_state, additions, deletions, changed: .changed_files}'])) as Detail
}

// Check runs (Actions and apps; the API returns the latest run per name) plus legacy commit statuses.
export function checksFor(repo: string, sha: string): Check[] {
  const runs = lines<Check>(gh(['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[] | {name, status, conclusion}']))
  const statuses = lines<Check>(ghTry(['api', `repos/${repo}/commits/${sha}/status`, '--jq', '.statuses[] | {context, state}']) ?? '')
  return [...runs, ...statuses]
}

// GitHub's review decision, recomputed: each reviewer's latest APPROVED / CHANGES_REQUESTED / DISMISSED counts.
export function reviewDecision(reviews: { user: string; state: string }[]): string | null {
  const latest = new Map<string, string>()
  for (const r of reviews) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user, r.state)
  const s = [...latest.values()]
  return s.includes('CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : s.includes('APPROVED') ? 'APPROVED' : null
}

export function getPR(repo: string, base: ListPR): PR {
  const d = prDetail(repo, base.number)
  const reviews = lines<{ user: string; state: string }>(gh(['api', '--paginate', `repos/${repo}/pulls/${base.number}/reviews?per_page=100`, '--jq', '.[] | {user: .user.login, state}']))
  return {
    number: base.number, title: base.title, url: base.url, headRefName: base.branch, headRefOid: base.sha, isDraft: base.draft,
    // mergeable is null while GitHub computes it; "dirty" is a conflict.
    mergeable: d.state === 'dirty' || d.mergeable === false ? 'CONFLICTING' : d.mergeable === true ? 'MERGEABLE' : 'UNKNOWN',
    reviewDecision: reviewDecision(reviews), updatedAt: base.updated, additions: d.additions, deletions: d.deletions, changedFiles: d.changed,
    labels: base.labels.map(name => ({ name })), statusCheckRollup: checksFor(repo, base.sha),
  }
}

export function getPRByNumber(repo: string, n: number): PR {
  const b = JSON.parse(gh(['api', `repos/${repo}/pulls/${n}`, '--jq', '{number, title, url: .html_url, branch: .head.ref, sha: .head.sha, draft, updated: .updated_at, labels: [.labels[].name]}'])) as ListPR
  return getPR(repo, b)
}

export const prFiles = (repo: string, n: number): string[] =>
  gh(['api', '--paginate', `repos/${repo}/pulls/${n}/files?per_page=100`, '--jq', '.[] | .filename, (.previous_filename // empty)']).split('\n').filter(Boolean)

export function ensureLabel(repo: string, name: string, color: string): void {
  ghTry(['api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${name}`, '-f', `color=${color}`]) // 422 when it exists: fine
}
export const addLabel = (repo: string, n: number, name: string): void => { gh(['api', '-X', 'POST', `repos/${repo}/issues/${n}/labels`, '-f', `labels[]=${name}`]) }
export const removeLabel = (repo: string, n: number, name: string): void => { ghTry(['api', '-X', 'DELETE', `repos/${repo}/issues/${n}/labels/${encodeURIComponent(name)}`]) }

// Squash-merge only if the head is still `sha` (GitHub refuses with 409 otherwise), then delete the branch.
export function mergePR(repo: string, n: number, sha: string, branch: string): void {
  gh(['api', '-X', 'PUT', `repos/${repo}/pulls/${n}/merge`, '-f', 'merge_method=squash', '-f', `sha=${sha}`])
  ghTry(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`])
}

export type MergedPR = { number: number; title: string; createdAt: string; mergedAt: string; additions: number; deletions: number; labels: { name: string }[] }

// Closed PRs, newest update first, until updates fall before `since`; kept when merged at or after `since`.
export function mergedSince(repo: string, since: Date): MergedPR[] {
  const out: MergedPR[] = []
  for (let page = 1; page <= 20; page++) {
    const batch = lines<{ number: number; title: string; created: string; merged: string | null; updated: string; labels: string[] }>(gh(['api', `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, '--jq',
      '.[] | {number, title, created: .created_at, merged: .merged_at, updated: .updated_at, labels: [.labels[].name]}']))
    for (const p of batch) if (p.merged && Date.parse(p.merged) >= since.getTime()) {
      const d = prDetail(repo, p.number)
      out.push({ number: p.number, title: p.title, createdAt: p.created, mergedAt: p.merged, additions: d.additions, deletions: d.deletions, labels: p.labels.map(name => ({ name })) })
    }
    if (batch.length < 100 || batch.every(p => Date.parse(p.updated) < since.getTime())) break
  }
  return out
}
