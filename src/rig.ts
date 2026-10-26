// Read-only views of a rig repo's change records (.rig/changes/<slug>/), as rig_v1 writes them:
//   intent.md  frontmatter `type: feature | bugfix | refactor | chore`
//   verify.json {at, tree, base, pass, blocks}
//   review.md  `verdict: pass | changes-needed`, `## Findings` lines `- [severity: high] [category: x] path:line: … → fix[ → fixed]`
import fs from 'node:fs'
import path from 'node:path'

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
