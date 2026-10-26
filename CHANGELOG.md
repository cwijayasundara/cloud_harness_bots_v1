# Changelog

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
