#!/usr/bin/env node
// A scripted stand-in for `claude -p <prompt>`, for the pilot's dry run: it does what a plan or build session would do to
// the repo (branch, rig change folder, code, tests, proof, push) without a model, so the team's plumbing can be proven
// for $0. It is not an agent: its "code" is a fixed stub, and its proof says so (scripted: true).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const prompt = process.argv[process.argv.indexOf('-p') + 1] ?? ''
const repo = process.cwd()
const run = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  if (r.status !== 0) { process.stderr.write(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${r.stdout}${r.stderr}`); process.exit(1) }
  return r.stdout.trim()
}
const git = (args, cwd) => run('git', args, cwd)
const sdlc = (args, cwd) => run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(cwd, '.rig/bin/sdlc.ts'), ...args], cwd, { CLAUDE_PROJECT_DIR: cwd })
const scopeOf = text => (/^scope:\s*\[([^\]]*)\]/m.exec(text)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)
const fileFor = (scope, slug) => `${scope.replace(/\/?\*\*.*$/, '').replace(/\/$/, '')}/${slug}.js`
const worktree = (branch, from, create) => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-wt-'))
  fs.rmSync(wt, { recursive: true })
  git(['fetch', '-q', 'origin'], repo)
  git(create ? ['worktree', 'add', '-q', '-b', branch, wt, from] : ['worktree', 'add', '-q', '-B', branch, wt, from], repo)
  return wt
}
const done = wt => git(['worktree', 'remove', '--force', wt], repo)

const start = /^\/rig:start (\S+)/m.exec(prompt)
const build = /^Check out the branch sdlc\/([\w.-]+)/m.exec(prompt)
if (start) {
  const intent = start[1], slug = path.basename(intent, '.md')
  const wt = worktree(`sdlc/${slug}`, 'origin/main', true)
  sdlc(['new', slug, '--source', intent], wt)
  const files = scopeOf(fs.readFileSync(path.join(wt, intent), 'utf8')).map(s => fileFor(s, slug))
  fs.writeFileSync(path.join(wt, `.rig/changes/${slug}/plan.md`), `# Plan: ${slug}\n\n## Files\n${[...files, `test/${slug}.test.js`].map(f => `- ${f}`).join('\n')}\n\n## Tests\n- B1: test/${slug}.test.js (unit)\n\n## Contracts\nnone\n\n## Verification\n- npm test\n\n## Open questions\nnone\n`)
  git(['add', '-A'], wt); git(['commit', '-q', '-m', `plan: ${slug}`], wt); git(['push', '-q', '-u', 'origin', `sdlc/${slug}`], wt)
  done(wt)
  console.log(`CHB-RESULT kind=plan slug=${slug} branch=sdlc/${slug} status=awaiting-approval`)
} else if (build) {
  const slug = build[1]
  const wt = worktree(`sdlc/${slug}`, `origin/sdlc/${slug}`, false)
  const plan = fs.readFileSync(path.join(wt, `.rig/changes/${slug}/plan.md`), 'utf8')
  const files = [...plan.matchAll(/^- (\S+)$/gm)].map(m => m[1]).filter(f => !f.startsWith('test/'))
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(wt, f)), { recursive: true }); fs.writeFileSync(path.join(wt, f), `// ${slug} (scripted pilot stub)\nexport const ${slug.replace(/-(\w)/g, (_, c) => c.toUpperCase())} = () => true\n`) }
  fs.writeFileSync(path.join(wt, `test/${slug}.test.js`), `import { test } from 'node:test'\nimport assert from 'node:assert'\n${files.map((f, i) => `import * as m${i} from '../${f}'`).join('\n')}\ntest('B1 ${slug}', () => { ${files.map((_, i) => `assert.ok(Object.values(m${i})[0]())`).join('; ')} })\n`)
  fs.writeFileSync(path.join(wt, `.rig/changes/${slug}/proof.json`), JSON.stringify({ version: 1, slug, pass: true, scripted: true, reasons: [] }, null, 2) + '\n')
  git(['add', '-A'], wt); git(['commit', '-q', '-m', `feat: ${slug} (scripted pilot)`], wt); git(['push', '-q', 'origin', `sdlc/${slug}`], wt)
  done(wt)
  console.log(`CHB-RESULT kind=build slug=${slug} proof=pass rounds=1 status=done`)
} else {
  process.stderr.write(`scripted-claude: no plan or build in the prompt:\n${prompt.slice(0, 300)}\n`)
  process.exit(2)
}
