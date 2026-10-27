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
| `bin/chb.ts`, `src/` | The CLI: `gate`, `baseline`, `proof`, `ledger`, `merge`, `dispatch`, `report`, `replay`, `tare`, `lessons`, `nightly`, `tools`, `install`, `upgrade`, `doctor` |
| `skills/policy-craft` | ub-mode adapted to rig's stages, as a rig policy skill (owner + source) |
| `skills/tare` | Tare: CK's engineering preferences (`SKILL.md`) and where each rule came from (`log.md`). This is the canonical copy: `chb tare sync` copies it into repos |
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

## Tare checks: the rules a machine can check

Phase 2 of the improvement plan. Each line of Tare that can be checked mechanically becomes a check, because agents follow prose most of the time and a check every time. `chb install` adds them to `.rig/sensors.json` as **advisory** sensors (`"blocks": false`) at commit cadence.

| Tare line | Check | What it catches |
| --- | --- | --- |
| No TODOs, stubs or placeholders | `chb tare placeholders` | Added lines with TODO, FIXME, HACK or XXX in comments, and stubs in source: `raise NotImplementedError` (except abstract methods), "not implemented" throws, `todo!()` and `unimplemented!()` |
| Frozen reproduction test before a bugfix (and characterization tests before a refactor) | `chb tare frozen-tests` | Source changed before a test-only commit; those tests edited later, committed or not |
| No dependency the brief doesn't name | `chb tare deps` | New direct dependencies in `package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod` or `Cargo.toml` that the change's intent or spec doesn't mention (`plan.md` doesn't count: the build stage edits it). Workspace links and `// indirect` lines are ignored |
| Commit only your own files | `chb tare scope` | `.env*` files (not `*.example`), keys outside test fixtures, logs, caches, `dist/`, `target/` and `coverage/` at the root, and files over 1 MB other than lockfiles |
| Stop after two failed attempts | `chb dispatch build` | Refuses a third build session for the same change in the same repo (counted by origin URL; `--force` overrides). The build prompt allows two fix-up rounds, then reports `status=needs-human` |
| Fresh reviewer | `chb dispatch review <slug>` | Starts a session that didn't write the change. Run locally (`--local`), it has no Edit tools; it keeps Write and Bash for review.md and the tests, so "change nothing else" is an instruction, visible in the PR diff |
| Lint messages as fix instructions | every gate and check | Each BLOCK line is followed by a `fix:` line the agent can act on |

Every check prints `BLOCK file:line: what`, then `fix: …`, and ends with the finding count, so rig can use it as a ratchet. Results go to `.rig/ub/results/tare-<check>.json`. `chb tare all` runs all four.

**What is judged** is the tree being committed: the index against the merge-base with the base branch.
- Unstaged edits and untracked scratch files don't count, and following a `fix:` line clears the finding.
- In CI the change is found from the PR branch (`GITHUB_HEAD_REF`) and the base from `GITHUB_BASE_REF`.
- With no base or on a first commit, a check reports "not judged" and passes rather than crashing, so it can't wedge commits once it blocks.
- Paths with spaces or non-ASCII characters, and `diff.noprefix`-style git configs, are handled.

**What rig already does, so these checks don't repeat it:**
- **Skipped or focused tests, weakened assertions, deleted snapshots:** rig's test-tamper sensor.
- **Tests that must fail on the base (pass, for a refactor):** rig's red-proof. `frozen-tests` adds the commit order and the freeze, which red-proof can't see: a test rewritten to match a wrong fix can still fail on the base.
- **Paths a change may touch:** the intent's `scope:`.
- **Secrets inside file contents:** rig's secret patterns.

**Settings** live in `.rig/tare.json`. It is read from the merge-base, so a change can't loosen the checks that judge it; change it through its own PR. `chb install --owner` also protects it with CODEOWNERS. An invalid pattern becomes a note, not a crash:

```json
{ "placeholders": { "ignore": ["regex"] }, "deps": { "allow": ["name"] }, "scope": { "stray": ["regex"], "allow": ["^dist/"] } }
```

**Ratchet:** after a check has run advisory for a week without false positives, set its `"blocks": true` (verified on rig: the commit is refused, with the fix line). Once it has been blocking for a week, delete its line from Tare. The plan's gate is Tare at 30 lines or fewer, with the replay pass rate no lower than in phase 1.

**Nightly:** `chb nightly` runs the sensors whose cadence is `nightly`. rig accepts that cadence but never runs it; the Auditor bot calls `chb nightly` at 02:00.

## Tare over time: learning across repos

Phase 3 of the improvement plan. rig already runs the learning loop inside a repo:
- `sdlc.ts learn mine` and `/rig:learn` turn review findings, waivers and your typed corrections that recur in two changes into candidates.
- Each candidate gets the strongest fix that fits (architecture, ratchet, test, rule, lesson). A rule must replay on the changes that earned it, and you apply every change.

What one repo can't see is a mistake that recurs across repos. That is a fact about how agents work for you, so it belongs in Tare. chb reads rig's output rather than running a second loop:

```bash
chb lessons --workspace ~/code --tare skills/tare/SKILL.md --out tare-proposal.md
chb tare status --workspace ~/code
chb tare sync --workspace ~/code --write
chb tare variants --out /tmp/tare-variants
```

What each command does:
- **`chb lessons`** reads every repo's `.rig/lessons.md`, the archive and `.rig/learn/candidates.json`, groups what says the same thing, and writes a proposal for anything seen in two or more repos:
  - **PORT:** a rule one repo already proved (`promoted:<rule>`) goes to the repos that still keep it as prose.
  - **TARE:** a new Tare line, with its evidence for the log.
  - **SEEN:** more evidence for a line Tare already has.
- **`chb tare status`** reports untraced lines (no `log.md` entry), log entries whose line is gone, lines whose check now blocks in every repo (delete them after a week), and repo copies that differ from the canonical Tare.
- **`chb tare sync`** copies the canonical Tare into each repo. Commit those copies by PR.
- **`chb tare variants`** writes one Tare per removed line, plus `arms.json`. Replay them with `--baseline tare-full`, and drop any line whose removal changes no outcome.

`chb lessons` uses no model tokens and writes nothing but the proposal; you decide. The Keeper bot runs it on Fridays (`bots/keeper.md`).

**Why the plan changed:** the plan had agents append lessons to `brain/lessons-proposed.md` for the Keeper to curate. rig's loop already does the per-repo half better: it mines evidence that recurs, proves rules by replay and has a person apply them. Agent-written lessons also scored −1.3 points in SkillsBench. So Tare dropped its "append a proposed lesson" line, and chb adds only the cross-repo half.

## Replay: does rig, or Tare, change outcomes on your work?

Phase 1 of the Masterstock improvement plan: measure before changing anything. `chb replay` reruns your own merged work with the answer hidden, so you find out whether rig and Tare earn their tokens on your tasks rather than on someone's benchmark.

```bash
cd ~/path/to/repo && git fetch origin
chb replay build --repo owner/name --days 120 --test-cmd "npm test -- {hidden}" --setup "npm ci"
#   merged PRs → replay/tasks.json. Start = the merge's parent; hidden = the test files the PR changed.
#   Read every prompt: rewrite any PR description that gives the fix away.
chb replay check                      # keep tasks whose hidden tests fail at the start and pass at the solution
chb replay run --tare .claude/skills/tare/SKILL.md --models sonnet,opus --runs 3 --jobs 4 --budget 3
chb replay report                     # pass rate, run-to-run spread, cost, and each arm vs bare with a 95% interval
```

| Arm | What the agent gets |
| --- | --- |
| `bare` | The start commit with `.rig/`, `.claude/`, `CLAUDE.md` and `AGENTS.md` removed: stock Claude Code |
| `rig` | The start commit as it was, with a prompt to use the rig workflow and no person present |
| `rig+tare` | As `rig`, plus `--tare` copied to `.claude/skills/tare/SKILL.md` and named in the first line of the prompt |

How it keeps the score honest:

- **No history to peek at.** Each run starts from `git archive` of the start commit in a fresh repo with one commit, so the solution is not in `git log`, other branches or the reflog. The default `claude` command disallows `WebFetch` and `WebSearch` and loads project settings only, so your user-level skills and plugins don't leak into the bare arm. `GH_TOKEN` and similar tokens are removed from the agent's environment.
- **Two runs of the same task never overlap**, so no run can find a neighbour's fix in the temp directory. Arms without Tare also get any committed copy of Tare removed.
- **The agent never grades itself.** Scoring happens in a fresh copy of the start:
  - Only the agent's source changes are carried over.
  - Test files, test and build config (`package.json`, lockfiles, `conftest.py`, `pytest.ini`, jest and vitest config, snapshots, `go.mod` and similar) and `.rig/` and `.claude/` are not carried over.
  - Hidden tests, and any config the accepted change edited, come from the solution.
  - Setup runs again, then the tests run.

  An `exit 0` test script, a conftest that skips everything, an edited test, or a tampered `node_modules` all still fail.
- **Only tasks that can tell a fix from no fix.** `check` drops tasks whose hidden tests already pass at the start, fail at the accepted solution, or time out. Rebase-merged PRs replay from before their first commit.
- **Noise is reported, not hidden.** Results are paired by task and bootstrapped. The bootstrap is seeded, so reruns print the same interval.
  - With fewer than 10 paired tasks, the verdict is "too few tasks".
  - An interval that includes 0 is "no detectable difference".
  - If `rig+tare` comes out no better than `bare`, the report prints the plan's kill rule.
- **Infrastructure failures are not scored.** A failed setup, a `claude` that won't start, auth errors and rate limits leave no result. They go to `_infra.log` and are retried on the next run.
- **Resumable.** Finished runs are kept in `replay/results/`, and rerunning skips them. Results for tasks you later mark invalid drop out of the report; `--all` includes them.

Known limits:
- The agent still has shell network access. Run replays on a machine or container without outbound access, apart from the model API, if you want to rule out it fetching the merged PR.
- `~/.claude/CLAUDE.md` may still load. Keep it empty for replay runs, or use a clean user.

Options worth knowing:
- `--arms arms.json` defines your own arms: `name`, `prompt` with `{task}`, `strip`, `tare` (`true` for `--tare`, or a file path), `setup` and `agentCmd`. An agent command receives the prompt on stdin.
- `--gates` records `chb gate crap` and `dry` blocking counts per run.
- `--permission-mode` defaults to `bypassPermissions`, which Claude Code refuses when run as root. Run replays as a normal user on your Mac or bot computer, or pass a different mode.

## Verified on 26 Oct 2026

Against crapper `6fd92c4`, dryer `66ff6d2`, mutator `a5a0cb8`, and a Python repo initialised with rig_v1 `b436071` (`sdlc.ts init --stack python --full`) plus `chb install`:

- The baseline recorded the repo's one legacy function (CRAP 90) and one duplicate pair; legacy findings warn on later changes.
- A new untested branchy function (CRAP 57.3) warned in rig's pre-commit while advisory. With `"blocks": true`, rig refused the commit.
- Splitting and testing it passed the hook. mutator then caught a dead `else` branch that the unit tests could not see, and deleting it cleared the gate.
- An agent adding its own function to the baseline was blocked, and so was a new copy of a duplicated function.
- `chb proof` refused gate results judged at an older commit until they were rerun.
- `chb install` merged the sensors, re-synced rig's CLAUDE.md block, and the commit passed rig's hooks.

An independent review then found twelve ways to get past the gates or the merge policy. All twelve are fixed and have regression tests; the important ones were re-run on real rig: an uncommitted edit, a `--no-run` re-judge, and a code commit made after verify each stop the proof. Two of them had been reproduced: Go and Rust mutation snapshots were never read (mutator nests them in subdirectories), and a repo whose base branch is not main or master passed vacuously.

**Not yet verified**, because this needs your accounts:
- `ledger`, `merge`, `report` and `replay build --repo` against live GitHub. These are tested here with a recording fake `gh`.
- `dispatch --go` starting a real `claude --cloud` session from the Grok Bot computer. This is week 1's gate.
- `replay run` with the default `claude -p` agent. The pipeline is tested end to end with scripted agents on a real git repo: history is hidden, arm preparation and Tare are applied, a test-editing agent is still scored by the restored tests, runs resume, and the report pairs results.

## Findings about rig_v1 worth knowing

- In rig-check's CI job the tools are not installed, so the ub sensors print a skip notice there and defer to the required `ub-gates` check. Locally, and inside ub-gates, a missing tool is a hard failure.
- rig accepts a `nightly` sensor cadence, but `sdlc.ts check` runs only `stop|commit|ship|ci`, so nightly sensors never run. That includes each stack pack's `mutation` sensor. chb puts no sensor on `nightly`; `chb nightly` runs the ones you have, and the Auditor bot calls it.
- rig already owns `.rig/rules.json` (its own rule format) and `/rig:rule`, so chb's checks are `chb tare …`, configured in `.rig/tare.json`.
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
