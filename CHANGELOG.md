# Changelog

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
