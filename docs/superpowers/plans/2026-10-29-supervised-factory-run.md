# Supervised Factory Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take rig's sample sprint from an approved chart to three merged PRs on a private GitHub sandbox repo, with real Claude sessions started by chb on GitHub Actions, while CK watches every step.

**Architecture:** A new private repo, `cwijayasundara/chb-factory-sandbox`, holds rig's real shop app, onboarded with `/rig:init` and `chb install`, plus rig's sample sprint chart. CK starts `chb-coordinate` and `chb-ledger` by hand, approves each plan and merges each PR. Nothing is built in chb itself; this plan is setup and one observed run.

**Tech Stack:** GitHub (private repo, Actions, `gh`), Node 22.18+, Python 3 (UB tools), Claude Code with rig (`~/Documents/learning_101/rig_v1`), chb (this repo).

**Spec:** `FACTORY.md` (this repo)

## Global Constraints

- Repo: `cwijayasundara/chb-factory-sandbox`, **private**.
- Throttle: `CHB_WIP=2`, `CHB_SESSION_BUDGET_USD=5`, autonomy rung 2. No `CHB_AUTO_BUILD`, no `CHB_AUTOMERGE`.
- `chb install` schedule: `day`. `CHB_COORDINATE=on` only while CK is at the desk; deleted at the end.
- Human-only steps are marked **[CK]**: creating the GitHub token, setting the two secrets, `/rig:init` (an interactive session), `/rig:autonomy`, every `/rig:approve`, every merge. Claude never runs these, never writes `approval.json`, never sets `SDLC_HUMAN`.
- Steps marked **[Claude]** may be run by the agent executing this plan. Creating the GitHub repo is outward-facing: confirm with CK first.
- Seed code: `rig_v1/tests/e2e/fixtures/shop`. Sprint: `rig_v1/tests/e2e/prd/chart-fixture`. Intent scopes: `stock-model` → `src/catalog/**`, `stock-endpoint` → `src/http/**`, `cart-stock-limit` → `src/cart/**`.
- Every failure found becomes a ticket on chb (an issue on `cwijayasundara/cloud_harness_bots_v1`) before any new task is added to the factory.

Shell shorthands used below:

```bash
RIG=~/Documents/learning_101/rig_v1
SBX=~/code/chb-factory-sandbox
REPO=cwijayasundara/chb-factory-sandbox
SDLC="node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts"
```

## Review Focus

- **Claude usage cap reached mid-run** (two sessions side by side on a subscription): the session job fails or ends without a `CHB-RESULT` line, and the next `choose` summary still explains what waits. Checked in Task 7, step 4.
- **A plan session leaves `## Open questions`:** CK must close them before `/rig:approve`, or rig refuses the approval. Checked in Task 7, step 1.
- **A fixture intent doesn't fit the real shop app** (a plan's `## Files` lists a path outside its scope, e.g. `src/server.js` for `stock-endpoint`): approval is refused for the blast radius. The fix goes in the sandbox's intent, not in chb. Checked in Task 7, steps 1 and 3.
- **The push token is wrong or expired:** the session fails at `git push` and the branch never appears. Checked in Task 5 (verification) and Task 7, step 1.
- **A build uses both of its sessions without a passing proof:** `choose` says `2 build session(s) already: it needs a person`, and CK follows FACTORY.md's `build` re-entry. Checked in Task 7, step 2.

---

### Task 0: Record the design in chb

**Files:**
- Add: `FACTORY.md`, `docs/superpowers/plans/2026-10-29-supervised-factory-run.md`
- Modify: `README.md` (one row in *What is in the box* pointing to `FACTORY.md`)

- [ ] **Step 1 [Claude]:** Add a `| FACTORY.md | The factory design in Matt Pocock's software-factory language, and the supervised first run |` row to README's *What is in the box* table.
- [ ] **Step 2 [Claude]:** `npm test` in this repo. Expected: all suites pass (docs-only change).
- [ ] **Step 3 [Claude]:** Commit on a branch `docs/factory`, open a PR. **[CK]** merges it.

### Task 1: Prepare CK's Mac

- [ ] **Step 1 [Claude]:** From this repo: `npm ci && npm link`. Expected: `which chb` prints a path.
- [ ] **Step 2 [Claude]:** `chb tools install`. Expected: crapper, dryer, mutator under `~/.ub-tools`.
- [ ] **Step 3 [Claude]:** `chb doctor`. Expected: every machine line ✓ (node 22.18+, git, python3 with venv, the three tools, `gh` logged in, `claude`). Fix each ✗ with the line it prints before going on.

### Task 2: Create the sandbox repo with the shop app

**Files (in `$SBX`):**
- Create: `src/**`, `test/shop.test.js`, `api/openapi.yaml`, `contracts/examples/*.json` (copied from `$RIG/tests/e2e/fixtures/shop`)
- Create: `package.json`: `{"name":"chb-factory-sandbox","private":true,"type":"module","scripts":{"test":"node --test","start":"node src/server.js"}}`
- Create: `.gitignore`: `node_modules/`, `.env`

- [ ] **Step 1 [Claude]:** `mkdir -p $SBX && cp -R $RIG/tests/e2e/fixtures/shop/. $SBX/`, write `package.json` and `.gitignore`, `git init -b main`.
- [ ] **Step 2 [Claude]:** `npm test` in `$SBX`. Expected: every `B1`–`B4` test passes, 0 failures. If any fails, stop: the fixture, not the factory, is broken.
- [ ] **Step 3 [Claude]:** `git add -A && git commit -m "chore: seed the shop app from rig's e2e fixture"`.
- [ ] **Step 4 [Claude, after CK confirms]:** `gh repo create $REPO --private --source $SBX --push`. Expected: `gh repo view $REPO --json visibility -q .visibility` prints `PRIVATE`.

### Task 3: Onboard rig

- [ ] **Step 1 [CK]:** In `$SBX`: `claude --plugin-dir $RIG`, then `/rig:init`. Answer its questions; accept the stack it detects (Node, `npm test`).
- [ ] **Step 2 [Claude]:** Verify: `ls .rig/bin/sdlc.ts .claude/skills .rig/sensors.json` all exist; `$SDLC ready` runs without error (it lists nothing yet: there is no chart).
- [ ] **Step 3 [CK]:** Commit `.rig/`, `.claude/`, `CLAUDE.md` and push to `main` (the repo has no protection yet).
- [ ] **Step 4 [Claude]:** `git -C $SBX log origin/main --oneline -1` shows the init commit.

### Task 4: Install chb in the sandbox

- [ ] **Step 1 [Claude]:** In `$SBX`: `git switch -c chore/chb`, then `chb install . --owner @cwijayasundara --ci --ledger --coordinate --schedule day`.
- [ ] **Step 2 [Claude]:** `node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts baseline write --skip mutate`. Expected: `wrote .rig/ub-baseline.json: …`.
- [ ] **Step 3 [Claude]:** `chb doctor --repo-dir .`. Expected: every repo line ✓.
- [ ] **Step 4 [Claude]:** Check `.github/workflows/` has `chb-coordinate.yml`, `chb-ledger.yml`, `ub-gates.yml`, and rig's `rig-check.yml` if `/rig:init` installed one (if not, record it as a finding: FACTORY.md's `build` task expects it), and that the coordinator's cron is the `day` line (`23 7-21 * * 1-5`). The shop app has no dependencies, so leave the workflows' `npm ci` lines commented.
- [ ] **Step 5 [Claude]:** `git add -A && git commit -m "chore: chb gates, ledger and coordinator"` (rig's hooks run here; a refusal is a finding), push, `gh pr create`.
- [ ] **Step 6 [CK]:** Read the PR and merge it. Expected: `ub-gates` and `rig-check` ran on the PR (red or green, they must have run). Note: on a private repo without a paid plan, GitHub offers no branch protection, so checks are not enforced; CK merges by eye.

### Task 5: GitHub settings

- [ ] **Step 1 [CK]:** Create a fine-grained token at github.com → Settings → Developer settings → Fine-grained tokens: only `$REPO`; Contents, Pull requests, Issues, Checks: read and write. Then `! gh secret set CHB_GH_TOKEN -R $REPO` and paste it.
- [ ] **Step 2 [CK]:** `claude setup-token`, then `! gh secret set CLAUDE_CODE_OAUTH_TOKEN -R $REPO` and paste it.
- [ ] **Step 3 [Claude]:** `gh variable set CHB_WIP -b 2 -R $REPO` and `gh variable set CHB_SESSION_BUDGET_USD -b 5 -R $REPO`. Do **not** set `CHB_COORDINATE` yet.
- [ ] **Step 4 [Claude]:** Verify: `gh secret list -R $REPO` shows both secrets; `gh variable list -R $REPO` shows exactly `CHB_WIP` and `CHB_SESSION_BUDGET_USD`; `gh api repos/$REPO/actions/permissions -q .enabled` prints `true`.
- [ ] **Step 5 [Claude]:** Smoke-test the push token without a model: `gh workflow run chb-ledger.yml -R $REPO`, `gh run watch -R $REPO $(gh run list -R $REPO -w chb-ledger.yml -L 1 --json databaseId -q '.[0].databaseId')`. Expected: success (no PRs yet, nothing to label).

### Task 6: The sprint chart and the autonomy rung

**Files (in `$SBX`):**
- Create: `.rig/product/**` (from `$RIG/tests/e2e/prd/chart-fixture/product`)
- Create: `api/stock.yaml`, `contracts/examples/stock-low.json` (from `chart-fixture/repo`)
- Modify: each of `.rig/product/sprints/sprint-1/intents/{stock-model,stock-endpoint,cart-stock-limit}.md`: add `scope: [<its glob>]` above `estimate_days:`

- [ ] **Step 1 [Claude]:** `git switch -c chart/sprint-1`; copy the files; add the three `scope:` lines.
- [ ] **Step 2 [Claude]:** If `api/stock.yaml` and `contracts/examples/**` are not yet contract files in `.rig/sensors.json`, list that as a finding for CK. Do not edit `sensors.json` (protected).
- [ ] **Step 3 [Claude]:** `$SDLC chart check 1 --cases`. Expected: last line `chart-1: no blocking findings`. A blocking finding about scope fit is fixed in the intent files here, then rerun.
- [ ] **Step 4 [CK]:** In a Claude session in `$SBX`: `/rig:approve chart-1`, then `/rig:autonomy set 2 --why "supervised first factory run"`. Commit `.rig/` and push the branch; open the PR and merge it.
- [ ] **Step 5 [Claude]:** On updated `main`: `$SDLC ready` lists `stock-model` only; `chb coordinate --repo-dir $SBX` (dry run) prints `autonomy rung 2` and `start   plan stock-model: ready; writes src/catalog/**`, with the two other intents waiting on their dependency.

### Task 7: The supervised run

Before step 1, **[CK]** notes the Claude usage page reading. **[Claude]** sets `gh variable set CHB_COORDINATE -b on -R $REPO`. Each "start" below is `gh workflow run chb-coordinate.yml -R $REPO` followed by `gh run watch` on the newest run; Claude reads the `choose` summary and each session's `CHB-RESULT` line aloud to CK.

- [ ] **Step 1, plan `stock-model`:** start. Expected: one `plan stock-model` session; `CHB-RESULT kind=plan slug=stock-model … status=awaiting-approval`; branch `sdlc/stock-model` on GitHub with `spec.md` and `plan.md`. **[CK]** `git fetch && git switch sdlc/stock-model`, reads both files, closes any `## Open questions`, `/rig:approve stock-model`, pushes.
- [ ] **Step 2, build `stock-model`:** start. Expected: `start build stock-model: approved, no passing proof, build session 1 of 2`; `CHB-RESULT kind=build … proof=pass … status=done`; a PR whose `rig-check` and `ub-gates` are green. Then `gh workflow run chb-ledger.yml -R $REPO`; expected label `chb:ready`. **[CK]** reads the PR and merges.
- [ ] **Step 3, plan the dependants:** start. Expected: two plan sessions side by side (`cart-stock-limit`, `stock-endpoint`), each pushing its branch. **[CK]** approves both and pushes.
- [ ] **Step 4, build the dependants:** start. Expected: two build sessions side by side, two PRs with passing proofs and green checks, `chb:ready` after the ledger. **[CK]** merges both.
- [ ] **Step 5, done:** start once more. Expected: `0 in flight, 0 ready`. **[Claude]** `gh variable delete CHB_COORDINATE -R $REPO`.

If any step's expectation fails, stop the run, read the `choose` summary and the session log, and record what happened before going on.

### Task 8: Record the result

**Files:**
- Create: `docs/factory-runs/2026-10-29-supervised-run.md` (in this repo; use the actual run date)

- [ ] **Step 1 [Claude]:** Write the run record: each of FACTORY.md's "What working means" checks marked pass or fail with a link to its run page; Actions minutes per job (`gh run view <id> --json jobs`); **[CK]**'s Claude usage before and after; every surprise.
- [ ] **Step 2 [Claude]:** For each failed check or surprise in chb or rig, open an issue on the owning repo with the run link. Fixture-fit problems go in the run record only.
- [ ] **Step 3 [Claude]:** Commit the record on a branch and open a PR. **[CK]** merges it and decides whether the next step is a second supervised run or the cold `review` task from FACTORY.md.
