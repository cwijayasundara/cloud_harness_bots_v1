// Argument parsing and output, kept tiny and dependency-free.
export type Args = { pos: string[]; opts: Record<string, string>; flags: Set<string>; rest: string[] }

// Options that never take a value, so `--json foo` keeps `foo` positional.
const BOOL = new Set(['no-run', 'strict', 'json', 'allow-loosen', 'go', 'apply', 'labels', 'local', 'ub-mode', 'force', 'help', 'dry-run', 'skip-tools', 'gh', 'ci', 'mutate', 'ledger', 'unchecked', 'gates', 'keep', 'all', 'no-fetch', 'no-log', 'coordinate'])

export function parseArgs(argv: string[]): Args {
  const a: Args = { pos: [], opts: {}, flags: new Set(), rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!
    if (t === '--') { a.rest = argv.slice(i + 1); break }
    if (!t.startsWith('--')) { a.pos.push(t); continue }
    const eq = t.indexOf('=')
    if (eq > 0) { a.opts[t.slice(2, eq)] = t.slice(eq + 1); continue }
    const k = t.slice(2), next = argv[i + 1]
    if (!BOOL.has(k) && next !== undefined && !next.startsWith('--')) { a.opts[k] = next; i++ }
    else a.flags.add(k)
  }
  return a
}

export const opt = (a: Args, k: string): string | undefined => a.opts[k]
export const flag = (a: Args, k: string): boolean => a.flags.has(k)
export const out = (s: string): void => { process.stdout.write(s.endsWith('\n') ? s : s + '\n') }
export const warn = (s: string): void => { process.stderr.write(s.endsWith('\n') ? s : s + '\n') }
export function die(msg: string, code = 1): never {
  warn(msg)
  process.exit(code)
}
