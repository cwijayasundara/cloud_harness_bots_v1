// `chb lessons`: what your repos have each learned, read together (Masterstock improvement plan, phase 3).
//
// rig already runs the learning loop inside one repo (`sdlc.ts learn mine` and the /rig:learn skill): a review finding,
// waiver or typed correction that recurs in two changes becomes a candidate, the strongest fix that fits is proposed
// (architecture, ratchet, test, rule, lesson), a rule must replay on the changes that earned it, and a person applies
// it. What no repo can see is a mistake that recurs ACROSS repos. That is a fact about how agents work for you, not
// about one codebase, so its home is Tare. This command reads every repo's `.rig/lessons.md`, `.rig/lessons-archive.md`
// and `.rig/learn/candidates.json`, groups what says the same thing, and proposes, for whatever is seen in at least
// two repos:
//   PORT  a rule one repo already proved (promoted:<rule>) to the repos that still carry it as a lesson
//   TARE  a new Tare line, for a lesson no check catches yet (with its evidence, for the Tare log)
//   SEEN  more evidence for a line Tare already has
// Deterministic, zero tokens, read-only: it writes one proposal file, and a person decides.
import fs from 'node:fs'
import path from 'node:path'
import { type Args, flag, opt, out, die } from './cli.ts'

export type RepoLesson = { repo: string; id: string; text: string; key: string; seen: string[]; status: string; source: 'lesson' | 'candidate'; rung?: string }

// rig's lesson line: `- <id> | <text> | key: <k> | seen: <a>, <b> | first <date> | last-fired <date> | <status>`
export function parseRigLessons(repo: string, text: string): RepoLesson[] {
  const outp: RepoLesson[] = []
  for (const raw of text.split('\n')) {
    if (!/^- [A-Za-z]\w* \| /.test(raw)) continue
    const f = raw.slice(2).split(' | ')
    if (f.length !== 7 || !f[2]!.startsWith('key: ') || !f[3]!.startsWith('seen: ')) continue
    outp.push({ repo, id: f[0]!, text: f[1]!.trim(), key: f[2]!.slice(5).trim(), seen: f[3]!.slice(6).split(', ').filter(Boolean), status: f[6]!.trim(), source: 'lesson' })
  }
  return outp
}

type Candidate = { key: string; kind: string; changes: string[]; sample: string; rung: string }
export function parseCandidates(repo: string, text: string): RepoLesson[] {
  try {
    const j = JSON.parse(text) as { candidates?: Candidate[] }
    return (j.candidates ?? []).map((c, i) => ({ repo, id: `c${i + 1}`, text: c.sample.trim().slice(0, 240), key: c.key, seen: c.changes, status: 'candidate', source: 'candidate' as const, rung: c.rung }))
  } catch { return [] }
}

const read = (f: string): string => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

export function gather(repoDirs: string[]): RepoLesson[] {
  return repoDirs.flatMap(dir => {
    const repo = path.basename(path.resolve(dir))
    return [
      ...parseRigLessons(repo, read(path.join(dir, '.rig/lessons.md'))),
      ...parseRigLessons(repo, read(path.join(dir, '.rig/lessons-archive.md'))).filter(l => l.status.startsWith('promoted:')),
      ...parseCandidates(repo, read(path.join(dir, '.rig/learn/candidates.json'))),
    ]
  })
}

// ---------- grouping ----------

const STOP = new Set('a an the and or of to in on for with without by is are be it its this that these those not no never always when if then than as at from into use using do does should must can only every each any all your you we our their'.split(' '))
export const words = (t: string): Set<string> => new Set(t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).map(w => w.replace(/(ing|ed|es|s)$/, '')).filter(w => w.length > 2 && !STOP.has(w)))
export function similarity(a: string, b: string): number {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / (x.size + y.size - both)
}

// Does a lesson say what an existing Tare line says? Containment rather than Jaccard (a short lesson inside a long
// line), ignoring words every engineering rule shares.
const GENERIC = new Set('test code change file commit line function method class make need want work thing'.split(' '))
export function covers(lesson: string, line: string): number {
  const x = new Set([...words(lesson)].filter(w => !GENERIC.has(w))), y = new Set([...words(line)].filter(w => !GENERIC.has(w)))
  if (!x.size || !y.size) return 0
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / Math.min(x.size, y.size)
}

// Same thing said in two repos: same key and similar words, or very similar words under any key. Greedy, in a stable
// order, so the same inputs always give the same groups.
export function cluster(items: RepoLesson[], sameKey = 0.3, anyKey = 0.5): RepoLesson[][] {
  const groups: RepoLesson[][] = []
  for (const it of [...items].sort((a, b) => a.repo.localeCompare(b.repo) || a.id.localeCompare(b.id))) {
    const g = groups.find(g => g.some(o => { const s = similarity(o.text, it.text); return (o.key === it.key && s >= sameKey) || s >= anyKey }))
    if (g) g.push(it); else groups.push([it])
  }
  return groups
}

// ---------- Tare ----------

// Tare's rules: its bullet lines (with their continuation lines), frontmatter and headings left out.
export function tareLines(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '')
  const outp: string[] = []
  for (const l of body.split('\n')) {
    if (/^- /.test(l)) outp.push(l.slice(2).trim())
    else if (/^\s{2,}\S/.test(l) && outp.length) outp[outp.length - 1] += ` ${l.trim()}`
  }
  return outp
}

export type Proposal = { kind: 'PORT' | 'TARE' | 'SEEN'; text: string; repos: string[]; evidence: string[]; rule?: string; from?: string; to?: string[]; tareLine?: string; rung?: string }

export function propose(items: RepoLesson[], tare: string[], minRepos = 2): Proposal[] {
  const outp: Proposal[] = []
  for (const g of cluster(items.filter(i => i.status !== 'retired'))) {
    const repos = [...new Set(g.map(i => i.repo))].sort()
    if (repos.length < minRepos) continue
    const evidence = g.map(i => `${i.repo}:${i.id} (${i.status}; seen ${i.seen.join(', ')})`)
    const text = [...g].sort((a, b) => (a.source === 'lesson' ? 0 : 1) - (b.source === 'lesson' ? 0 : 1) || a.text.length - b.text.length)[0]!.text
    const promoted = g.find(i => i.status.startsWith('promoted:'))
    const covered = tare.map(t => ({ t, s: Math.max(...g.map(i => covers(i.text, t))) })).sort((a, b) => b.s - a.s)[0]
    if (promoted) {
      const to = repos.filter(r => r !== promoted.repo && !g.some(i => i.repo === r && i.status.startsWith('promoted:')))
      if (to.length) outp.push({ kind: 'PORT', text, repos, evidence, rule: promoted.status.slice('promoted:'.length), from: promoted.repo, to })
    } else if (covered && covered.s >= 0.3) outp.push({ kind: 'SEEN', text, repos, evidence, tareLine: covered.t })
    else outp.push({ kind: 'TARE', text, repos, evidence, rung: g.map(i => i.rung).find(Boolean) ?? 'lesson' })
  }
  const order = { PORT: 0, TARE: 1, SEEN: 2 }
  return outp.sort((a, b) => order[a.kind] - order[b.kind] || b.repos.length - a.repos.length || a.text.localeCompare(b.text))
}

export function renderProposal(ps: Proposal[], repoCount: number, itemCount: number): string {
  const L = [`# Tare proposal`, '', `From ${itemCount} lesson(s) and candidate(s) in ${repoCount} repo(s). Only what recurs in at least two repos is here; one repo's lessons stay in that repo's rig loop. A person applies these; nothing was changed.`, '']
  if (!ps.length) L.push('Nothing recurs across repos yet.')
  for (const p of ps) {
    if (p.kind === 'PORT') L.push(`- **PORT** rule \`${p.rule}\` from ${p.from} to ${p.to!.join(', ')}: "${p.text}". It is proven in ${p.from}; in the others, copy the rule into .rig/rules.json and prove it there with \`sdlc.ts learn replay\` on that repo's changes.`)
    else if (p.kind === 'TARE') L.push(`- **TARE** add: "${p.text}" (strongest fix rig suggested: ${p.rung}). Write it as a behaviour with its reason and one example; if a check could catch it, build the check instead. Log it with this evidence.`)
    else L.push(`- **SEEN** again: "${p.text}". Tare already says: "${p.tareLine!.slice(0, 120)}". Add this evidence to its Tare log entry.`)
    L.push(`  - evidence: ${p.evidence.join('; ')}`)
  }
  return L.join('\n') + '\n'
}

// --repos a,b,c or --workspace <dir> (every child folder with a .rig/).
export function repoDirs(args: Args): string[] {
  const listed = opt(args, 'repos')?.split(',').map(s => s.trim()).filter(Boolean) ?? []
  const ws = opt(args, 'workspace')
  const found = ws ? fs.readdirSync(ws, { withFileTypes: true }).filter(e => e.isDirectory() && fs.existsSync(path.join(ws, e.name, '.rig'))).map(e => path.join(ws, e.name)) : []
  return [...new Set([...listed, ...found].map(d => path.resolve(d)))].sort()
}

export function cmdLessons(args: Args): void {
  const dirs = repoDirs(args)
  if (!dirs.length) die('usage: chb lessons --workspace <folder of clones> | --repos <dir,dir,…> [--tare SKILL.md] [--min-repos 2] [--out tare-proposal.md] [--json]')
  for (const d of dirs) if (!fs.existsSync(path.join(d, '.rig'))) die(`${d} is not a rig repo (no .rig/)`)
  const items = gather(dirs)
  const tareFile = opt(args, 'tare')
  const tare = tareFile ? tareLines(read(tareFile)) : []
  const ps = propose(items, tare, Number(opt(args, 'min-repos') ?? 2))
  if (flag(args, 'json')) return out(JSON.stringify({ repos: dirs, items: items.length, proposals: ps }, null, 2))
  const md = renderProposal(ps, dirs.length, items.length)
  const file = opt(args, 'out')
  if (file) { fs.writeFileSync(file, md); out(`${ps.length} proposal(s) from ${dirs.length} repo(s): ${file}`) } else out(md)
}
