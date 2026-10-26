---
name: policy-craft
description: The craft policy for this repository, adapted from Uncle Bob's ub-mode for rig. Apply it to every spec, plan, build slice, refactor and bug fix; it decides how code is written and when a change is done, using the computed gates (CRAP, duplication, mutation) instead of opinion.
owner: <you, e.g. @cwijayasundara>
source: https://github.com/unclebob/ub-mode (reduced from poteto's pstack principles), with the gates from unclebob/crapper, unclebob/dryer and unclebob/mutator
---
# Craft policy

Every change goes through three passes in order: **make it work, then make it right, then leave a clean trail.** If Uncle Bob's own `ub-mode` skill is installed (`~/.claude/skills/ub-mode`), read it too; this file maps it onto rig's stages and names the commands that prove each step. Where a change cannot meet a rule, do not work around it: record a `## Concerns` bullet naming this policy and its owner.

## While writing spec.md and plan.md (/rig:start, /rig:plan)

1. **Data first.** Name the data shape before any logic. Make illegal states impossible to represent, and list new domain terms in the glossary.
2. **One decision, one place.** Plan the smallest change that meets every behaviour. If a new requirement does not fit the old design, plan the design you would have built had it been there from the start, delivered in slices.
3. **Subtract before you add.** List what the change removes before what it adds.
4. **Boundaries.** Parse outside data once, where it enters. Keep business rules in pure functions. Make operations idempotent: running twice, or after a crash halfway, ends in the same state.
5. **Shared state.** Give each writer its own state. When two must share, allow one writer and enforce it in the structure.
6. **A test per behaviour.** Each B-number in spec.md names the test that will prove it, written against what a user of the code sees.

## While building (/rig:build), slice by slice

1. **Red first.** Write the failing test, see it fail for the reason you expect, then make the smallest change that passes it. If an honest test is impractical, say so in `## Concerns`; never write a test that would pass if every function returned nothing.
2. **Root causes.** For a bug, reproduce it with a failing test, then fix the cause. A guard that only hides the crash is not a fix.
3. **Two failed fixes on one premise.** Stop. Write the premise in one sentence, find who holds the imbalance, remove it, then try again.
4. **Build the lever.** When work is not obvious at a glance, do one unit by hand, then write the tool that does the rest the same way.
5. **Refactors.** Pin current behaviour with a characterization test, change the structure, and prove the behaviour did not change.

## Before /rig:pr: the computed gates decide "right"

Run them on the branch. Each one judges only what this change added or touched, against `.rig/ub-baseline.json`:

```
node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts gate crap     # every touched function CRAP < 10
node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts gate dry      # no new duplicate pair at 0.8 or above
node --disable-warning=ExperimentalWarning .rig/ub/bin/chb.ts gate mutate   # no surviving mutant in changed code (slow: CI or nightly)
```

- **CRAP** (`CC² × (1 − coverage)³ + CC`): split the function, test it, or both. Consider whether a long `switch` is worth splitting at all.
- **Duplication:** extract the shared shape once, where both callers can reach it.
- **Mutation:** cover the uncovered, kill each survivor with a test that fails when the code changes, and delete code no test can reach.
- A `warn` line is legacy debt the baseline already holds: leave it unless your change is about it. A `BLOCK` line is yours.
- **Never** edit `.rig/ub-baseline.json`, a test expectation or a sensor to pass a gate. The gates block a loosened baseline, and only a person may loosen it.

After `/rig:pr` has pushed, run `chb proof <slug>`, then commit and push `.rig/changes/<slug>/proof.json`. The Foreman bot reads that file, not your summary.

## Practice

- **Log as you go.** Each commit says why, what changed, and how you proved it (the command and its result).
- **Guard the context window.** Send bulk reading to a subagent and keep the summary.
- **Small, ordered commits.** One verifiable unit per commit; finish and check one unit before starting the next.
- **Clean up worktrees** you created once their branch is merged; uncommitted work waits for a person.
