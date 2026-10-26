// Typed views of the snapshots Uncle Bob's tools write under .metrics/ (formats from each tool's README):
//   crapper → .metrics/crap.edn          {:entries [{:name :namespace :complexity :coverage :crap}]}
//   dryer   → .metrics/dry.edn           {:candidates [{:score :language :left {:file :start-line :end-line} :right {…}}]}
//   mutator → .metrics/mutate/<ns>.edn   {:source :namespace :forms [{:id :file :line :end-line :killed :survived :uncovered :sites}]}
import fs from 'node:fs'
import path from 'node:path'
import { parseEdn, type Edn } from './edn.ts'

export type CrapEntry = { namespace: string; name: string; complexity: number; coverage: number | null; crap: number | null }
export type Span = { file: string; startLine: number; endLine: number }
export type DryCandidate = { score: number; language: string; left: Span; right: Span }
export type MutateForm = { namespace: string; source: string; id: string; file: string; line: number; endLine: number; killed: number; survived: number; uncovered: number; sites: number }

type Obj = { [k: string]: Edn }
const obj = (v: Edn | undefined): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const arr = (v: Edn | undefined): Edn[] => (Array.isArray(v) ? v : [])
const num = (v: Edn | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: Edn | undefined): string => (typeof v === 'string' ? v : '')

export const METRICS = '.metrics'

export function readCrap(root: string): CrapEntry[] {
  const file = path.join(root, METRICS, 'crap.edn')
  if (!fs.existsSync(file)) return []
  return arr(obj(parseEdn(fs.readFileSync(file, 'utf8'))).entries).map(e => {
    const o = obj(e)
    return { namespace: str(o.namespace), name: str(o.name), complexity: num(o.complexity) ?? 0, coverage: num(o.coverage), crap: num(o.crap) }
  })
}

const span = (v: Edn | undefined): Span => { const o = obj(v); return { file: str(o.file), startLine: num(o['start-line']) ?? 0, endLine: num(o['end-line']) ?? 0 } }

export function readDry(root: string): DryCandidate[] {
  const file = path.join(root, METRICS, 'dry.edn')
  if (!fs.existsSync(file)) return []
  return arr(obj(parseEdn(fs.readFileSync(file, 'utf8'))).candidates).map(c => {
    const o = obj(c)
    return { score: num(o.score) ?? 0, language: str(o.language), left: span(o.left), right: span(o.right) }
  })
}

export function readMutate(root: string): MutateForm[] {
  const dir = path.join(root, METRICS, 'mutate')
  if (!fs.existsSync(dir)) return []
  const forms: MutateForm[] = []
  // Recursive: mutator turns "/" and "::" in a namespace into subdirectories (Go import paths, Rust crate::module).
  for (const name of (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => f.endsWith('.edn')).sort()) {
    const snap = obj(parseEdn(fs.readFileSync(path.join(dir, name), 'utf8')))
    const namespace = str(snap.namespace), source = str(snap.source)
    for (const f of arr(snap.forms)) {
      const o = obj(f)
      forms.push({
        namespace, source, id: str(o.id), file: str(o.file) || source, line: num(o.line) ?? 0, endLine: num(o['end-line']) ?? 0,
        killed: num(o.killed) ?? 0, survived: num(o.survived) ?? 0, uncovered: num(o.uncovered) ?? 0, sites: num(o.sites) ?? 0,
      })
    }
  }
  return forms
}
