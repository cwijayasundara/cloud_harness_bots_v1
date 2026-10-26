# cloud_harness_bots_v1

**Grok Bots manage, rig builds in Claude Code cloud sessions, and Uncle Bob's computed gates decide when a change is done.** This package is the deterministic layer between them: the `chb` commands the bots call, the rig sensors and skills that make the gates part of every change, and the bot roles to paste into Grok Bot.

```
You ── ideas, /rig:approve, merges above small chores ──────────────────────────────┐
 │                                                                                 ▲
 ▼                                                                                 │ 07:30 brief
Grok Bot (outer loop) ── Foreman · Scribe · Smith · Auditor · Keeper · Scout ──────┘
 │  chb dispatch plan|build|audit  →  claude --cloud "/rig:start … / /rig:build …"
 ▼
Claude Code cloud + rig (inner loop) ── start → plan → {{approve}} → build → test → pr
 │  every commit: rig sensors incl. ub-crap, ub-dry · CI: rig-check, ub-gates (ub-mutate)
 ▼
chb proof → .rig/changes/<slug>/proof.json ── chb ledger (labels) ── chb merge (policy)
```

[![ci](https://github.com/cwijayasundara/cloud_harness_bots_v1/actions/workflows/ci.yml/badge.svg)](https://github.com/cwijayasundara/cloud_harness_bots_v1/actions/workflows/ci.yml)

Zero runtime dependencies. Node 22.18+ runs it as TypeScript from a checkout, like rig; an npm install builds `dist/`. Python 3 is needed for Uncle Bob's tools; `gh` for the GitHub commands; the `claude` CLI for dispatch.

## What is in the box

| Path | What |
| --- | --- |
| `bin/chb.ts`, `src/` | The CLI: `gate`, `baseline`, `proof`, `ledger`, `merge`, `dispatch`, `report`, `tools`, `install`, `upgrade`, `doctor` |
| `skills/policy-craft` | ub-mode adapted to rig's stages, as a rig policy skill (owner + source) |
| `skills/verify-app` | Template for proving a change on the running app (pstack's verification-skill idea) |
| `bots/` | Six Grok Bot roles with descriptions, routines and approval rules, plus `setup-computer.sh` |
| `playbook/` | The rules every bot follows (Keeper maintains it) and the postmortem template |
| `templates/ub-gates.yml` | The gates as a PR check, judged with the base branch's code and baseline |
| `templates/chb-ledger.yml` | The PR ledger hourly in GitHub Actions (labels + one issue), opt-in auto-merge: the outer loop without Grok Bot |
| `ROLLOUT.md` | 30 days, four weekly gates you can check |

## Quick start

```bash
npm install -g github:cwijayasundara/cloud_harness_bots_v1     # or: git clone … && npm ci && npm link
chb tools install                     # crapper, dryer, mutator → ~/.ub-tools (siblings, as mutator needs)
chb doctor                            # machine check; every ✗ prints its fix

cd ~/path/to/rig-repo                 # a repo where /rig:init has run
chb install . --owner @you --ci --ledger --ub-mode
node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts baseline write --skip mutate
chb doctor                            # repo check: all ✓
git switch -c chore/ub-gates && git add -A && git commit -m "chore: Uncle Bob gates via chb"   # rig's hooks run here
git push -u origin chore/ub-gates     # open the PR; a code owner approves (sensors.json and .claude/ are protected)
```

Then follow [ROLLOUT.md](ROLLOUT.md) and [bots/README.md](bots/README.md). Later releases: `npm install -g github:cwijayasundara/cloud_harness_bots_v1` again, then `chb upgrade <repo>`, which refreshes only the vendored CLI.

## Two ways to run the outer loop

| | Grok Bot (the proposal) | GitHub Actions only |
| --- | --- | --- |
| Ledger + labels | Foreman, hourly and on events | `chb-ledger.yml`, hourly 06:17–22:17 UTC |
| Morning brief, hand-offs, nudging stalled work | Foreman, Smith | not covered |
| Overnight builds | Smith: `chb dispatch build` | not covered |
| Nightly audit | Auditor: `chb dispatch audit` | not covered |
| Auto-merge | Foreman: `chb merge --go` | repository variable `CHB_AUTOMERGE=true` |

Both read and write the same `chb:*` labels, so they can run side by side; the Actions ledger is the floor when no bot is running.

## How the gates judge

Each gate runs the tool on the repo's own source (git-tracked or new and not ignored, never `.venv` or `node_modules`). It reads the tool's `.metrics/*.edn` snapshot and judges every finding against `.rig/ub-baseline.json`:

| Finding | Verdict |
| --- | --- |
| New function at CRAP ≥ 10, new duplicate pair ≥ 0.8, or a surviving mutant in changed code | **BLOCK** |
| Debt the baseline already holds, at the same level or better | warn (legacy) |
| Legacy debt that got worse | **BLOCK** |
| The baseline loosened against the base branch (key added, value raised, threshold relaxed) | **BLOCK** (only a person, with `CHB_ALLOW_BASELINE_LOOSEN=1`) |

`--scope changed` (the default) judges files added or modified since the merge-base, plus uncommitted work, and exits 1 on a BLOCK. It fails with exit 2 rather than pass when there is no base branch or merge-base (a shallow clone, an unknown default branch). `--scope all` judges the whole repo and exits 0. Either way, the last line is one number, so a rig sensor can use it as a ratchet.

### What counts as proof

`proof.json` is written by the agent, so nothing trusts it alone:

- **A gate result is proof only from a full, default run on committed code.** `--no-run`, a raised `--max`/`--min`, `-- --no-coverage`, unscored functions, or uncommitted source mark it "not proof".
- **Results are tied to code.** Each result is stamped with HEAD, and `verify.json` is checked against rig's own tree stamp, the same check rig's `verifyFresh` makes.
- **The ledger treats a proof as current only if nothing but that change's `proof.json` was committed after it.** Code, `verify.json` or `review.md` edits make it stale, and so does a proof with no head.
- **Auto-merge also requires the `ub-gates` CI check.** That check recomputes the gates on fresh runners with the base branch's gate code, baseline and pinned tools. It lists every PR file through paginated REST, including the old path of a rename, so a protected file cannot be moved out of sight.

Three traps this avoids, each found by running the real tools:

- **`--changed` is vacuous once you commit.** The tools read `git status`, so on a committed branch crapper says "No source files to analyze" and exits 0. chb diffs against the merge-base instead.
- **A bare whole-tree run scores your virtualenv.** On the sample repo it reported 424 CRAP entries instead of 1. chb always passes explicit file lists.
- **dryer exits 0 even when it finds duplicates.** chb reads `.metrics/dry.edn`, never the exit code.

## Verified on 26 Oct 2026

Against crapper `6fd92c4`, dryer `66ff6d2`, mutator `a5a0cb8`, and a Python repo initialised with rig_v1 `b436071` (`sdlc.ts init --stack python --full`) plus `chb install`:

- The baseline recorded the repo's one legacy function (CRAP 90) and one duplicate pair; legacy findings warn on later changes.
- A new untested branchy function (CRAP 57.3) warned in rig's pre-commit while advisory. With `"blocks": true`, rig refused the commit.
- Splitting and testing it passed the hook. mutator then caught a dead `else` branch that the unit tests could not see, and deleting it cleared the gate.
- An agent adding its own function to the baseline was blocked, and so was a new copy of a duplicated function.
- `chb proof` refused gate results judged at an older commit until they were rerun.
- `chb install` merged the sensors, re-synced rig's CLAUDE.md block, and the commit passed rig's hooks.

An independent review then found twelve ways to get past the gates or the merge policy. All twelve are fixed and have regression tests; the important ones were re-run on real rig: an uncommitted edit, a `--no-run` re-judge, and a code commit made after verify each stop the proof. Two of them had been reproduced: Go and Rust mutation snapshots were never read (mutator nests them in subdirectories), and a repo whose base branch is not main or master passed vacuously.

**Not yet verified**, because this needs your accounts: `ledger`, `merge` and `report` against live GitHub (tested here with a recording fake `gh`), and `dispatch --go` starting a real `claude --cloud` session from the Grok Bot computer. That second one is week 1's gate.

## Findings about rig_v1 worth knowing

- In rig-check's CI job the tools are not installed, so the ub sensors print a skip notice there and defer to the required `ub-gates` check. Locally, and inside ub-gates, a missing tool is a hard failure.
- rig accepts a `nightly` sensor cadence, but `sdlc.ts check` runs only `stop|commit|ship|ci`, so nightly sensors never run. That includes each stack pack's `mutation` sensor. chb puts no sensor on `nightly`, and the Auditor bot covers whole-tree runs instead.
- `/rig:start` runs a superpowers brainstorm with a person. `chb dispatch plan` tells an unattended session to leave the questions under `## Open questions`, and you close them before `/rig:approve`.
- rig has no S/M/L tiers any more, so auto-merge is limited to small `chore` and `refactor` changes (≤ 150 lines, nothing protected, rig-check and ub-gates green). Tune it with `CHB_AUTOMERGE_TYPES`, `CHB_AUTOMERGE_MAX_LINES` and `CHB_REQUIRED_CHECKS`.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `UB_TOOLS_DIR` | `~/.ub-tools` | gates, tools |
| `CHB_BASE` | `origin/HEAD`, then `origin/main`, `main`, `origin/master`, `master` | gates, proof |
| `CHB_REQUIRED_GATES` | `crap,dry` | proof (add `mutate` in week 4) |
| `CHB_ALLOW_BASELINE_LOOSEN` | unset | gates (a person sets it) |
| `CHB_TOOL_TIMEOUT_MS` | 1800000 | gates |
| `CHB_AUTOMERGE_TYPES`, `CHB_AUTOMERGE_MAX_LINES`, `CHB_REQUIRED_CHECKS` | `chore,refactor`, 150, `rig-check,ub-gates` | merge |
| `CHB_HOME`, `CHB_TZ` | `~/.chb`, `Europe/London` | dispatch log, report |
| `CHB_AUDIT_MUTATE` | unset | dispatch audit |

## Credits and licences

Uncle Bob's [crapper](https://github.com/unclebob/crapper), [dryer](https://github.com/unclebob/dryer) and [mutator](https://github.com/unclebob/mutator) (0BSD) are cloned at install time, not bundled. [ub-mode](https://github.com/unclebob/ub-mode) has no licence file, so it is fetched to your user skills, and `policy-craft` restates its rules in new words. Ideas from [poteto's pstack](https://github.com/cursor/plugins/tree/main/pstack) and the [Grok Bot engineering guide](https://x.ai/bot/guides/grok-bot-for-engineering). This package: MIT.
