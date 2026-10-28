// Read-only views of a rig repo's change records (.rig/changes/<slug>/), as rig_v1 writes them:
//   intent.md  frontmatter `type: feature | bugfix | refactor | chore`
//   verify.json {at, tree, base, pass, blocks}
//   review.md  `verdict: pass | changes-needed`, `## Findings` lines `- [severity: high] [category: x] path:line: … → fix[ → fixed]`
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const CHANGES = '.rig/changes'
export const ACTIVE = '.rig/state/active'
export type ChangeType = 'feature' | 'bugfix' | 'refactor' | 'chore'
export type Verify = { at: string; tree: string | null; base: string | null; pass: boolean; blocks: string[] }
export type Review = { verdict: 'pass' | 'changes-needed' | 'missing'; open: { severity: string; line: string }[] }

export const activeSlug = (root: string): string | null => {
  const f = path.join(root, ACTIVE)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() || null : null
}

export function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out: Record<string, string> = {}
  if (!m) return out
  for (const line of m[1]!.split('\n')) { const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line); if (kv) out[kv[1]!] = kv[2]!.trim() }
  return out
}

const LEGACY: Record<string, ChangeType> = { greenfield: 'feature', incident: 'bugfix', migration: 'chore', spike: 'chore' }
export function toType(raw: string | undefined): ChangeType {
  if (raw === 'feature' || raw === 'bugfix' || raw === 'refactor' || raw === 'chore') return raw
  return LEGACY[raw ?? ''] ?? 'feature' // rig's own default
}

export const parseVerify = (text: string | null): Verify | null => {
  if (!text) return null
  try { return JSON.parse(text) as Verify } catch { return null }
}

export function parseReview(text: string | null): Review {
  if (!text) return { verdict: 'missing', open: [] }
  const verdict = /^verdict:\s*(pass|changes-needed)/m.exec(text)?.[1] as Review['verdict'] | undefined
  const findings = text.split(/^(?=## )/m).find(s => /^## Findings\b/.test(s))?.split('\n').slice(1).join('\n') ?? ''
  const open = findings.split('\n').filter(l => l.startsWith('- ') && !/→\s*fixed\s*$/.test(l)).map(line => ({ severity: /severity:\s*(\w+)/.exec(line)?.[1] ?? 'unknown', line }))
  return { verdict: verdict ?? 'missing', open }
}

export const readChangeFile = (root: string, slug: string, name: string): string | null => {
  const f = path.join(root, CHANGES, slug, name)
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null
}

export const slugFromBranch = (branch: string): string | null => /^sdlc\/(.+)$/.exec(branch)?.[1] ?? null

// A frontmatter list in rig's three forms: `key: [a, b]`, `key: a`, and `key:` then `  - a` lines.
export function fmList(text: string, key: string): string[] {
  const rows = (/^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))?.[1] ?? '').split('\n')
  const at = rows.findIndex(r => new RegExp(`^${key}:`).test(r))
  if (at < 0) return []
  const tidy = (s: string) => s.trim().replace(/^["']|["']$/g, '').replace(/^\.\//, '')
  const inline = rows[at]!.slice(key.length + 1).replace(/\s+#.*$/, '').trim()
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(tidy).filter(Boolean)
  const outp: string[] = []
  for (const r of rows.slice(at + 1)) { if (!/^\s+-\s*\S/.test(r)) break; outp.push(tidy(r.replace(/^\s+-\s*/, '').replace(/\s+#.*$/, ''))) }
  return outp.filter(Boolean)
}

// Bullet paths under a `## <heading>` section, as rig's planFiles and blastRadius read them.
export function sectionPaths(text: string, heading: string): string[] {
  const body = text.replace(/\r\n/g, '\n').split(new RegExp(`^##\\s+${heading}[ \\t]*$`, 'm'))[1]?.split(/^## /m)[0] ?? ''
  return body.split('\n').flatMap(l => {
    const m = /^\s*(?:[-*]\s+)?(?:[A-Za-z]+:\s+)?(?:`([^`\s]+)`|([^`\s]+))/.exec(l)
    return m?.[1] ? [m[1]] : m?.[2] && /\/|\.\w+$/.test(m[2]) ? [m[2]] : []
  }).map(p => p.replace(/^\.\//, ''))
}

// rig's approvalState, over a branch's files: approval.json's hashes against sha256 (16 hex) of each approved file,
// CRLF normalised and trailing whitespace trimmed.
export type Approval = 'approved' | 'stale' | 'missing'
const digest = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n').replace(/\s+$/, '')).digest('hex').slice(0, 16)
export function approvalOf(files: Record<string, string>, approvalJson: string): Approval {
  const a = ((): { hashes?: Record<string, string> } | null => { try { return JSON.parse(approvalJson) as { hashes?: Record<string, string> } } catch { return null } })()
  if (!a?.hashes) return 'missing'
  const now = Object.fromEntries(['spec.md', 'plan.md', 'requirements.md'].filter(n => files[n]).map(n => [n, digest(files[n]!)]))
  const keys = [...new Set([...Object.keys(now), ...Object.keys(a.hashes)])]
  const h = a.hashes
  return keys.every(k => now[k] === h[k]) ? 'approved' : 'stale'
}
