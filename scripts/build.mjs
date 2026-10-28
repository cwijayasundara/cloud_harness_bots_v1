#!/usr/bin/env node
// Builds dist/ from bin/ and src/ with Node's own type stripping, so the build needs no dev dependencies:
// `npm install -g github:…` runs prepare in a clone whose dev dependencies npm did not install (a global install of a git
// package), and tsc was not there to run. tsc stays the type checker (npm run typecheck).
import fs from 'node:fs'
import path from 'node:path'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const DIST = path.join(ROOT, 'dist')
// `./x.ts` and `../x.ts` in static and dynamic imports and re-exports become `.js`, as tsc's rewriteRelativeImportExtensions does.
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g

fs.rmSync(DIST, { recursive: true, force: true })
let n = 0
for (const dir of ['bin', 'src']) {
  fs.mkdirSync(path.join(DIST, dir), { recursive: true })
  for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.ts'))) {
    const js = stripTypeScriptTypes(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), { mode: 'strip' }).replace(SPECIFIER, '$1$2$3.js$2')
    const to = path.join(DIST, dir, f.replace(/\.ts$/, '.js'))
    fs.writeFileSync(to, js, { mode: dir === 'bin' ? 0o755 : 0o644 })
    n++
  }
}
console.log(`built ${n} files into dist/`)
