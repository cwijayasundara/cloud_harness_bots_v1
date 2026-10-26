// Thin wrapper over the GitHub CLI. Every network call the bots make goes through `gh`, so the token's scope is the
// boundary: give the bot computer a fine-grained token limited to the repos in scope.
import { spawnSync } from 'node:child_process'
import { die } from './cli.ts'

export function gh(args: string[], cwd = process.cwd()): string {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) die(`gh could not run (${r.error.message}): install the GitHub CLI and run gh auth login`, 2)
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
  return r.stdout
}

export const ghJson = <T>(args: string[], cwd?: string): T => JSON.parse(gh(args, cwd) || 'null') as T

export function ghTry(args: string[], cwd?: string): string | null {
  try { return gh(args, cwd) } catch { return null }
}
