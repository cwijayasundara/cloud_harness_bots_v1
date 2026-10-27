// `chb dispatch <plan|build|audit> …`: what the Smith and Auditor bots run to start work in a Claude Code cloud session
// (`claude --cloud "<prompt>"`, run from a clone of the repo). rig's rule holds: a model never approves. So work is
// dispatched in two halves around the one human gate:
//   plan  → /rig:start + /rig:plan, push sdlc/<slug>, stop at the approval gate
//   (you run /rig:approve <slug> locally and push approval.json)
//   build → /rig:build, /rig:test, /rig:pr, then the gates and chb proof, push
//   audit → whole-tree gates on the base branch, then a plan (not a build) for the single worst finding
// Dry by default: prints the exact command. --go runs it; --local uses `claude -p` on this machine instead of the cloud.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { type Args, flag, opt, out, die } from './cli.ts'
import { git } from './git.ts'

export const CHB = 'node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts'
const RESULT = 'End your final message with exactly one line:'

// Tare, CK's personal engineering skill, is loaded by name rather than left to auto-triggering: in Vercel's eval a skill
// went uninvoked in 56% of runs. Present in the repo → every dispatched prompt starts with this line.
export const TARE_PATH = '.claude/skills/tare/SKILL.md'
export const TARE_LINE = `Before anything else, read ${TARE_PATH} and follow it for this change.`
// Two fix-up rounds per session and two build sessions per change, then a person looks (Stripe caps CI at two rounds:
// after that, more agent time mostly buys more cost).
export const MAX_ROUNDS = 2
const maxBuilds = Number(process.env.CHB_MAX_BUILDS)
export const MAX_BUILDS = Number.isInteger(maxBuilds) && maxBuilds > 0 ? maxBuilds : 2

export function reviewPrompt(slug: string, base: string): string {
  return [
    `You are reviewing a change you did not write. Check out sdlc/${slug} and pull it. Do not run the build stage and do not edit any code, test or config file.`,
    `Read .rig/changes/${slug}/intent.md and spec.md, then the whole diff against ${base} (git diff ${base}...HEAD). Run the tests and \`${CHB} tare all\`; read .rig/ub/results/.`,
    'Judge it as CK would: does it do what the intent says, are the tests real (they fail without the change), is anything outside the change, would you be comfortable reverting it?',
    `Write .rig/changes/${slug}/review.md in rig's format: a \`verdict: pass|changes-needed\` line, then \`## Findings\` with one line per finding: \`- [severity: critical|high|medium|low] [category: x] path:line: what → fix\`. Commit only that file and push.`,
    `${RESULT} CHB-RESULT kind=review slug=${slug} verdict=<pass|changes-needed> high=<n>`,
  ].join('\n')
}

// Which repository a clone is: its origin URL (so a second clone of the same repo shares the count), else its real path.
export const repoKey = (dir: string): string => git(['remote', 'get-url', 'origin'], dir)?.trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/') || (() => { try { return fs.realpathSync(dir) } catch { return dir } })()

// Earlier build dispatches for this change, from the dispatch log.
export function buildsSoFar(log: string, slug: string, repo: string): number {
  if (!fs.existsSync(log)) return 0
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) as { kind?: string; slug?: string; repo?: string; dir?: string } } catch { return {} } })
    .filter(e => e.kind === 'build' && e.slug === slug && (e.repo ?? e.dir) === repo).length
}

export const withTare = (prompt: string, dir: string): string => fs.existsSync(path.join(dir, TARE_PATH)) ? `${TARE_LINE}\n\n${prompt}` : prompt

export function planPrompt(what: string): string {
  return [
    `/rig:start ${what}`,
    '',
    'No person is in this session. When the brainstorm would ask CK a question, do not answer it yourself: write it under `## Open questions` in spec.md with your recommended answer, and carry on with the parts it does not block. CK closes open questions before he approves.',
    'Then run /rig:plan. Apply the policy-craft skill (ub-mode: make it work, then make it right) while you write spec.md and plan.md: name the data shape first, one failing test per behaviour, the smallest design that meets the spec.',
    'Stop at the approval gate. Never run /rig:approve and never write approval.json: only a person approves.',
    `Commit the change folder on its sdlc/<slug> branch and push it. ${RESULT} CHB-RESULT kind=plan slug=<slug> branch=<branch> status=awaiting-approval`,
  ].join('\n')
}

export function buildPrompt(slug: string): string {
  return [
    `Check out the branch sdlc/${slug} and pull it. Confirm .rig/changes/${slug}/approval.json is present; if it is missing, stop and report CHB-RESULT kind=build slug=${slug} status=not-approved.`,
    `Run \`node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts activate ${slug}\`, then /rig:build, then /rig:test, then /rig:pr. Apply the policy-craft skill throughout.`,
    `After /rig:pr has pushed: run \`${CHB} gate crap\`, \`${CHB} gate dry\` and \`${CHB} proof ${slug}\`.`,
    `Run \`${CHB} tare all\` too. Fix every BLOCK finding in the code, following its fix: line. Never edit .rig/ub-baseline.json, .rig/tare.json, a test expectation, or a sensor to make a check pass. Rerun the gates, the Tare checks and the proof until the proof passes, at most ${MAX_ROUNDS} rounds; then stop and report status=needs-human with what is still failing.`,
    `Commit .rig/changes/${slug}/proof.json and push. ${RESULT} CHB-RESULT kind=build slug=${slug} pr=<url> proof=<pass|fail> rounds=<n> status=<done|needs-human>`,
  ].join('\n')
}

export function auditPrompt(base: string, mutate: boolean): string {
  return [
    `Nightly audit of ${base}. Check out ${base} and pull it. Make no code changes in this step.`,
    `Run \`${CHB} gate crap --scope all\`${mutate ? `, \`${CHB} gate mutate --scope all\`` : ''} and \`${CHB} gate dry --scope all\`. Read .rig/ub/results/*.json.`,
    'Pick the ONE finding with the most leverage: the highest CRAP score in code that changed recently, the duplicate pair with the highest score, or the function with the most surviving mutants. Prefer the one whose fix is a refactor that keeps behaviour.',
    '/rig:start "refactor: <what you will change and why, naming the function and its score>"',
    'Then /rig:plan: pin current behaviour with characterization tests first, then change the structure. Stop at the approval gate; never approve. Push the branch.',
    `${RESULT} CHB-RESULT kind=audit slug=<slug> branch=<branch> finding="<gate> <key> <value>" status=awaiting-approval`,
  ].join('\n')
}

// A reviewer that did not write the change. Locally the Edit tools are removed. Write and Bash stay, because it writes
// review.md, runs the tests and pushes, so it is told, not forced, to change nothing else; the same holds in the cloud.
// What it pushed besides review.md shows in the PR's diff.
// CHB_CLAUDE_ARGS: extra flags for a local session (a CI runner sets the permission mode and a budget there).
export const extraArgs = (env = process.env.CHB_CLAUDE_ARGS): string[] => (env ?? '').split(/\s+/).filter(Boolean)
export function command(prompt: string, local: boolean, readOnly = false): string[] {
  if (!local) return ['claude', '--cloud', prompt]
  return [...(readOnly ? ['claude', '-p', prompt, '--disallowedTools', 'Edit', 'MultiEdit', 'NotebookEdit'] : ['claude', '-p', prompt]), ...extraArgs()]
}

export function cmdDispatch(args: Args): void {
  const kind = args.pos[0]
  const dir = path.resolve(opt(args, 'repo-dir') ?? process.cwd())
  if (!fs.existsSync(path.join(dir, '.rig'))) die(`${dir} is not a rig repo (no .rig/): pass --repo-dir <clone>`)
  let prompt: string
  if (kind === 'plan') {
    const what = args.pos.slice(1).join(' ')
    if (!what) die('usage: chb dispatch plan <.rig/product/sprints/sprint-N/intents/x.md | "task text">')
    prompt = planPrompt(what)
  } else if (kind === 'build') {
    const slug = args.pos[1]
    if (!slug || !/^[\w.-]+$/.test(slug)) die('usage: chb dispatch build <slug>')
    if (git(['ls-remote', '--exit-code', 'origin', `refs/heads/sdlc/${slug}`], dir) === null) die(`origin has no branch sdlc/${slug}: dispatch plan first`)
    prompt = buildPrompt(slug)
  } else if (kind === 'review') {
    const slug = args.pos[1]
    if (!slug || !/^[\w.-]+$/.test(slug)) die('usage: chb dispatch review <slug>')
    prompt = reviewPrompt(slug, opt(args, 'base') ?? 'main')
  } else if (kind === 'audit') {
    prompt = auditPrompt(opt(args, 'base') ?? 'main', flag(args, 'mutate') || process.env.CHB_AUDIT_MUTATE === '1')
  } else return die('usage: chb dispatch <plan|build|review|audit> … [--repo-dir <clone>] [--local] [--go]')

  prompt = withTare(prompt, dir)
  const cmd = command(prompt, flag(args, 'local'), kind === 'review')
  const log = path.join(process.env.CHB_HOME ?? path.join(os.homedir(), '.chb'), 'dispatch.jsonl')
  // A plan's slug is its intent file's name; the coordinator counts a dispatched plan as in flight before its branch exists.
  const slugArg = kind === 'build' || kind === 'review' ? args.pos[1] : kind === 'plan' && /\.md$/.test(args.pos[1] ?? '') ? path.basename(args.pos[1]!, '.md') : undefined
  // --no-log: chb coordinate --emit already recorded this dispatch and checked its caps.
  const noLog = flag(args, 'no-log')
  if (kind === 'build' && flag(args, 'go') && !flag(args, 'force') && !noLog) {
    const n = buildsSoFar(log, slugArg!, repoKey(dir))
    if (n >= MAX_BUILDS) die(`${slugArg}: ${n} build session(s) already dispatched. It needs a person now: read the last CHB-RESULT and the proof, then fix the brief or the code (--force sends another session anyway).`)
  }
  if (!flag(args, 'go')) return out([`dry run (pass --go to start it), from ${dir}:`, '', `${cmd[0]} ${cmd[1]} "$(cat <<'PROMPT'`, prompt, `PROMPT`, `)"${cmd.length > 3 ? ` ${cmd.slice(3).join(' ')}` : ''}`].join('\n'))
  if (!noLog) {
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), kind, ...(slugArg ? { slug: slugArg } : {}), repo: repoKey(dir), dir, local: flag(args, 'local'), prompt }) + '\n')
  }
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, stdio: 'inherit' })
  if (r.error) die(`claude could not run: ${r.error.message}`, 2)
  process.exitCode = r.status ?? 1
}
