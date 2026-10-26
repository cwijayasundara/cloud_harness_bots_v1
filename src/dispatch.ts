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
    'Fix every BLOCK finding in the code: split or test the function, extract the duplicate. Never edit .rig/ub-baseline.json, a test expectation, or a sensor to make a gate pass. Rerun the gates and the proof until the proof passes, at most 3 rounds.',
    `Commit .rig/changes/${slug}/proof.json and push. ${RESULT} CHB-RESULT kind=build slug=${slug} pr=<url> proof=<pass|fail> rounds=<n>`,
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

export function command(prompt: string, local: boolean): string[] {
  return local ? ['claude', '-p', prompt] : ['claude', '--cloud', prompt]
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
  } else if (kind === 'audit') {
    prompt = auditPrompt(opt(args, 'base') ?? 'main', flag(args, 'mutate') || process.env.CHB_AUDIT_MUTATE === '1')
  } else return die('usage: chb dispatch <plan|build|audit> … [--repo-dir <clone>] [--local] [--go]')

  const cmd = command(prompt, flag(args, 'local'))
  const log = path.join(process.env.CHB_HOME ?? path.join(os.homedir(), '.chb'), 'dispatch.jsonl')
  if (!flag(args, 'go')) return out([`dry run (pass --go to start it), from ${dir}:`, '', `${cmd[0]} ${cmd[1]} "$(cat <<'PROMPT'`, prompt, `PROMPT`, `)"`].join('\n'))
  fs.mkdirSync(path.dirname(log), { recursive: true })
  fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), kind, dir, local: flag(args, 'local'), prompt }) + '\n')
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: dir, stdio: 'inherit' })
  if (r.error) die(`claude could not run: ${r.error.message}`, 2)
  process.exitCode = r.status ?? 1
}
