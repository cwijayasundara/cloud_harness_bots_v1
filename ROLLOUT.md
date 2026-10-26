# 30-day rollout

Personal and open-source repos only. No Virtusa client code goes near the bot computer until security and the client approve it. Each week ends at a gate you can check; a failed gate repeats its week.

## Week 1 · Baseline (26 Oct – 1 Nov)

- [ ] `npm test` in this package passes on your Mac
- [ ] `chb tools install` (pin the three SHAs you read: `chb tools status` prints them)
- [ ] Copy Uncle Bob's ub-mode to `~/.claude/skills/ub-mode/` (`chb install <repo> --ub-mode` fetches it), and run `/ub-mode` on one small change by hand
- [ ] `chb install ~/…/rig_v1 --owner @cwijayasundara`, then `chb baseline write --skip mutate` there; commit it on a branch and merge it through rig's own PR flow
- [ ] Record the starting numbers: `chb report --days 28 > reports/week0.md`
- [ ] Create **Foreman** (Primary Bot) and **Scribe** and **Smith**; add the two secrets; run `bots/setup-computer.sh`
- [ ] **Gate 1:** Smith dispatches a plan on a scratch rig repo, you approve it, Smith dispatches the build, and a PR with `proof.json` lands. If `claude --cloud` will not run from the bot computer, use `--local` and note it.

## Week 2 · Gates (2 – 8 Nov)

- [ ] ub-crap and ub-dry run as advisory sensors (`"blocks": false`) on every commit; read the warnings each day
- [ ] Fill in `.claude/skills/verify-app/SKILL.md` for one repo and run it end to end once
- [ ] Foreman's hourly ledger and 07:30 brief on; `chb:*` labels show on PRs; make a GitHub Project board filtered on them
- [ ] Smith's 22:00 build queue on
- [ ] **Gate 2:** on at least 3 mornings, a PR built overnight is ready by 07:30 with a passing, current proof

## Week 3 · Autonomy (9 – 15 Nov)

- [ ] **Auditor** at 02:00 (crap and dry nightly, mutate on Sundays); you approve its plans in the morning batch
- [ ] **Keeper** at 06:00; first postmortem written for whatever went wrong in weeks 1–2
- [ ] `chb dispatch build --go` set to Always allow for Smith
- [ ] In each repo, `/rig:autonomy` shows rig's own evidence-based proposal; when it agrees (3 clean ships), run `/rig:autonomy set 2 --why "Smith builds overnight"` (yours to type; a model cannot)
- [ ] `chb install --ci`, adapt the toolchain step, and watch `ub-gates` on PRs (auto-merge needs it green)
- [ ] Auto-merge on: `chb merge <n> --go` set to Always allow for Foreman (small chores and refactors only, as `chb merge` decides)
- [ ] **Gate 3:** no auto-merged PR reverted this week

## Week 4 · Measure (16 – 22 Nov)

- [ ] Flip `"blocks": true` on `ub-crap` and `ub-dry` in `.rig/sensors.json` (a reviewed PR); make `ub-gates` a required check
- [ ] Remove `continue-on-error` from the mutate leg in `ub-gates.yml` and set `CHB_REQUIRED_GATES=crap,dry,mutate` once survivors are under control
- [ ] Design-gate experiment: two comparable features with `"gates": {"plan": false}` and two with the gate on; compare lead time and review findings
- [ ] **Scout** on Fridays
- [ ] **Gate 4 (day 30):** `chb report --days 28 --touch-log …` against week 0. Keep option A if merged changes rose, reverts stayed flat or fell, and your hands-on minutes per change fell. Otherwise drop Grok Bot, keep the gates and rig changes, and move to option C (Claude scheduled tasks as the manager).
