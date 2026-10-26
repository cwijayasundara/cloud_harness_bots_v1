// Where this package lives, whether chb runs from source (src/*.ts) or from the build (dist/src/*.js).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const NAME = 'cloud-harness-bots'

export function pkgRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    const p = path.join(dir, 'package.json')
    if (fs.existsSync(p) && (JSON.parse(fs.readFileSync(p, 'utf8')) as { name?: string }).name === NAME) return dir
    dir = path.dirname(dir)
  }
  // Vendored into a rig repo (.rig/ub/src): no package.json; the vendored tree is its own root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

export function version(): string {
  const root = pkgRoot()
  for (const f of [path.join(root, 'package.json'), path.join(root, 'VERSION')]) {
    if (!fs.existsSync(f)) continue
    const t = fs.readFileSync(f, 'utf8')
    return f.endsWith('.json') ? (JSON.parse(t) as { version: string }).version : t.trim()
  }
  return 'unknown'
}
