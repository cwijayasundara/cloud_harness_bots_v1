# The bot roster

No Grok Bot? The coordinator also runs on GitHub Actions (`chb install . --coordinate`, see the README): the queue, parallel sessions and pushes as you, without the bots. The bots add the morning brief, postmortems and the Friday lesson review.

Six Grok Bots, each owning one result. Bots manage; Claude Code cloud sessions running rig do the coding; `chb` and rig's sensors decide what is done. You keep three things: ideas, `/rig:approve`, and merging anything that isn't a small chore or refactor.

| Bot | Owns | Starts when | Routine (Europe/London) | Week |
| --- | --- | --- | --- | --- |
| [Foreman](foreman.md) (Primary Bot) | The PR ledger and your morning brief | You message it; GitHub PR / check events | Sweep hourly 07:00–23:00 · brief 07:30 | 1 |
| [Scribe](scribe.md) | Turning talk into rig inputs | You talk or dictate | none | 1 |
| [Smith](smith.md) | Getting approved changes to a PR with proof | Foreman hands it work | 22:00 build queue | 1 |
| [Auditor](auditor.md) | Codebase health | Schedule | 02:00 nightly audit | 3 |
| [Keeper](keeper.md) | The playbook and the bots' mistakes | You flag a mistake; schedule | 06:00 one-to-ones | 3 |
| [Scout](scout.md) | Technique radar | Schedule | Fridays 16:00 | 4 |

## Set up, in this order

1. **This package lives at** `cwijayasundara/cloud_harness_bots_v1` (MIT). If the repo is private, include it in the bot's `GH_TOKEN`.
2. **Create the Foreman first** and make it your **Primary Bot**. Paste the description block from `foreman.md` into the Bot's description.
3. **Secrets.** Ask the Foreman for a secrets input (never paste a token into chat) and add:
   - `GH_TOKEN`: a fine-grained GitHub token limited to the repos in scope, with Contents, Pull requests, Issues and Checks set to read/write.
   - `CLAUDE_CODE_OAUTH_TOKEN`: from `claude setup-token` on your Mac.
4. **Computer.** Tell the Foreman: *"Clone cwijayasundara/cloud_harness_bots_v1 and run bots/setup-computer.sh with REPOS='<owner/repo> …'. Show me the last 20 lines."* Rerun it after any **Update Bot's Computer**, which keeps `/workspace` but removes installed packages.
5. **Prove the route (week 1 gate).** Have the Foreman run `chb dispatch plan "chore: <something tiny>" --repo-dir /workspace/repos/<repo> --go` on a scratch rig repo. This is the step that proves a bot can start a Claude Code cloud session. If `claude --cloud` refuses the token, fall back to `--local` (a `claude -p` run on the bot computer) and tell me.
6. Create the other bots as each week of [ROLLOUT.md](../ROLLOUT.md) calls for them. Put Foreman, Smith and Keeper in one group chat called **eng** for handoffs.

## Conventions every bot follows

- **State lives in GitHub, not in chat.** The ledger is the `chb:*` labels on PRs plus `/workspace/chb/ledger/<repo>.md`. A bot that loses context reads those first.
- **Files.** Durable files go under `/workspace/chb/`: `ledger/`, `briefs/`, `reports/`, `postmortems/`, `state/` (dispatch log), and `touches.csv`. Never put a secret in `/workspace`: every bot can read it.
- **Commands.** Always `source /workspace/chb/env.sh` first, then call `chb …`. Never compute a status that `chb` computes.
- **Results.** Every Claude Code session ends with a `CHB-RESULT …` line. Read that line instead of summarising the transcript.
- **Escalate early.** Report as soon as you cannot make progress. Never retry the same failing step more than twice.
- **Never:** run `/rig:approve` or `/rig:waive`, edit `.rig/ub-baseline.json`, `.rig/sensors.json` or anything under `.claude/`, force-push, or merge without `chb merge <n>` saying AUTO-MERGE.

## Approval rules (Settings → Approvals), the same for every bot

**Always allow:** read GitHub (gh read commands); run `chb ledger | proof | report | gate | tools status`; create files under `/workspace/chb/`; `chb dispatch plan|audit --go` on repos in scope.

**Require approval:** `chb merge <n> --go`; `chb dispatch build --go` (until week 3; then Always allow for Smith); any `git push` a bot runs itself; closing or reopening a PR or issue; creating a repo, label scheme or webhook; anything on a repo not in scope; any purchase; anything on your local computer.

A require-approval rule wins when both match, so keep the lists as written.
