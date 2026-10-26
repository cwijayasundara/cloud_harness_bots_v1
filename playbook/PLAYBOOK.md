# Engineering bot playbook

Keeper owns this file at `/workspace/chb/PLAYBOOK.md` and announces every change in the **eng** group. Each rule exists because skipping it cost something; the log at the bottom says when it was added.

## Ground rules (all bots)

1. **Facts before opinions.** A status comes from `chb ledger`, a pass from `chb proof`, a gate from `chb gate`. Never report "done" from a transcript or a summary.
2. **One owner per result.** If it is not your result, hand it to its owner once, with the link and the reason, then stop.
3. **State lives in GitHub and `/workspace/chb/`.** After a context reset, read the ledger and your last report before acting.
4. **Escalate at the second failure.** The same step failing twice goes to Foreman (bots) or CK (Foreman).
5. **Never loosen a guard.** No editing baselines, sensors, tests, CI or `.claude/`. No `/rig:approve` or `/rig:waive`. No force-push.
6. **Quiet when nothing changed.** A run that finds nothing writes its file and sends no message.
7. **Secrets** only through the masked secrets input; never in chat, never in `/workspace`.
8. **Usage.** Prefer event triggers to schedules; P0 loops only when CK says P0.

## Definition of done (a change)

- `verify.json` passes (rig's sensors on the branch diff)
- `chb gate crap` and `chb gate dry` pass on the change (no BLOCK line)
- review.md verdict is pass, with no open critical or high finding
- `proof.json` passes and is current (nothing but proof.json was committed after it)
- for user-visible changes, the `verify-app` evidence exists under `.rig/changes/<slug>/evidence/`

## Auto-merge (Foreman, via `chb merge`)

A small chore or refactor (≤ 150 lines, no protected path) that is ready, with rig-check and ub-gates green, merges itself. Everything else waits for CK. Any revert of an auto-merge triggers a Keeper postmortem, and auto-merge pauses until CK resumes it.

## Change log

| Date | Rule | Why |
| --- | --- | --- |
| (start) | Ground rules 1–8 | From the Grok Bot engineering guide, ub-mode and rig's design |
