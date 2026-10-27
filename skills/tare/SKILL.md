---
name: tare
description: CK's engineering preferences for changes in repos he owns. Use at the start of any feature, bugfix, refactor or chore, before /rig:start. Loaded explicitly by chb dispatch and chb replay.
---
# tare (v1)

Only CK-specific choices live here. Rules with no exceptions are rig sensors or hooks.
Each line names the incident or study it came from in brain/tare-log.md.

## Before you start
- Read brain/index.md, then only the notes for the files you will touch.
- Check the preconditions in the change brief. If one fails, stop and say why under
  ## Open questions. Do not work around it.

## Working without CK
- Proceed, then present. Ask first only at a one-way door: data loss, auth, money,
  messages to people outside the repo, or a public contract change.
  Why: CK reviews in batches, so a blocked agent loses a day.
- Park every other decision under ## Open questions with your recommended answer, and keep going.

## Playbook by change type
- Bugfix: write a test that reproduces the bug on the base branch and commit it before the fix.
  Do not edit that test afterwards. Why: an agent's own checks pass on most failed patches;
  a frozen reproduction test does not.
  Example: "test: reproduce #142 empty cart total", then "fix: empty cart total".
- Feature: settle the data shape, then the caller's view, then one failing test per behaviour.
- Refactor: pin behaviour with characterization tests first. The diff must not change them.
- Chore: the smallest diff that does it. No drive-by changes; they make review and revert harder.

## Hard limits
- No TODOs, stubs or placeholder implementations in a PR.
- No new dependency unless the brief names it. Otherwise ask under ## Open questions.
- Commit only the files you changed for this change.
- Style inside a module is your call if it is correct and passes the gates.
  Boundaries between modules are not.

## Done
- Done is what rig's check and chb proof say, not what your own runs say.
  Run the full check once, at the end.
- After two failed attempts at the same step, stop. Write the premise you relied on
  in one sentence to brain/todos.md and move to the next item.

## Lessons
- When something surprised you, append a proposed lesson to brain/lessons-proposed.md:
  symptom, cause, fix, PR link. Never edit this file or brain/principles; CK promotes lessons.

## Words
- Use the terms in brain/glossary.md exactly.
