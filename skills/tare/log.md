# Tare log

Where each Tare rule came from, and what enforces it. `chb tare status` reads this file:
- a Tare line with no entry is untraced;
- an entry whose `check:` blocks in every repo marks a line that can go.

Grades follow the evidence report: controlled, vendor eval, vendor guidance, consensus, single, opinion.

Entry format: `- key: <words that find the line> | added <date> | source: <evidence> | check: <sensor id or none>`

- key: Read brain/index.md | added 2026-10-27 | source: noodle's inject-brain pattern (single); MemCoder gains level off at about 8 retrieved notes (controlled, preprint) | check: none
- key: Check the preconditions | added 2026-10-27 | source: Spotify Honk, "when not to act"; Cursor, constraints over instructions (consensus) | check: none
- key: Proceed, then present | added 2026-10-27 | source: poteto, "never block on the human" (single); CK reviews in batches (opinion) | check: none
- key: Park every other decision | added 2026-10-27 | source: chb dispatch plan, unattended sessions; poteto (single) | check: none
- key: Bugfix: write a test | added 2026-10-27 | source: ISSTA 2026, 81–100% of failed patches passed the agent's own checks; ExecCritic, frozen tests +11.4 pp (controlled) | check: tare-frozen-tests
- key: Feature: settle the data shape | added 2026-10-27 | source: CK's practice; Uncle Bob's ub-mode (opinion) | check: none
- key: Refactor: pin behaviour | added 2026-10-27 | source: ub-mode; rig red-proof, green mode (single) | check: tare-frozen-tests
- key: Chore: the smallest diff | added 2026-10-27 | source: CK's practice; chb merge policy, small chores only (opinion) | check: none
- key: No TODOs | added 2026-10-27 | source: Cursor, "No TODOs, no partial implementations" (consensus) | check: tare-placeholders
- key: No new dependency | added 2026-10-27 | source: Cursor, list of banned dependencies (consensus) | check: tare-deps
- key: Commit only the files | added 2026-10-27 | source: Steinberger, shared-folder agents (single) | check: tare-scope
- key: Style inside a module | added 2026-10-27 | source: OpenAI harness engineering, constrain boundaries not style (single) | check: none
- key: Done is what rig | added 2026-10-27 | source: ISSTA 2026, self-validation misses most failures; full check late in the task pays off most (controlled) | check: none
- key: After two failed attempts | added 2026-10-27 | source: Stripe Minions, two CI rounds then a person (single); also enforced by chb dispatch build | check: none
- key: brain/glossary.md | added 2026-10-27 | source: poteto talk, words the agent latches onto (single) | check: none

Removed:
- 2026-10-27: "append a proposed lesson to brain/lessons-proposed.md". rig's learn loop now mines lessons from reviewer findings and corrections that recur, and agent-written lessons scored −1.3 pp in SkillsBench (controlled, preprint).
