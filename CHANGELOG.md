# Changelog

## Unreleased

**Fixes that stopped a first run:**
- **Global install:** `npm install -g github:…` failed, because npm builds a global git install without its dev dependencies, so `tsc` was missing. The build is now `scripts/build.mjs`, which uses Node's own type stripping and needs no dependencies; `tsc` still type-checks. Install with `--install-links`, or npm 11 links the global install to a temporary clone it deletes. To upgrade, `npm uninstall -g cloud-harness-bots` first, because npm 10 fails over an installed copy with `ENOTEMPTY`. CI now installs every pushed commit this way.
- **Builds on Actions could never pass their proof.** The coordinator's session job had no crapper, dryer or mutator, so the gates skipped and `chb proof` reported them as not run. Build sessions now install the pinned tools (and Python 3.12). Rerun `chb install . --coordinate --force` to pick this up.
- README: "Step by step: your first overnight run", with a check after each step and what each "wait" reason means.

**Tier-0 auto-build** (`CHB_AUTO_BUILD=tier0`, `src/autobuild.ts`): fully unattended up to the PR, for low-risk changes. It applies only when you have also turned rig's plan gate off (`"gates": {"plan": false}`, read from the base). A planned change with no approval is then built when it has no open questions, its plan stays inside the spec's blast radius, it lists no contracts, rig's `weight` says light, and its branch touched nothing else and no harness file. Everything else still waits for `/rig:approve`, with the reason.
- `chb dispatch build` judges the change again before starting the session, and the build prompt keeps the session inside the plan.
- **`chb merge` now needs a person's approval to auto-merge:** a PR without `.rig/changes/<slug>/approval.json` is left to a person. The slug comes from the PR's branch, not the agent-written `proof.json`.
- `pilot/dry-run.mjs --auto` runs the sample sprint this way, and CI runs it too. The workflow template passes `CHB_AUTO_BUILD` and the base branch to its jobs.
- `fmList`, `sectionPaths` and `approvalOf` moved to `src/rig.ts`; `coordinate.ts` re-exports them.

**`chb install --schedule day|night|always|"<cron>"`** sets when the coordinator runs. `night` (hourly, 21:23–06:23 UTC) is for agents that build while you sleep. Rerunning it on an installed `chb-coordinate.yml` rewrites only the cron line. `chb help` now lists `--coordinate` too.

**Pilot fixes:**
- rig (since `aa1e72f`) commits approvals itself, so the pilot now commits only what is left.
- Its scripted sessions no longer set upstream tracking. Two of them side by side in one repo raced on `.git/config`'s lock and failed now and then. Real sessions never share a clone.

**Fix:** `templates/ub-gates.yml` and CI set `UB_TOOLS_DIR` in a step, not the job's `env`. GitHub rejects the `runner` context there, so the whole workflow failed to start. Repos that ran `chb install --ci` on 0.6.0 or earlier should rerun it, or apply the same change to `.github/workflows/ub-gates.yml`.

## 0.6.0 · 2026-10-27

**A team of agents on GitHub Actions** (`templates/chb-coordinate.yml`, `chb install --coordinate`): runs hourly on weekdays.
- One job chooses with `chb coordinate --go --emit`. Each pick runs as its own job with `chb dispatch … --local --go --no-log`, so four picks run as four agents in parallel.
- Sessions push with your own token and commit as you. The dispatch log persists in the Actions cache. It is off until the `CHB_COORDINATE=on` variable is set.
- `chb coordinate --emit <file>` records the picks and writes the job list instead of starting sessions.
- `chb dispatch --no-log` skips recording, for a dispatch the coordinator already recorded.
- `CHB_CLAUDE_ARGS` passes extra flags (permission mode, budget) to local sessions only.

**Pilot** (`pilot/dry-run.mjs`): rig's sample sprint through the whole chain in a sandbox, with a scripted stand-in for Claude and the pilot playing you, at no cost.
- Against rig's latest code, `stock-model` runs first; its two dependants are planned, then built, side by side; all three ship; every commit is yours.
- It runs in CI on every push, and as a test when `CHB_PILOT_RIG` is set.

## 0.5.0 · 2026-10-27

**Coordinate** (`chb coordinate`): phase 4 of the Masterstock improvement plan. It runs one repo's queue across cloud sessions, with one writer per file, under a work-in-progress limit.
- **Ready work:** reads rig's `sdlc.ts ready` on the base branch through a temporary worktree.
- **In flight:** reads from `origin/sdlc/*`. Claims are the intent's scope and touches, the spec's blast radius, the plan's files and the diff. Recently dispatched plans hold their scope too.
- **rig's rules:** rung 1 starts plans and rung 2 also starts builds. Approval hashes must match. A change counts as shipped when the base has its `pr.md` or the branch is merged by any method, squash and rebase included.
- **Session limits:** at most two build and two plan sessions per change, and no second build while one may still be running.
- **Safety:** one run at a time per repo, no `--go` after a failed fetch, and the base is never a change branch.
- The Smith bot runs it hourly.
- An independent review found 11 problems: duplicate builds, re-planned shipped work, squash-merged branches that looked in flight forever, a change branch taken as the base, plan loops on closed PRs, stale approvals, builds started below rung 2, and overlap misses. All are fixed, each with a regression test.

**Authorship:** every commit and tag is by Chaminda Wijayasundara <cwijayasundara@gmail.com>.

## 0.4.0 · 2026-10-27

**Tare over time**: phase 3 of the Masterstock improvement plan, built on rig's learning loop rather than beside it.
- `chb lessons` reads rig's lessons and candidates across repos. Anything seen in two or more repos is proposed as a rule to port, a Tare line, or more evidence for an existing line. It uses no tokens and writes only a proposal.
- `skills/tare/log.md` records where each Tare rule came from and which check enforces it.
- `chb tare status` reports untraced lines, stale log entries, lines a blocking check has made removable, and repo copies that differ.
- `chb tare sync` makes each repo's Tare the canonical one.
- `chb tare variants` writes Tare minus one line each, with replay arms. Replay arms now take a Tare file path.
- Tare v1.1 drops "append a proposed lesson": rig's loop mines lessons from recurring evidence, and agent-written lessons didn't help in SkillsBench.
- The Keeper bot gains a Friday LESSONS routine.

## 0.3.0 · 2026-10-27

**Tare checks** (`chb tare placeholders | frozen-tests | deps | scope | all`): phase 2 of the Masterstock improvement plan. Tare's machine-checkable lines become checks.
- `install` adds them as advisory `tare-*` sensors at commit cadence. On an existing repo, run `chb install .` again to add them; your other sensors are kept.
- Each finding has a `fix:` line, and the last output line is the count.
- They judge the tree being committed (the index against the merge-base), so unstaged and untracked work is ignored. Settings are read from the merge-base, so a change can't loosen its own checks.
- In CI the change is found from the PR branch. With no base or on a first commit they say "not judged" instead of crashing.
- Paths with spaces, non-ASCII names and `diff.noprefix` configs are handled.
- Settings live in `.rig/tare.json`, which is protected with CODEOWNERS.
- They leave alone what rig already does: test tampering, red-proof, intent scope, and secrets in file contents.
- Verified on rig: advisory checks warn. With `blocks: true`, rig refuses the commit and passes it once the problem is fixed.

**Bounded loops and a fresh reviewer**
- The build prompt allows two fix-up rounds, then reports `status=needs-human`.
- `chb dispatch build` refuses a third session for the same change unless `--force`.
- `chb dispatch review <slug>` starts a reviewer session that didn't write the change. Run locally, it has no edit tools.

**Gates:** every blocking finding now ends with a `fix:` instruction.

**`chb nightly`** runs the `nightly` sensors that rig never runs, the way rig would: disabled sensors are skipped, `knownRed` sensors only warn, and `{files}` means the whole tree. The Auditor bot calls it.

**Base branch:** gates and checks use `GITHUB_BASE_REF` in pull requests when `CHB_BASE` isn't set.

## 0.2.0 · 2026-10-27

**Replay** (`chb replay build | check | run | report`): phase 1 of the Masterstock improvement plan.
- `build` turns merged PRs (REST) or local commits into tasks. The start is the merge's parent, the hidden set is the test files the change touched, and edited prompts and check results survive a rebuild. Changes with no tests, only tests, or more than `--max-lines` changed lines are skipped, with the reason given.
- `check` keeps a task only if its hidden tests fail at the start and pass at the accepted solution.
- `run` runs each task × arm × model × run in a history-free snapshot. Arms are bare, rig and rig+tare, or your own `--arms` file. Hidden tests are restored over the agent's work before scoring. It records cost, turns, tokens, time and diff size, and optionally gate counts. Runs execute in parallel with `--jobs` and can be resumed.
- `report` gives pass rate with run-to-run spread, and a paired, seeded bootstrap of each arm against a baseline, with the kill rule.
- Scoring happens in a fresh copy of the start, with only the agent's source changes. Tests, test and build config, snapshots and harness folders come from the start or the accepted solution.
- No two runs of the same task overlap, tokens are removed from the agent's environment, and user-level Claude settings are not loaded.
- Infrastructure failures (setup, auth, rate limits, a missing `claude`) are logged and retried, never scored. Background processes left by an agent are killed when it exits. Ctrl-C stops running agents.
- Verdicts need at least 10 paired tasks. Rebase-merged PRs start before their first commit.

**Tare**
- `skills/tare` ships the evidence-checked v1, and `chb install` writes it if the repo has none.
- `chb dispatch` starts every prompt by naming Tare when the repo has it, rather than leaving it to auto-triggering.

## 0.1.0 · 2026-10-26

First release.

**Gates** (`chb gate crap|dry|mutate`, `chb baseline`)
- Wraps Uncle Bob's crapper, dryer and mutator. Each finding is judged against `.rig/ub-baseline.json`: new or worsened debt blocks, and legacy debt warns. The last output line is one number, so a rig sensor can use it as a ratchet.
- "Changed" means changed since the merge-base. The tools' own `--changed` reads `git status`, which is empty once work is committed.
- Gates fail with exit 2 when there is no base branch or merge-base, instead of passing vacuously.
- Explicit file lists, so whole-tree runs never score `.venv`, build output or vendored code.
- The baseline loosening check compares against the merge-base.
- Mutation snapshots are read recursively, which covers Go and Rust namespaces.

**Proof** (`chb proof`)
- `.rig/changes/<slug>/proof.json` brings together rig's `verify.json`, checked against rig's tree stamp, the gate results, the review verdict and the diff size.
- A gate result counts only if it came from a full default run on committed code. Results from `--no-run`, raised thresholds, `--no-coverage`, unscored functions or a dirty tree are refused.

**Outer loop** (`chb ledger | merge | dispatch | report`)
- Repo-scoped GitHub REST only, so it works where GraphQL is blocked (Claude Code cloud sessions).
- The ledger sorts PRs into working, blocked and ready from facts only and moves `chb:*` labels. A proof counts as current only if nothing but `proof.json` was committed after it.
- Merge policy: small chores and refactors only. It requires rig-check and ub-gates green, uses a paginated file list that includes rename sources, and merges only if the head SHA is unchanged.
- Dispatch runs plan, build and audit sessions with `claude --cloud`. Plans stop at rig's human gate.

**Setup**
- `chb install`: vendors the CLI into `.rig/ub`, adds three sensors, two skills, `.gitignore` entries and CODEOWNERS lines, and with `--ci` and `--ledger` the two workflows. It then runs `rig sync`. `--force` keeps the repo's `blocks`, cadence and timeouts, and edited skills are never overwritten.
- `chb upgrade` refreshes only the vendored CLI.
- `chb doctor` checks the machine and the repo, with a fix for each failure.
- `chb tools install --pin …` installs the tools.
- Installable with npm: `dist/` is built on install, because Node will not strip types under `node_modules`.

**Bots**: Foreman, Scribe, Smith, Auditor, Keeper and Scout for Grok Bot, plus `setup-computer.sh`, the playbook, the postmortem template and a 30-day rollout.

**Workflows**
- `ub-gates`: one job per gate on fresh runners, using the base branch's gate code and baseline, pinned tools and SHA-pinned actions.
- `chb-ledger`: an hourly ledger with an issue and labels, and auto-merge as an opt-in, write-scoped job.
