# FACTORY.md: chb as a software factory

This file designs chb as a software factory, using the language of Matt Pocock's `software-factory` skill ([mattpocock/skills#1316](https://github.com/mattpocock/skills/pull/1316), MIT). It describes the factory we will **run for real this week on a throwaway private repo**, not every task chb could grow into.

## Why this exists

chb has passed its tests and the $0 pilot (`pilot/dry-run.mjs`: 3 intents shipped in order, two sessions side by side, no failures, all commits CK's). But nobody has yet seen it run end to end with real Claude sessions on GitHub. The goal of this design is one thing: **watch the factory take an approved sprint to merged PRs on GitHub, with real models, once, without surprises.** Only then do we add tasks.

- **Goal:** one supervised daytime run on a sandbox repo. CK starts each coordinator run by hand, approves and merges as each step finishes, and watches every step in the Actions run pages. Expected to take about one afternoon.
- **Non-goals:** overnight unattended runs (they come after this run works), GitHub Issues as the ticket tracker, auto-merge, tier-0 auto-build, the Grok bots, any production repo.
- **Anti-goals:** a run that merges something no person approved; a run that loops without a cap; a night that "worked" but where you can't tell from the run pages what each run did.

## Language

These terms come from the skill and are used only in this sense here.

| Term | Meaning | In chb |
| --- | --- | --- |
| **Task** | A kind of work, defined once, run many times | `plan`, `build`, `ai-review`, `ledger` (and later `rework`) |
| **Trigger** | The event that starts a run | the coordinator's hourly clock, a manual `workflow_dispatch`, a `pull_request` event |
| **Run** | One execution of a task on one runner, start to finish. It never waits for a person: it ends, and the person's later change triggers a new run | one `session` job in `chb-coordinate`, one `ub-gates` / `rig-check` workflow run |
| **Runner** | The throwaway machine a run executes on. Nothing survives it | a GitHub-hosted `ubuntu-latest` job |
| **Ticket tracker** | Where the tickets live, and how a person talks to the factory | rig's sprint chart in the repo (`.rig/product/sprints/sprint-<N>/intents/*.md`): the skill's "in-repo files" type |
| **Ticket source** | Anything outside the factory that files tickets | none yet: CK writes the PRD and runs `/rig:chart` |
| **Git host** | Where branches, PRs and reviews live | GitHub |
| **Orchestrator** | Receives triggers, starts runs, records what is queued, in flight, finished | GitHub Actions + `chb coordinate` (in-flight state: `origin/sdlc/*` branches; run history: the dispatch log in the Actions cache) |
| **Observability platform** | Where a person sees what happened inside each run | a deliberate none: Actions run pages and their step summaries (`CHB-RESULT` lines) |

**Brakes** (Matt's three): automated checks (rig sensors and hooks, `rig-check`, `ub-gates`: CRAP, duplication, mutation), automated review (twice: inside the build run by `/rig:pr`, and cold in its own run by `ai-review`), and human review (CK approves every plan and merges every PR).

## Services

| Slot | Product | Notes |
| --- | --- | --- |
| Ticket tracker | rig sprint chart, in the repo | The person's interface is `/rig:approve` (pushed) and PR merges. A deliberate departure from the skill's advice to buy an off-the-shelf tracker: rig's files carry the approvals and hashes that the gates check. A GitHub Issues bridge is listed under *Not yet*. |
| Ticket source | none | |
| Git host | GitHub, private repo `cwijayasundara/chb-factory-sandbox` | Private: Actions minutes come from the free tier's 2,000/month. |
| Orchestrator | GitHub Actions: `chb-coordinate.yml`, `chb-ledger.yml` | Installed with schedule `day`. For the supervised run CK starts both workflows by hand (`workflow_dispatch`) after each step; `CHB_COORDINATE=on` only while CK is at the desk, deleted when the session ends, so no hourly tick runs unwatched. |
| Runner | GitHub-hosted `ubuntu-latest`, one job per run | Node 22.18, Python 3.12 for the UB tools, Claude Code installed per job. |
| Observability platform | none | The run page plus `$GITHUB_STEP_SUMMARY`. If a night can't be read from these, that is a finding about the design, not a reason to buy a platform. |

## Tasks (first run)

### `plan`

1. **Trigger:** the coordinator's clock (or a manual dispatch) finds an intent that `sdlc.ts ready` lists, at autonomy rung ≥ 1, whose `scope:` overlaps nothing in flight.
2. **Does:** `/rig:start` and `/rig:plan` in a Claude Code session on the runner; any question it would ask CK goes under `## Open questions` with a recommended answer. Reads the repo; writes and pushes `sdlc/<slug>` with `spec.md` and `plan.md`.
3. **Triggers next:** nothing directly. The run ends with `status=awaiting-approval`.
4. **Person re-enters:** CK reads `spec.md` and `plan.md` on the branch, closes open questions, runs `/rig:approve <slug>` and pushes. The next clock tick sees the approval.
5. **Stops duplicate work:** the `origin/sdlc/<slug>` branch claims the intent's scope; a plan dispatched in the last 6 hours holds the scope before its branch appears; at most 2 plan runs per change (`CHB_MAX_PLANS`); one coordinator at a time (`concurrency: chb-coordinate` and a lock file).

### `build` (the implementer)

1. **Trigger:** the clock finds a change whose `approval.json` hashes match its spec, plan and requirements, with no passing proof, at rung ≥ 2.
2. **Does:** `/rig:build`, `/rig:test`, `/rig:pr` (which includes rig's clean-context review and security review, and fixes their findings), then the gates and `chb proof`. Opens the PR on GitHub and commits `proof.json`.
3. **Triggers next:** the PR triggers `rig-check` (sensors, and the `ai-review` run below) and `ub-gates` (automated checks); the hourly ledger labels it.
4. **Person re-enters:** CK reads the PR and merges it. If a run ends `status=needs-human`, or the change has used both build runs, CK reads the `CHB-RESULT` line and `proof.json` reasons, fixes the brief or code, and starts one more by hand: `chb dispatch build <slug> --repo-dir . --go --force`.
5. **Stops duplicate work:** at most 2 build runs per change (`CHB_MAX_BUILDS`); no second build while one dispatched after the branch's last commit may still be running; 2 fix rounds inside a run.

### `ai-review` (the cold automated review)

A job in rig's `rig-check.yml`, found during setup: it was already there.

1. **Trigger:** a PR from this repo is opened or gets a new commit (`pull_request`).
2. **Does:** two `claude -p --model opus` runs with read-only tools (`Read,Grep,Glob`) on the diff only: a code review briefed from the base branch's `REVIEW.md`, and a security review. Each writes a verdict; the job fails on any critical or high item under `## Findings`.
3. **Triggers next:** nothing. A fail leaves the PR red for CK (and, later, for a `rework` run).
4. **Person re-enters:** at merge: CK reads the findings in the job log.
5. **Stops duplicate work:** `concurrency: rig-check-<PR>` with cancel-in-progress: one review per head commit, never a queue of reviews of stale code.

### `ledger`

1. **Trigger:** hourly clock, 06:17–22:17 UTC (`chb-ledger.yml`); during the supervised run, CK also starts it by hand after each build.
2. **Does:** reads every open `sdlc/*` PR, its checks and `proof.json`; sets `chb:ready`, `chb:blocked` or `chb:working`; keeps one summary issue. Writes labels and that issue only.
3. **Triggers next:** nothing. `CHB_AUTOMERGE` stays unset, so it never merges.
4. **Person re-enters:** CK starts the morning from the labels and the summary issue.
5. **Stops duplicate work:** it sets labels idempotently and edits one issue, never files a second.

### Throttle for the first run

Start slow: `CHB_WIP=2` (the sprint can't use more), `CHB_SESSION_BUDGET_USD=5`, autonomy rung 2, no tier-0, no auto-merge. Every coordinator run is started by hand from the Actions tab while CK watches. The token is CK's Claude subscription (`claude setup-token`), so the budget flag is only a per-session cap, not a bill; the real limit is the plan's usage caps, which two runs side by side may reach.

### The supervised run, step by step

1. Start `chb-coordinate`: it plans `stock-model`. CK reads the plan, approves, pushes.
2. Start `chb-coordinate`: it builds `stock-model` and opens the PR. CK starts `chb-ledger`, reads the PR, merges.
3. Start `chb-coordinate`: it plans `stock-endpoint` and `cart-stock-limit` side by side. CK approves both, pushes.
4. Start `chb-coordinate`: it builds both side by side. CK starts `chb-ledger`, reads both PRs, merges.
5. Start `chb-coordinate` once more: it reports nothing ready. Delete `CHB_COORDINATE`.

## What "working" means

The run counts as working when all of these hold, checked from GitHub alone:

- [ ] A hand-started `chb-coordinate` run plans `stock-model` and pushes `sdlc/stock-model` with a spec and plan.
- [ ] After CK's approval, a build run opens a PR whose `rig-check` (including `ai-review`) and `ub-gates` are green and whose `proof.json` passes.
- [ ] `stock-endpoint` and `cart-stock-limit` wait for `stock-model` to merge, then plan and build side by side.
- [ ] Every run page shows its `CHB-RESULT` line; every waiting intent shows its reason in the `choose` summary.
- [ ] The ledger labels each PR correctly.
- [ ] Nothing merged without CK; no change used more than 2 build runs.
- [ ] Usage and minutes for the run are written down by hand (CK's Claude usage page before and after, the Actions minutes from the run pages), as the baseline for adding tasks. chb records no cost itself yet.

Whatever fails becomes a ticket on chb before any new task is added.

## The sandbox repo

Seeded with known work and known dependencies, so the run tests the factory and not the PRD:

- **Code:** rig's real shop app, `rig_v1/tests/e2e/fixtures/shop` (`src/catalog/products.js`, `src/cart/cart.js`, `src/http/handler.js`, `src/server.js`, `src/orders/orders.js`, `api/openapi.yaml`, contract examples, one test file). Not the pilot's stub (`src/index.js` is `export {}`), where real models would have to invent a cart and wire a server outside their scopes.
- **rig:** a real `/rig:init` on that code (stack, sensors, baseline, as README step 2), not the pilot's hand-written `sensors.json`. Then `chb install --ci --ledger --coordinate --schedule day` and `chb baseline write`.
- **Sprint:** rig's chart fixture (`rig_v1/tests/e2e/prd/chart-fixture`): its `product/` (PRD, architecture, sprint-1 intents and test plan) and its `repo/` additions (`api/stock.yaml`, `contracts/examples/stock-low.json`), each intent given its `scope:` as the pilot does (`src/catalog/**`, `src/http/**`, `src/cart/**`). `sdlc.ts chart check 1` must pass before CK approves `chart-1`.

If `/rig:init` or `chart check` shows the fixture sprint doesn't fit the real shop app (a scope that misses a file the intent must write), the fix goes in the sandbox's intents before the run starts, not in the factory. The setup follows README's *Step by step: your first overnight run*, steps 1–7. Each step that only CK can perform (the two secrets, `/rig:autonomy`, `/rig:approve` on the chart and each plan, merges) is marked as theirs.

## Next task: `rework` (after the first run works)

The cold review already exists (`ai-review` above), but a failed one only leaves the PR red. Matt's chain closes the loop with a rework run. Sketch, to be designed properly once the first run has worked:

1. **Trigger:** `ai-review` fails on a PR from an `sdlc/*` branch.
2. **Does:** fixes only the critical and high findings `ai-review` named, reruns `/rig:test` and the proof, and pushes. Edits nothing the plan doesn't list.
3. **Triggers next:** the push triggers `ai-review` again. After 2 rework rounds on a change, it ends with the PR labelled `chb:blocked`.
4. **Person re-enters:** at merge, or when the cap is reached.
5. **Stops duplicate work:** one rework per failed review of a head commit; the round count is kept in the dispatch log, like build sessions.

Open points for that design: how the rework run gets `ai-review`'s findings (today they live only in the job log, not in a file or a PR comment); whether the coordinator emits `rework` jobs or a `workflow_run` trigger starts them. chb's own `chb dispatch review` (a reviewer that writes `review.md`) overlaps `ai-review`; keep one.

## Not yet

Each is one of Matt's example tasks, added one at a time only after the previous one has run cleanly:

| Task | Problem it solves | chb starting point |
| --- | --- | --- |
| explore / triage | GitHub issues pile up untriaged | a bridge from issue labels to `/rig:start` |
| fix | the factory's own runs fail | the `choose` summary, `CHB-RESULT` lines |
| architecture | the codebase drifts | `chb dispatch audit`, `/rig:arch` |
| retro | the same mistakes keep coming back | `/rig:learn`, `chb lessons`, throttled to 1 merged PR in 10 |
| ratchet | migrating to a stricter check | Tare's advisory → blocking ratchet, one file a day |
| ticket sources | user bugs and production problems found late | none |
