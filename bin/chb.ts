#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// chb: the deterministic commands the Grok bots (and you) call. Zero runtime dependencies; Node 22.18+ runs it as
// TypeScript from a checkout, and `npm run build` makes dist/ for installs under node_modules.
import { parseArgs, out, die } from '../src/cli.ts'
import { cmdGate, cmdBaseline } from '../src/gate.ts'
import { cmdProof } from '../src/proof.ts'
import { cmdLedger } from '../src/ledger.ts'
import { cmdMerge } from '../src/merge.ts'
import { cmdDispatch } from '../src/dispatch.ts'
import { cmdReport } from '../src/report.ts'
import { cmdTools } from '../src/tools.ts'
import { cmdInstall, cmdUpgrade } from '../src/install.ts'
import { cmdDoctor } from '../src/doctor.ts'
import { version } from '../src/pkg.ts'

const HELP = `chb: Grok Bot outer loop + Uncle Bob's computed gates, for rig repos

Gates (run inside a rig repo; last output line is one number, for rig ratchets)
  chb gate crap   [--scope changed|all] [--base <ref>] [--max 10]   [--no-run] [--strict] [-- <crapper args>]
  chb gate dry    [--scope changed|all] [--base <ref>] [--min 0.8]  [--no-run] [--strict]
  chb gate mutate [--scope changed|all] [--base <ref>]              [--no-run] [--strict] [-- <mutator args>]
  chb baseline write [--skip crap,dry,mutate] [--no-run] [--allow-loosen]
  chb baseline check [--base <ref>]
  chb proof [<slug>] [--base <ref>] [--json]

Outer loop (needs gh, authenticated with a token scoped to the repos in play)
  chb ledger [--repo owner/name] [--labels] [--history file.jsonl] [--out ledger.md] [--json]
  chb merge <pr> [--repo owner/name] [--go]
  chb dispatch plan <intent path | "task">  [--repo-dir <clone>] [--local] [--go]
  chb dispatch build <slug>                 [--repo-dir <clone>] [--local] [--go]
  chb dispatch audit [--base main] [--mutate] [--repo-dir <clone>] [--local] [--go]
  chb report [--days 7] [--repo owner/name] [--touch-log touches.csv] [--json]

Setup
  chb doctor [--repo-dir <dir>]          is this machine and this repo ready? (exit 1 when not)
  chb version
  chb tools install [--pin crapper=<sha>,dryer=<sha>,mutator=<sha>] | chb tools status
  chb install <rig repo> [--owner @you] [--ci] [--ledger] [--ub-mode] [--force]
  chb upgrade <rig repo>                 refresh the vendored CLI only (keeps sensors, skills, baseline)

Exit codes: 0 pass, 1 blocking findings or a refused action, 2 a tool or setup failure.`

const COMMANDS: Record<string, (a: ReturnType<typeof parseArgs>) => void> = {
  gate: cmdGate, baseline: cmdBaseline, proof: cmdProof, ledger: cmdLedger, merge: cmdMerge,
  dispatch: cmdDispatch, report: cmdReport, tools: cmdTools, install: cmdInstall, upgrade: cmdUpgrade, doctor: cmdDoctor,
  version: () => out(version()),
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === '--version' || cmd === '-v') out(version())
else if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') out(HELP)
else if (!COMMANDS[cmd]) die(`unknown command ${cmd}\n\n${HELP}`)
else {
  try { COMMANDS[cmd]!(parseArgs(rest)) } catch (e) { die(`chb ${cmd}: ${(e as Error).message}`, 2) }
}
