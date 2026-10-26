// Git helpers and the changed source set. The tools' own --changed reads `git status`, which is empty once work is
// committed (pre-push, CI, a cloud agent's branch). Here "changed" means: added or modified since the merge-base with
// the base branch, plus anything uncommitted. Test files are left out, as the tools leave them out.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { norm } from './judge.ts'

export function git(args: string[], cwd = process.cwd()): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : null
}

// The base branch: CHB_BASE, else the remote's default branch (origin/HEAD), else main or master.
export function defaultBase(cwd = process.cwd()): string | null {
  if (process.env.CHB_BASE) return process.env.CHB_BASE
  const head = git(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], cwd)?.trim()
  if (head) return head
  for (const ref of ['origin/main', 'main', 'origin/master', 'master'])
    if (git(['rev-parse', '--verify', '-q', ref], cwd) !== null) return ref
  return null
}

export const mergeBase = (base: string, cwd = process.cwd()): string | null => git(['merge-base', base, 'HEAD'], cwd)?.trim() || null

// Mirrors crapper's discover.py (SKIP_DIRS, TEST_DIRS, test-file suffixes), with one change: build output
// (dist, build, out, coverage, target) is skipped only at the repo root, so source cannot hide in src/build/.
export const SOURCE = /\.(clj|cljc|cljs|bb|java|go|ts|tsx|mts|cts|js|jsx|mjs|cjs|rs|py)$/
const SKIPPED_ANYWHERE = /(^|\/)(\.git|\.hg|\.svn|\.idea|\.venv|venv|node_modules|vendor|\.metrics|testdata|__pycache__|\.clj-kondo|test|tests|spec|specs|__tests__|\.rig|\.claude)\//
const SKIPPED_AT_ROOT = /^(dist|build|out|coverage|target)\//
const TEST_FILE = /(_test\.go|_test\.py|(^|\/)test_[^/]*\.py|(^|\/)conftest\.py|\.(test|spec)\.[cm]?[jt]sx?|_test\.(clj[cs]?|bb)|_spec\.clj[cs]?|(^|\/)[^/]*Tests?\.java|\.d\.[cm]?ts)$/

export const isSource = (file: string): boolean => { const f = norm(file); return SOURCE.test(f) && !SKIPPED_ANYWHERE.test(f) && !SKIPPED_AT_ROOT.test(f) && !TEST_FILE.test(f) }

const isFile = (cwd: string, f: string): boolean => { try { return fs.statSync(path.join(cwd, f)).isFile() } catch { return false } }

// Uncommitted paths (porcelain), deleted ones left out.
export function uncommitted(cwd = process.cwd()): string[] {
  const out: string[] = []
  for (const entry of (git(['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all'], cwd) ?? '').split('\0')) {
    if (entry.length < 4 || entry.slice(0, 2).includes('D')) continue
    out.push(norm(entry.slice(3)))
  }
  return out
}

// Throws when there is no base or no merge-base (a shallow clone, an unknown branch): a changed-scope gate must never
// fall back to "nothing changed", which would pass every committed change.
export function changedFiles(base: string | null, cwd = process.cwd()): string[] {
  if (!base) throw new Error('no base branch: set CHB_BASE or pass --base <ref> (origin/HEAD, main and master were not found)')
  const mb = mergeBase(base, cwd)
  if (!mb) throw new Error(`no merge-base between ${base} and HEAD: fetch the base branch (in CI: fetch-depth: 0)`)
  const set = new Set<string>()
  for (const f of (git(['diff', '--name-only', '--diff-filter=AMR', '-z', mb], cwd) ?? '').split('\0')) if (f) set.add(norm(f))
  for (const f of uncommitted(cwd)) set.add(f)
  return [...set].filter(f => isFile(cwd, f)).sort()
}

export const changedSource = (base: string | null, cwd = process.cwd()): string[] => changedFiles(base, cwd).filter(isSource)

// The repo's own source: tracked files plus new files git does not ignore. The tools skip only their own lists, so a
// bare whole-tree run also scores anything else lying in the tree; explicit lists keep it to the repo's source.
export function repoSource(cwd = process.cwd()): string[] {
  const list = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd) ?? ''
  return [...new Set(list.split('\0').filter(Boolean).map(norm))].filter(f => isSource(f) && isFile(cwd, f)).sort()
}

// True when a source file differs from HEAD: a gate run then judged code that HEAD does not hold.
export const dirtySource = (cwd = process.cwd()): string[] => uncommitted(cwd).filter(isSource)

export const showAt = (ref: string, file: string, cwd = process.cwd()): string | null => git(['show', `${ref}:${file}`], cwd)

export const repoRoot = (cwd = process.cwd()): string => git(['rev-parse', '--show-toplevel'], cwd)?.trim() || cwd
