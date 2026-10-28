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
| `bin/chb.ts`, `src/` | The CLI: `gate`, `baseline`, `proof`, `ledger`, `merge`, `dispatch`, `report`, `replay`, `tare`, `lessons`, `coordinate`, `nightly`, `tools`, `install`, `upgrade`, `doctor` |
| `skills/policy-craft` | ub-mode adapted to rig's stages, as a rig policy skill (owner + source) |
| `skills/tare` | Tare: CK's engineering preferences (`SKILL.md`) and where each rule came from (`log.md`). This is the canonical copy: `chb tare sync` copies it into repos |
| `skills/verify-app` | Template for proving a change on the running app (pstack's verification-skill idea) |
| `bots/` | Six Grok Bot roles with descriptions, routines and approval rules, plus `setup-computer.sh` |
| `playbook/` | The rules every bot follows (Keeper maintains it) and the postmortem template |
| `templates/ub-gates.yml` | The gates as a PR check, judged with the base branch's code and baseline |
| `templates/chb-coordinate.yml` | The coordinator on GitHub Actions: each session in its own job, pushing as you |
| `templates/chb-ledger.yml` | The PR ledger hourly in GitHub Actions (labels + one issue), opt-in auto-merge: the outer loop without Grok Bot |
| `pilot/` | The dry run: rig's sample sprint through the whole chain, scripted, for $0 |
| `test/` | `node --test` suites; see [Development](#development) |
| `ROLLOUT.md` | 30 days, four weekly gates you can check |
| `CHANGELOG.md` | What changed in each release (currently 0.6.0) |

## Quick start

```bash
npm install -g --install-links github:cwijayasundara/cloud_harness_bots_v1   # or: git clone … && npm ci && npm link
chb tools install                     # crapper, dryer, mutator → ~/.ub-tools (siblings, as mutator needs)
chb doctor                            # machine check; every ✗ prints its fix

cd ~/path/to/rig-repo                 # a repo where /rig:init has run
chb install . --owner @you --ci --ledger --ub-mode
node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts baseline write --skip mutate
chb doctor                            # repo check: all ✓
git switch -c chore/ub-gates && git add -A && git commit -m "chore: Uncle Bob gates via chb"   # rig's hooks run here
git push -u origin chore/ub-gates     # open the PR; a code owner approves (sensors.json and .claude/ are protected)
```

`--install-links` matters: without it, npm 11 links a global install of a git package to a temporary clone it then deletes, and `chb` is a dangling link. For agents that build overnight, follow [Step by step: your first overnight run](#step-by-step-your-first-overnight-run). Then see [ROLLOUT.md](ROLLOUT.md) and [bots/README.md](bots/README.md). To try it first without touching a real repo, see [Testing it by hand](#testing-it-by-hand). Later releases: `npm uninstall -g cloud-harness-bots` (npm 10 can't install over an installed copy), the same `npm install -g --install-links …` again, then `chb upgrade <repo>`, which refreshes only the vendored CLI.

## Step by step: your first overnight run

From nothing to PRs that agents built while you slept, on GitHub Actions (no Grok Bot). Each step ends with a check: don't go on until it passes.

**1. Your Mac (once).**
```bash
npm install -g --install-links github:cwijayasundara/cloud_harness_bots_v1
chb tools install
chb doctor                     # machine: every line ✓ (node 22.18+, git, python3 with venv, the three tools, gh logged in, claude)
```

**2. Your project repo, with rig vendored.** Cloud sessions and Actions runners clone the repo and can't see your local rig plugin, so rig must live in the repo.
```bash
cd ~/code/myproject            # on GitHub, with at least one commit on main
claude --plugin-dir ~/path/to/rig_v1      # then type /rig:init; commit .rig/, .claude/, CLAUDE.md and push
```
Check: `ls .rig/bin/sdlc.ts .claude/skills` shows both, and they are on GitHub's main.

**3. chb in the repo.** It goes in through a PR, because rig protects `.rig/sensors.json` and `.claude/`.
```bash
chb install . --owner @you --ci --ledger --coordinate --schedule night
node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts baseline write --skip mutate
chb doctor --repo-dir .        # repo: all ✓
git switch -c chore/chb && git add -A && git commit -m "chore: chb gates and coordinator" && git push -u origin chore/chb
```
Open the PR and merge it. Check: `.github/workflows/chb-coordinate.yml` is on main.

**4. GitHub settings** (repo → Settings → Secrets and variables → Actions).

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `CHB_GH_TOKEN` | A fine-grained token for this repo: Contents, Pull requests, Issues, Checks read/write |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | Output of `claude setup-token` on your Mac |
| Variable | `CHB_COORDINATE` | `on` |
| Variable | `CHB_SESSION_BUDGET_USD` | Optional; default `10` per session |

Check: Actions is enabled for the repo (Settings → Actions → General).

**5. Let rig start work** (in a Claude Code session in the repo; only you can type these):
```
/rig:autonomy set 2 --why "overnight builds"
```
Commit and push `.rig/autonomy.json`. Rung 1 starts plans only; rung 2 also starts builds.

**6. Give it work: a sprint.** The coordinator starts only intents that `node .rig/bin/sdlc.ts ready` lists, which means intents from an **approved sprint chart**. A one-off task in chat is not picked up.
1. Write the sprint's PRD, as rig's README describes, then run `/rig:chart 1` (and `/rig:testplan 1`).
2. Give each intent a `scope:` in its frontmatter, the files it writes (for example `scope: [src/cart/**]`). Without one, an intent only runs when nothing else is in flight.
3. Run `/rig:approve chart-1`, and merge the chart branch to main.

Check: `node .rig/bin/sdlc.ts ready` lists intents, and `chb coordinate --repo-dir .` (a dry run) prints `start plan …` lines.

**7. First run, by hand.** Actions → chb-coordinate → Run workflow. The `choose` job's summary shows what starts and what waits, with the reason. Each pick runs as its own `session` job, and plan sessions push `sdlc/<slug>` branches.

**8. The daily loop.**
- **Evening:** for each `sdlc/<slug>` branch, read spec.md and plan.md, answer anything under `## Open questions`, then `/rig:approve <slug>` and push.
- **Night:** builds run hourly from 21:23 to 06:23 UTC. Each one builds, tests, opens the PR and commits `proof.json`.
- **Morning:** PRs carry `chb:ready`, `chb:blocked` or `chb:working` labels. You merge.

To skip the evening approvals for low-risk changes, see [Tier-0 auto-build](#tier-0-auto-build-unattended-up-to-the-pr).

**When it doesn't start, read the `choose` job's summary first.** Every waiting intent says why:

| You see | Do |
| --- | --- |
| `0 ready` | No approved sprint chart on main, or every intent has started (step 6) |
| `rung 0: a person starts each intent` | Step 5 isn't on main |
| `approved, but rung 1` | Builds need rung 2 |
| `its approval is stale` | spec.md or plan.md changed after `/rig:approve`; approve again |
| `2 build session(s) already: it needs a person` | Read the last session's `CHB-RESULT` line and `proof.json` reasons, fix the brief or the code, then start one more build from your Mac: `chb dispatch build <slug> --repo-dir . --go --force` |
| The `choose` job is skipped | `CHB_COORDINATE` isn't `on` |
| A session fails at `claude` | `CLAUDE_CODE_OAUTH_TOKEN` is missing or expired: run `claude setup-token` again |
| A push fails | `CHB_GH_TOKEN` lacks Contents write on this repo |

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

## Your team of agents: the pilot, then GitHub Actions

**1. Watch it work for free.** The pilot runs rig's own sample sprint through the whole chain in a sandbox with a local origin. It takes about a minute:

```bash
git clone https://github.com/cwijayasundara/rig_v1 /tmp/rig_v1
node pilot/dry-run.mjs --rig /tmp/rig_v1
```

The sprint has three intents, each given a `scope:`: `stock-model`, then `stock-endpoint` and `cart-stock-limit`, which both depend on it. Every hour:
- `chb coordinate` chooses what starts.
- The sessions it chose run side by side. A scripted stand-in for Claude makes the branch, plan, code, tests and proof; it is not a model.
- The pilot plays you, and labels each step as yours: it approves the plans that wait and merges builds whose proof passes.

What it shows, against rig's real readiness, approvals and commit hooks:
- `stock-model` runs first and alone.
- Its two dependants are planned side by side, then built side by side.
- All three ship, and every commit is yours.

CI runs the pilot on every push against rig's latest main.

**2. Run the team for real on GitHub Actions** (no Grok Bot needed). `chb install . --coordinate` adds `.github/workflows/chb-coordinate.yml`. Every hour it is scheduled to run, one job runs `chb coordinate --go --emit`, and each pick then runs as its own job on its own runner, so four picks means four agents at once. To switch it on:

| Setting | What |
| --- | --- |
| Secret `CHB_GH_TOKEN` | A fine-grained token of your own account (cwijayasundara) for this repo, with Contents, Pull requests, Issues and Checks read/write. Sessions push with it, so the pushes are yours and they trigger CI. |
| Secret `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` on your Mac |
| Variable `CHB_COORDINATE` | `on` to start; delete it to stop |
| Variables `CHB_WIP`, `CHB_SESSION_BUDGET_USD` | Changes in flight (default 4) and the budget per session in dollars (default 10) |
| Variables `CHB_GIT_NAME`, `CHB_GIT_EMAIL` | The commit identity sessions use. The default is yours: Chaminda Wijayasundara, cwijayasundara@gmail.com |

**When it runs** is set by `--schedule` (UTC, as GitHub's cron is). Rerunning `chb install . --schedule <when>` rewrites only the cron line of an installed workflow:

| `--schedule` | Runs | For |
| --- | --- | --- |
| `day` (the default) | hourly on weekdays, 07:23–21:23 UTC | sessions while you can answer them |
| `night` | hourly every night, 21:23–06:23 UTC | approve plans in the evening, wake up to PRs |
| `always` | hourly, around the clock | |
| `"<cron>"` | any 5-field cron, e.g. `"23 22-23,0-5 * * 1-5"` | |

rig still decides what may start: nothing starts at rung 0, builds need rung 2, and every plan stops for your approval, unless it is a [tier-0 auto-build](#tier-0-auto-build-unattended-up-to-the-pr). The dispatch log (session counts, plans still being written) is kept in the Actions cache between runs. If the cache is evicted after a week of no runs, the counts start again from zero.

## Coordinate: many sessions, one writer per file

Phase 4 of the improvement plan. rig decides what may start:
- `sdlc.ts ready` lists intents whose sprint chart is approved and whose dependencies have shipped.
- `.rig/autonomy.json` says whether the model may start work at all (rung 0: a person starts each intent) and what is deferred.
- rig's own queue keeps one writer per file across local worktrees.

Cloud sessions make no local worktrees: each pushes an `sdlc/<slug>` branch, so `chb coordinate` reads in-flight work from the remote instead.

```bash
chb coordinate --repo-dir ~/code/shop            # dry run: what is in flight, what would start, what waits and why
chb coordinate --repo-dir ~/code/shop --go       # start them (cloud sessions; --local for claude -p here)
chb coordinate --go --emit jobs.json             # record them and write a job list for a runner (the Actions workflow)
```

- **What rig decides, read the way rig reads it:**
  - **Ready:** `sdlc.ts ready`, run in a temporary worktree of the base branch, so a stale checkout never re-plans shipped work.
  - **Rung:** rung 0 starts nothing, rung 1 starts plans (it stops at approval), and rung 2 and above also start builds, because a build session opens the PR. A malformed rung reads as 0.
  - **Approved:** `approval.json`'s hashes match the branch's spec, plan and requirements. A stale approval waits for a person.
  - **Shipped:** the base has the change's `pr.md`, or the branch is merged by any method, including squash and rebase.
- **In flight:** every unshipped `origin/sdlc/*` branch claims its intent's `scope:` and `touches:`, its spec's `## Blast radius`, its plan's `## Files` and its actual diff. A plan dispatched in the last 6 hours whose branch hasn't appeared yet holds its intent's scope. A plain path also claims the folder under it, as in rig's scope rule.
- **Starts:**
  - Builds first, then ready intents in rig's order (sprint, deferred last) whose writes overlap nothing claimed, until the work-in-progress limit (`--wip`, default 4) is reached.
  - Each change gets at most two build sessions and two plan sessions (`CHB_MAX_BUILDS`, `CHB_MAX_PLANS`).
  - No second build starts while one dispatched after the branch's last commit may still be running.
- **Waits, each with its reason:**
  - A claimed file, with the change that holds it.
  - No `scope:`: it starts only when nothing else is in flight.
  - The WIP limit, the rung, a stale approval, or a used-up session cap.
- **Safety:** one run at a time per repo (a lock file). `--go` refuses to act if `git fetch` failed. A base that resolves to a change branch is replaced by `origin/main`.
- **Not judged:** tests, fixtures and repo-root config (`package.json`, lockfiles) that two changes may both edit. rig's merge checks catch those.

The Smith bot runs it hourly (`bots/smith.md`). The rest of phase 4 uses what is already here:
- **Model-upgrade drill:** `chb replay run --arm rig,rig+tare --models <new>`, then retire the Tare lines the new model passes without help.
- **Monthly clean-up:** `chb tare status`, run by the Keeper.
- **Path-scoped judgment:** Claude Code's own path-scoped rules (see its memory docs), written per repo.

## Tier-0 auto-build: unattended up to the PR

rig has two human gates: the sprint chart approval (once a sprint) and `/rig:approve` on every change. The second one means each change waits for you between plan and build. A model never approves, and chb never writes `approval.json` or sets `SDLC_HUMAN`. Instead you can let low-risk changes skip the per-change gate. **Two switches, both yours:**

1. **Turn rig's plan gate off** on the default branch: `"gates": {"plan": false}` in `.rig/sensors.json`. It is a protected file, so this goes through a reviewed PR. chb reads it from the base, so a change can't turn it off for itself.
2. **Set `CHB_AUTO_BUILD=tier0`**: a repository variable for the Actions coordinator, or an environment variable for `chb coordinate` and `chb dispatch`.

Then `chb coordinate` builds a planned change that has no approval **only when all of these hold**. Anything else waits for `/rig:approve` and says why:

| Check | What a person or rig would otherwise catch |
| --- | --- |
| spec.md and plan.md exist, with nothing under `## Open questions` in either | rig's `approve` refuses open questions, and only a person closes one |
| spec.md has a `## Blast radius`, and every plan.md `## Files` path is inside it | rig's `approve` refuses a plan outside the blast radius |
| plan.md lists no `## Contracts` | a one-way door (rig tier 1) |
| rig's `sdlc.ts weight <slug>` says `light` | an always-human path or access action in the blast radius, or an intent that asked for full planning (rig tier 2) |
| the branch changed only its own change folder and files inside the blast radius, and nothing under `.rig/`, `.claude/`, `.github/`, `CLAUDE.md`, `AGENTS.md` or `CODEOWNERS` | a plan that already reached past its scope |

- **Checked twice.** `chb dispatch build` judges the change again before it starts the session, so a hand-run or a stale Actions job can't skip the check.
- **The build stays inside the plan.** The build session is told there is no approval by design, and to build only plan.md's files. If it needs anything that would have needed you, it stops with `status=needs-human`.
- **The rest is unchanged.** Rung 2, the build caps, rig's sensors, the gates, `proof.json` and `rig-check` on the PR all apply as before. Signals that exist only after the build, such as diff size and review findings, show up as the PR's rig risk tier.
- **A person still sees every auto-built change.** `chb merge` never auto-merges a PR without `.rig/changes/<slug>/approval.json`, so a change no person approved is always merged by you.
- **Try it for free:** `node pilot/dry-run.mjs --rig /tmp/rig_v1 --auto` runs the sample sprint this way: three plans, no approvals, three passing proofs.

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
- rig has no S/M/L tiers any more, so auto-merge is limited to small `chore` and `refactor` changes (≤ 150 lines, nothing protected, rig-check and ub-gates green, and a person approved the plan). Tune it with `CHB_AUTOMERGE_TYPES`, `CHB_AUTOMERGE_MAX_LINES` and `CHB_REQUIRED_CHECKS`.

## Environment variables

| Variable | Default | Used by |
| --- | --- | --- |
| `UB_TOOLS_DIR` | `~/.ub-tools` | gates, tools |
| `CHB_BASE` | the PR's base in Actions (`GITHUB_BASE_REF`), then `origin/HEAD`, `origin/main`, `main`, `origin/master`, `master` | gates, tare checks, proof |
| `CHB_REQUIRED_GATES` | `crap,dry` | proof (add `mutate` in week 4) |
| `CHB_ALLOW_BASELINE_LOOSEN` | unset | gates (a person sets it) |
| `CHB_TOOL_TIMEOUT_MS` | 1800000 | gates |
| `CHB_AUTOMERGE_TYPES`, `CHB_AUTOMERGE_MAX_LINES`, `CHB_REQUIRED_CHECKS` | `chore,refactor`, 150, `rig-check,ub-gates` | merge |
| `CHB_AUTO_BUILD` | unset (off) | `tier0`: build unapproved tier-0 changes when rig's plan gate is off (coordinate, dispatch build) |
| `CHB_HOME`, `CHB_TZ` | `~/.chb`, `Europe/London` | dispatch log (dispatch, coordinate), report |
| `CHB_MAX_BUILDS`, `CHB_MAX_PLANS` | 2, 2 | build and plan sessions per change (dispatch, coordinate) |
| `CHB_CLAUDE_ARGS` | unset | extra `claude` flags for `--local` sessions only (the coordinate workflow sets permission mode and budget) |
| `CHB_AUDIT_MUTATE` | unset | dispatch audit |
| `CHB_E2E`, `CHB_PILOT_RIG` | unset | tests: `1` runs the real-tools e2e; a rig_v1 checkout runs the pilot test |

## Development

```bash
npm ci
npm run typecheck && npm test                    # unit and integration suites; e2e and pilot skip unless enabled
CHB_E2E=1 npm test                               # also the real-tools e2e (needs chb tools install)
CHB_PILOT_RIG=/tmp/rig_v1 npm test               # also the pilot, against a rig_v1 checkout
npm run chb -- help                              # run the CLI from the checkout
```

CI (`.github/workflows/ci.yml`) runs typecheck and tests on Node 22.18 and 24, packs and installs the CLI globally, parses the workflow templates, runs the e2e with the tools pinned at the commits above, and runs the pilot against rig's latest main. Each release is listed in [CHANGELOG.md](CHANGELOG.md).

## Testing it by hand

**Prerequisites:**

| Need | For | Check |
| --- | --- | --- |
| Node 22.18+, git | everything | `chb doctor` |
| Python 3 with `venv`, and PyPI access the first time | Uncle Bob's tools (each builds its own `.venv`) | `chb doctor` |
| crapper, dryer, mutator | gates, baseline, proof | `chb tools install`, then `chb tools status` |
| A rig_v1 checkout | the pilot and a scratch rig repo | `git clone https://github.com/cwijayasundara/rig_v1 /tmp/rig_v1` |
| `gh`, authenticated | ledger, merge, report, replay build | `gh auth status` |
| `claude` CLI, logged in | dispatch, coordinate, replay run | `claude --version` |
| A scratch GitHub repo | the GitHub and Actions tiers | |

Work through the tiers in order: each costs more than the one before. Commands that start sessions or change GitHub do nothing without `--go`, so run each without it first and read what it would do.

1. **Suites (free).** `npm ci && npm run typecheck && npm test`. The e2e and pilot skip unless enabled.
2. **Pilot (free, about a minute).** `node pilot/dry-run.mjs --rig /tmp/rig_v1`. Expect `stock-model` alone first, its two dependants planned and built side by side, and all three shipped. Add `--auto` for the same sprint as tier-0 auto-builds, with no approvals.
3. **Real tools (free).** `chb tools install`, `chb doctor` (machine all ✓), then `CHB_E2E=1 npm test`.
4. **Gates in a scratch rig repo (free).** Make a small Python repo with a `main` branch and a local bare origin. Run `node /tmp/rig_v1/scripts/sdlc.ts init --stack python --full`, `chb install . --owner @you --ci --ledger` and `chb baseline write --skip mutate`, and commit. Then, on a branch:

   | Do | Run | Expect |
   | --- | --- | --- |
   | Add an untested branchy function | `chb gate crap` | BLOCK with a `fix:` line, exit 1 |
   | Copy an existing function | `chb gate dry` | BLOCK |
   | Add that function to `.rig/ub-baseline.json` | `chb baseline check` | BLOCK (baseline loosened) |
   | Add a TODO or `raise NotImplementedError` | `chb tare placeholders` | BLOCK |
   | Stage a `.env` file | `chb tare scope` | BLOCK |
   | Add a dependency the intent doesn't name | `chb tare deps` | BLOCK |
   | Run the gates, then commit more code | `chb proof` | refused as stale |
   | Split and test the function | `chb gate crap` | passes, last line `0` |

5. **GitHub (free, scratch repo).** Open a few PRs, then `chb ledger --repo you/scratch` (add `--labels` once it looks right), `chb merge <pr> --repo you/scratch` without `--go`, and `chb report --days 7 --repo you/scratch`. These are the commands tested here only with a fake `gh`.
6. **Real sessions (costs model tokens).** `chb dispatch plan "chore: something tiny" --repo-dir <scratch> --local --go`, then without `--local` for `claude --cloud`, then `chb coordinate --repo-dir <scratch>` and `--go`.
7. **Actions (costs model tokens).** `chb install . --coordinate --schedule night`, add the secrets and variables in [the table above](#your-team-of-agents-the-pilot-then-github-actions), and run the workflows from the Actions tab.

## Credits and licences

Uncle Bob's [crapper](https://github.com/unclebob/crapper), [dryer](https://github.com/unclebob/dryer) and [mutator](https://github.com/unclebob/mutator) (0BSD) are cloned at install time, not bundled. [ub-mode](https://github.com/unclebob/ub-mode) has no licence file, so it is fetched to your user skills, and `policy-craft` restates its rules in new words. Ideas from [poteto's pstack](https://github.com/cursor/plugins/tree/main/pstack) and the [Grok Bot engineering guide](https://x.ai/bot/guides/grok-bot-for-engineering). This package: MIT.
