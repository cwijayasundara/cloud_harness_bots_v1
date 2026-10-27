// `chb tare <placeholders|frozen-tests|deps|scope|all>`: Tare's machine-checkable lines as deterministic checks
// (Masterstock improvement plan, phase 2). A rule a machine can check does not belong in prose: agents follow prose
// most of the time, and a check every time.
//
// What is judged is the tree being committed: the index against the merge-base with the base branch. At rig's commit
// cadence that is the commit about to be made; in CI's clean checkout it is the PR. Unstaged edits and untracked
// scratch files are not judged. Each finding prints `BLOCK file:line: what` and a `fix:` line for the agent, and the
// last line is the finding count, for rig's ratchet. Exit 1 when something is found; rig's `blocks` flag decides
// whether that stops the commit. When there is nothing to judge against (no base, first commit), the check says so and
// passes: a check that crashes would wedge every commit once it blocks.
//
// Settings: .rig/tare.json, read from the MERGE-BASE, so a change cannot loosen the checks that judge it (rig owns
// .rig/rules.json and /rig:rule, hence the separate file). Change it through its own reviewed PR:
//   { "placeholders": { "ignore": ["regex"] }, "deps": { "allow": ["name"] }, "scope": { "stray": ["regex"], "allow": ["regex"] } }
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Args, flag, opt, out, warn, die } from './cli.ts'
import { git, defaultBase, SOURCE, TEST_FILE } from './git.ts'
import { norm } from './judge.ts'
import { activeSlug, slugFromBranch, frontmatter, toType, CHANGES } from './rig.ts'
import { cmdTareStatus, cmdTareSync, cmdTareVariants } from './tarekit.ts'

export type RuleName = 'placeholders' | 'frozen-tests' | 'deps' | 'scope'
export const RULES: RuleName[] = ['placeholders', 'frozen-tests', 'deps', 'scope']
export type RuleFinding = { rule: RuleName; file: string; line?: number; what: string; fix: string }
export type RulesConfig = { placeholders?: { ignore?: string[] }; deps?: { allow?: string[] }; scope?: { stray?: string[]; allow?: string[] } }

const TEST_DIR = /(^|\/)(test|tests|spec|specs|__tests__|testdata|fixtures|__fixtures__|testing)\//
const isTest = (f: string): boolean => (TEST_FILE.test(f) && !/\.d\.[cm]?ts$/.test(f)) || TEST_DIR.test(f)
const HARNESS = /^(\.rig|\.claude)\//
const VENDORED = /(^|\/)(node_modules|vendor|\.venv|venv|third_party)\//
const isCode = (f: string): boolean => SOURCE.test(f) && !HARNESS.test(f) && !VENDORED.test(f)
// Every git call that lists or diffs paths: real paths (no octal quoting), a/ b/ prefixes whatever the user's config.
const G = ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false']
const zlist = (s: string | null): string[] => (s ?? '').split('\0').filter(Boolean).map(norm)

// ---------- the change ----------

export type Change = { root: string; base: string; mb: string; slug: string | null; type: string | null; head: string | null }

// The base: --base, CHB_BASE, a PR's base in GitHub Actions, then origin/HEAD, main, master (git.ts defaultBase).
export function changeOf(root: string, baseRef: string | null, typeOverride?: string): Change | string {
  const head = git(['rev-parse', '-q', '--verify', 'HEAD'], root)?.trim() || null
  if (!head) return 'first commit in this repository: nothing to compare against'
  if (!baseRef) return 'no base branch found (set CHB_BASE, or pass --base <ref>)'
  const mb = git(['merge-base', baseRef, 'HEAD'], root)?.trim()
  if (!mb) return `no merge-base between ${baseRef} and HEAD (fetch the base branch; in CI use fetch-depth: 0)`
  // The change's slug: rig's active marker locally; in CI (a detached merge commit, .rig/state not checked in) the PR's branch.
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root)?.trim() ?? ''
  const slug = activeSlug(root) ?? slugFromBranch(branch) ?? slugFromBranch(process.env.GITHUB_HEAD_REF ?? '')
  const intent = slug ? staged(root, `${CHANGES}/${slug}/intent.md`) : ''
  const type = typeOverride ?? (intent ? toType(frontmatter(intent).type) : null)
  return { root, base: baseRef, mb, slug, type, head }
}

// A file as it is in the index (what is being committed); empty when it is not there.
const staged = (root: string, f: string): string => git(['show', `:${f}`], root) ?? ''
const atRev = (root: string, rev: string, f: string): string => git(['show', `${rev}:${f}`], root) ?? ''

// Paths added or modified in the index since the merge-base.
const changedPaths = (c: Change): string[] => zlist(git([...G, 'diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=AM', c.mb], c.root))

// Lines added since the merge-base in the index, per file (diffed one file at a time, so no path is ever parsed back
// out of a diff header).
export function addedLines(c: Change, keep: (f: string) => boolean): { file: string; line: number; text: string }[] {
  const outp: { file: string; line: number; text: string }[] = []
  for (const file of changedPaths(c).filter(keep)) {
    let n = 0
    for (const l of (git([...G, 'diff', '--cached', '-U0', '--no-color', '--no-ext-diff', '--no-renames', c.mb, '--', file], c.root) ?? '').split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
      if (h) { n = Number(h[1]); continue }
      if (l.startsWith('+++') || l.startsWith('---')) continue
      if (l.startsWith('+')) outp.push({ file, line: n++, text: l.slice(1).replace(/\r$/, '') })
    }
  }
  return outp
}

const safeRegexes = (list: string[] | undefined, where: string, notes: string[]): RegExp[] =>
  (list ?? []).flatMap(r => { try { return [new RegExp(r)] } catch { notes.push(`.rig/tare.json ${where}: "${r}" is not a valid regex, ignored`); return [] } })

// ---------- placeholders ----------

const COMMENT_MARKER = /(\/\/|#|\/\*|^\s*\*|<!--|--|;)[^'"`]*?\b(TODO|FIXME|HACK)\b|(\/\/|#|\/\*|^\s*\*)[^'"`]*?\bXXX\b(?!-)/
const STUB = /\braise NotImplementedError\b|\bthrow new Error\(\s*["'`][^"'`]*not (yet )?implemented|\bunimplemented!\s*\(|\btodo!\s*\(|panic\(\s*["'`](TODO|not implemented)/i
// Abstract methods are meant to raise NotImplementedError: look a few lines up for the marker.
const ABSTRACT = /@(abc\.)?abstract|\bABC\b|abstract\s+(class|\w+\s*\()|\binterface\b|Protocol\b/

export function checkPlaceholders(c: Change, cfg: RulesConfig, notes: string[]): RuleFinding[] {
  const ignore = safeRegexes(cfg.placeholders?.ignore, 'placeholders.ignore', notes)
  const found: RuleFinding[] = []
  const blobs = new Map<string, string[]>()
  const above = (f: string, line: number): string => { if (!blobs.has(f)) blobs.set(f, staged(c.root, f).split('\n')); return blobs.get(f)!.slice(Math.max(0, line - 7), line - 1).join('\n') }
  for (const a of addedLines(c, isCode)) {
    if (ignore.some(r => r.test(a.text))) continue
    if (COMMENT_MARKER.test(a.text)) found.push({ rule: 'placeholders', file: a.file, line: a.line, what: `a TODO-style marker: ${a.text.trim().slice(0, 100)}`, fix: 'do it now, or delete the marker and put the follow-up under ## Open questions in the change\'s spec.md' })
    // Tests assert that stubs raise; only source can be a stub.
    else if (!isTest(a.file) && STUB.test(a.text) && !ABSTRACT.test(above(a.file, a.line))) found.push({ rule: 'placeholders', file: a.file, line: a.line, what: `a stub that is not implemented: ${a.text.trim().slice(0, 100)}`, fix: 'implement it; if it is out of scope, leave it out of this change and say so under ## Open questions' })
  }
  return found
}
// Skipped and focused tests are not checked here: rig's own test-tamper sensor already blocks them, with the person's waiver.

// ---------- frozen tests ----------

type Commit = { sha: string; files: string[] }
// The branch's commits since the merge-base, oldest first, then the commit being made (what is staged), if anything is.
export function commitsSince(c: Change): Commit[] {
  const files = (args: string[]) => zlist(git([...G, ...args], c.root)).filter(f => !HARNESS.test(f))
  const list = (git(['rev-list', '--reverse', '--no-merges', `${c.mb}..HEAD`], c.root) ?? '').split('\n').filter(Boolean)
    .map(sha => ({ sha: sha.slice(0, 8), files: files(['diff-tree', '--no-commit-id', '--name-only', '-r', '--no-renames', '-z', '--root', sha]) }))
  const pending = files(['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD'])
  return pending.length ? [...list, { sha: 'staged', files: pending }] : list
}

// Bugfix: a test reproducing the bug, committed on its own before the fix. Refactor: characterization tests, committed
// before the structure changes. Either way those tests are then frozen: the fix makes them pass, it does not edit them.
// rig's red-proof checks the final tests against the base (they must fail there, or pass for a refactor); this adds the
// order and the freeze, which red-proof cannot see: a test rewritten to match a wrong fix can still fail on the base.
// Not caught: history rewritten to fold a later test edit into the first commit. Pushed branches make that visible in review.
export function checkFrozenTests(c: Change): RuleFinding[] {
  if (c.type !== 'bugfix' && c.type !== 'refactor') return []
  const commits = commitsSince(c)
  const isSrc = (f: string) => isCode(f) && !isTest(f)
  const firstSrc = commits.findIndex(k => k.files.some(isSrc))
  if (firstSrc < 0) return [] // no source changed yet: nothing to judge
  const repro = commits.findIndex(k => k.files.some(isTest) && !k.files.some(isSrc))
  const name = c.type === 'bugfix' ? 'a test that reproduces the bug' : 'characterization tests that pin current behaviour'
  const where = (k: Commit) => k.sha === 'staged' ? 'the commit being made' : k.sha
  if (repro < 0 || repro > firstSrc) {
    const k = commits[firstSrc]!
    return [{ rule: 'frozen-tests', file: k.files.find(isSrc)!, what: `${c.type}: source changes in ${where(k)} with no ${name} committed before them`, fix: `commit ${name} on its own first (for a bugfix it must fail), then the change: unstage the source (git restore --staged <files>), commit the tests, then commit the rest` }]
  }
  const frozen = new Set(commits[repro]!.files.filter(isTest))
  const found: RuleFinding[] = []
  for (const k of commits.slice(repro + 1)) for (const f of k.files) if (frozen.has(f)) found.push({ rule: 'frozen-tests', file: f, what: `frozen test edited in ${where(k)}, after it was committed in ${commits[repro]!.sha}`, fix: 'change the code to make the test pass, not the test (git restore --staged --worktree --source=HEAD <test>); if the test itself is wrong, say so under ## Open questions and let a person decide' })
  return found
}

// ---------- dependencies ----------

const pyName = (spec: string): string => spec.trim().split(/[\s<>=!~;[(@]/)[0]!.toLowerCase().replace(/[_.]+/g, '-')
// The quoted strings of a TOML array that starts at `from` (brackets inside strings, like extras, do not end it).
function tomlArray(text: string, from: number): string[] {
  const outp: string[] = []
  let depth = 0, inStr: string | null = null, cur = '', inTable = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) { if (ch === '\\') { cur += text[++i] ?? ''; continue } if (ch === inStr) { if (!inTable) outp.push(cur); inStr = null; cur = '' } else cur += ch; continue }
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (ch === '"' || ch === "'") { inStr = ch; continue }
    if (ch === '{') inTable++
    else if (ch === '}') inTable--
    else if (ch === '[') depth++
    else if (ch === ']') { depth--; if (depth === 0) break }
  }
  return outp
}

// Direct dependencies a manifest declares. Lockfiles are left out: they list transitive packages.
export function depsOf(file: string, text: string): Set<string> {
  const s = new Set<string>()
  const base = path.basename(file)
  if (!text.trim()) return s
  if (base === 'package.json') {
    try {
      const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>
      // workspace:, file:, link: and portal: point inside the repo: not a third-party dependency.
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) for (const [n, v] of Object.entries(j[k] ?? {})) if (!/^(workspace|file|link|portal):/.test(String(v))) s.add(n)
    } catch { /* invalid JSON: another check's problem */ }
  } else if (/^requirements.*\.(txt|in)$/.test(base)) {
    for (const l of text.split('\n')) { const t = l.replace(/(^|\s)#.*/, '').trim(); if (t && !t.startsWith('-') && !/^(git\+|https?:|\.|\/)/.test(t)) s.add(pyName(t)) }
  } else if (base === 'pyproject.toml') {
    let section = ''
    const re = /^[ \t]*(?:\[([^\]\n]+)\][ \t]*$|([\w.-]+)[ \t]*=[ \t]*(\[)?)/gm
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[1]) { section = m[1].trim(); continue }
      const key = m[2]!, arr = m[3] ? m.index + m[0].length - 1 : -1
      const arrays = (section === 'project' && key === 'dependencies') || section === 'project.optional-dependencies' || section === 'dependency-groups'
      if (arrays && arr >= 0) for (const d of tomlArray(text, arr)) s.add(pyName(d))
      else if (/^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/.test(section) && key !== 'python') s.add(pyName(key))
    }
  } else if (base === 'go.mod') {
    let block = false
    for (const l of text.split('\n')) {
      if (/\/\/\s*indirect\b/.test(l)) continue // tidy's bookkeeping, not a choice
      const t = l.replace(/\/\/.*/, '').trim()
      if (/^require\s*\($/.test(t)) { block = true; continue }
      if (block && t === ')') { block = false; continue }
      const m = block ? /^(\S+)\s+\S+/.exec(t) : /^require\s+(\S+)\s+\S+/.exec(t)
      if (m) s.add(m[1]!)
    }
  } else if (base === 'Cargo.toml') {
    let on = false
    for (const l of text.split('\n')) {
      const t = l.replace(/#.*/, '').trim()
      const sec = /^\[([^\]]+)\]$/.exec(t)
      if (sec) { const one = /(^|\.)(dev-|build-)?dependencies\.([\w-]+)$/.exec(sec[1]!); on = !one && /(^|\.)(dev-|build-)?dependencies$/.test(sec[1]!); if (one) s.add(one[3]!); continue }
      const k = on ? /^([\w-]+)(\.[\w.-]+)?\s*=/.exec(t)?.[1] : null // serde = …, serde.workspace = true
      if (k) s.add(k)
    }
  }
  return s
}
export const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.(txt|in)|pyproject\.toml|go\.mod|Cargo\.toml)$/

// The brief names a dependency when the change's intent or spec (as approved, from the index) mentions it, or
// .rig/tare.json allows it. plan.md is not the brief: the build stage edits it.
export function checkDeps(c: Change, cfg: RulesConfig): RuleFinding[] {
  const brief = c.slug ? ['intent.md', 'spec.md'].map(f => staged(c.root, `${CHANGES}/${c.slug}/${f}`)).join('\n').toLowerCase() : ''
  const briefPy = brief.replace(/(\w)[_.]+(?=\w)/g, '$1-') // python names: typing_extensions = typing-extensions
  const allow = new Set((cfg.deps?.allow ?? []).map(x => x.toLowerCase()))
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const mentioned = (text: string, n: string) => text.length > 0 && new RegExp(`(^|[^\\w@/.-])${esc(n)}(?![\\w/-]|\\.\\w)`).test(text)
  const named = (d: string) => { const n = d.toLowerCase(); return allow.has(n) || allow.has(n.replace(/[_.]+/g, '-')) || mentioned(brief, n) || mentioned(briefPy, n.replace(/[_.]+/g, '-')) }
  const found: RuleFinding[] = []
  for (const f of changedPaths(c).filter(x => MANIFEST.test(x) && !VENDORED.test(x) && !TEST_DIR.test(x)).sort()) {
    const before = depsOf(f, atRev(c.root, c.mb, f)), after = depsOf(f, staged(c.root, f))
    for (const d of [...after].filter(x => !before.has(x)).sort()) if (!named(d)) found.push({ rule: 'deps', file: f, what: `new dependency ${d} is not named in the change's brief`, fix: 'remove it and write what you need yourself, or ask for it under ## Open questions; a person names it in the brief (intent.md, spec.md) or adds it to .rig/tare.json deps.allow' })
  }
  return found
}

// ---------- scope ----------

// Files that never belong in a commit. Keys and certificates under test/fixture folders, and *.example/.sample/
// .template variants, are fine; build output only at the repo root (build/ is a source folder in many Go repos, so it
// is not listed: add it in .rig/tare.json scope.stray if yours is output).
const STRAY = /(^|\/)\.env(\.[\w-]+)*$|\.(log|orig|rej|swp|swo)$|(^|\/)(\.DS_Store|Thumbs\.db|npm-debug\.log[^/]*)$|(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$|\.(pem|key|p12|pfx)$|(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules|\.venv|\.metrics)\/|^(coverage|htmlcov|\.nyc_output|dist|target)\//
const TEMPLATE = /\.(example|sample|template|dist)$/
const KEY_FILE = /\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/

// Commit only the files of this change: no secret files, logs, caches, root build output or big binaries. What rig
// already covers is left to rig: a change's declared paths (the intent's `scope:`) and secrets inside file contents.
export function checkScope(c: Change, cfg: RulesConfig, notes: string[]): RuleFinding[] {
  const stray = [STRAY, ...safeRegexes(cfg.scope?.stray, 'scope.stray', notes)]
  const allowed = safeRegexes(cfg.scope?.allow, 'scope.allow', notes)
  const found: RuleFinding[] = []
  for (const f of changedPaths(c)) {
    if (f.startsWith(`${CHANGES}/`) || allowed.some(r => r.test(f))) continue
    const exempt = TEMPLATE.test(f) || (KEY_FILE.test(f) && TEST_DIR.test(f))
    if (!exempt && stray.some(r => r.test(f))) { found.push({ rule: 'scope', file: f, what: 'a file that never belongs in a commit (secret, log, cache or build output)', fix: 'git rm --cached it and add it to .gitignore' }); continue }
    const size = Number(git(['cat-file', '-s', `:${f}`], c.root)?.trim() ?? 0)
    if (size > 1_000_000 && !LOCKFILE.test(f)) found.push({ rule: 'scope', file: f, what: `a ${(size / 1e6).toFixed(1)} MB file`, fix: 'leave large files out of the repo (git rm --cached it), or ask a person to add it' })
  }
  return found
}

// A glob as a RegExp (`**` spans folders, `*` one segment).
export const globToRe = (g: string): RegExp => new RegExp(`^${g.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(.*/)?').replace(/\u0001/g, '.*')}${g.trim().endsWith('/') ? '.*' : ''}$`)

// ---------- entry ----------

// From the merge-base: the checks judging a change are the ones it started under.
export function readRulesConfig(root: string, rev: string | null, notes: string[]): RulesConfig {
  const text = rev ? atRev(root, rev, '.rig/tare.json') : ''
  if (!text.trim()) return {}
  try { return JSON.parse(text) as RulesConfig } catch { notes.push('.rig/tare.json on the base is not valid JSON: using defaults'); return {} }
}

export function runRule(name: RuleName, c: Change, cfg: RulesConfig, notes: string[] = []): RuleFinding[] {
  return name === 'placeholders' ? checkPlaceholders(c, cfg, notes) : name === 'frozen-tests' ? checkFrozenTests(c) : name === 'deps' ? checkDeps(c, cfg) : checkScope(c, cfg, notes)
}

export const formatFindings = (list: RuleFinding[]): string[] => list.flatMap(f => [`  BLOCK ${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}: ${f.what}`, `        fix: ${f.fix}`])

export function cmdTare(args: Args): void {
  const which = args.pos[0]
  if (which === 'status') return cmdTareStatus(args)
  if (which === 'sync') return cmdTareSync(args)
  if (which === 'variants') return cmdTareVariants(args)
  const names: RuleName[] = which === 'all' ? RULES : RULES.includes(which as RuleName) ? [which as RuleName] : []
  if (!names.length) die(`usage: chb tare <${RULES.join('|')}|all> [--base <ref>] [--type bugfix|refactor|feature|chore] [--json]\n       chb tare status|sync|variants … (chb help)`)
  const root = git(['rev-parse', '--show-toplevel'])?.trim()
  if (!root) die('not inside a git repository', 2)
  const c = changeOf(root, opt(args, 'base') ?? defaultBase(root), opt(args, 'type'))
  if (typeof c === 'string') { out(flag(args, 'json') ? '[]' : `tare ${names.join(', ')}: not judged: ${c}\n0`); return }
  const notes: string[] = []
  const cfg = readRulesConfig(root, c.mb, notes)
  const found = names.flatMap(n => runRule(n, c, cfg, notes))
  try {
    fs.mkdirSync(path.join(root, '.rig/ub/results'), { recursive: true })
    fs.writeFileSync(path.join(root, '.rig/ub/results', `tare-${which}.json`), JSON.stringify({ at: new Date().toISOString(), head: c.head, base: c.base, slug: c.slug, type: c.type, rules: names, findings: found, notes }, null, 2) + '\n')
  } catch { /* a read-only checkout still gets the verdict */ }
  if (flag(args, 'json')) out(JSON.stringify(found))
  else out([`tare ${names.join(', ')}: ${found.length} finding(s)${c.type ? ` (${c.type} change${c.slug ? ` ${c.slug}` : ''})` : ''}`, ...formatFindings(found), ...notes.map(n => `  note  ${n}`), String(found.length)].join('\n'))
  process.exitCode = found.length ? 1 : 0
}

// `chb nightly`: run the sensors in .rig/sensors.json whose cadence is "nightly". rig_v1 accepts that cadence but its
// `check` never runs it, so the Auditor bot calls this at 02:00 instead. Like rig: disabled sensors are skipped, a
// sensor listed in knownRed only warns, and {files} means the whole tree. Exit 1 if a blocking sensor failed.
type SensorRow = { id: string; cmd?: string; cadence?: string; blocks?: boolean; enabled?: boolean; timeoutMs?: number }
export function cmdNightly(args: Args): void {
  const root = git(['rev-parse', '--show-toplevel'])?.trim()
  if (!root) die('not inside a git repository', 2)
  const file = path.join(root, '.rig/sensors.json')
  if (!fs.existsSync(file)) die(`${file} not found: not a rig repo`, 2)
  let j: { sensors?: SensorRow[]; knownRed?: (string | { id?: string; sensor?: string })[] }
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof j } catch (e) { return die(`.rig/sensors.json is not valid JSON: ${(e as Error).message}`, 2) }
  const knownRed = new Set((j.knownRed ?? []).map(k => typeof k === 'string' ? k : k.id ?? k.sensor ?? ''))
  const sensors = (j.sensors ?? []).filter(s => s.cadence === 'nightly' && s.cmd && s.enabled !== false)
  const lines: string[] = [], results: { id: string; pass: boolean; blocks: boolean; knownRed: boolean; ms: number; tail: string }[] = []
  for (const s of sensors) {
    const t0 = Date.now()
    const r = spawnSync('sh', ['-c', s.cmd!.replaceAll('{files}', '.')], { cwd: root, encoding: 'utf8', timeout: s.timeoutMs ?? 1_800_000, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, maxBuffer: 64 * 1024 * 1024 })
    const tail = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`.trim().split('\n').slice(-5).join('\n')
    const red = knownRed.has(s.id), blocks = s.blocks === true && !red
    results.push({ id: s.id, pass: r.status === 0, blocks, knownRed: red, ms: Date.now() - t0, tail })
    lines.push(`${r.status === 0 ? 'pass' : blocks ? 'FAIL' : 'warn'} ${s.id}${red ? ' (known red)' : ''} (${((Date.now() - t0) / 1000).toFixed(0)}s)${r.status === 0 ? '' : `\n${tail.split('\n').map(l => `    ${l}`).join('\n')}`}`)
  }
  try {
    fs.mkdirSync(path.join(root, '.rig/ub/results'), { recursive: true })
    fs.writeFileSync(path.join(root, '.rig/ub/results/nightly.json'), JSON.stringify({ at: new Date().toISOString(), head: git(['rev-parse', 'HEAD'], root)?.trim() ?? null, results }, null, 2) + '\n')
  } catch (e) { warn(`could not write .rig/ub/results/nightly.json: ${(e as Error).message}`) }
  const failed = results.filter(r => !r.pass).length
  out(flag(args, 'json') ? JSON.stringify(results) : [sensors.length ? `nightly: ${sensors.length} sensor(s), ${failed} failed` : 'nightly: no enabled sensors with cadence "nightly" in .rig/sensors.json', ...lines, String(failed)].join('\n'))
  process.exitCode = results.some(r => !r.pass && r.blocks) ? 1 : 0
}
