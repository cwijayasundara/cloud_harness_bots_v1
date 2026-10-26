---
name: verify-app
description: How to prove a change works on the real running app, not only in unit tests. Use at /rig:test's acceptance level, before /rig:pr, and whenever a bot asks for proof of a user-visible change. A TEMPLATE: fill in the five steps and the feature map for this repo once, run it end to end, then keep it current.
---
# Verify the app

A green unit suite is not proof that a user can do the thing. This skill drives the real app and captures evidence a reviewer (or the Foreman bot) can check without rerunning anything. The idea comes from poteto's pstack (`/create-verification-skill`); adapt it freely.

**Fill in every `<…>` below for this repo, then run the whole skill once and fix it until it passes.** Keep it under 150 lines.

## 1. Launch

```
<the exact command that starts the app locally or in a cloud session, e.g. npm run dev -- --port 4173>
```

- Environment it needs: `<env vars, with safe local values; never real secrets>`
- Test data: `<seed command or fixture path>`

## 2. Check it is healthy

```
<a command that exits 0 only when the app is ready, e.g. curl -fsS http://localhost:4173/health>
```

Retry for up to `<N>` seconds. If it never becomes healthy, stop and report the last 30 log lines.

## 3. Drive the behaviour

Use the interface a user uses: an HTTP call for an API, the CLI for a CLI, a browser (Playwright or Chrome DevTools) for a UI. Follow the feature map row for each behaviour the change touches.

## 4. Capture evidence

Write everything under `.rig/changes/<slug>/evidence/`:

- the commands you ran and their exit codes (`commands.txt`)
- responses or output (`*.json`, `*.txt`)
- for UI: a screenshot before and after (`before-*.png`, `after-*.png`)
- one line per behaviour: `B<n>: pass|fail, <file that shows it>` (`summary.txt`)

## 5. Clean up

Stop only what step 1 started. Remove temporary data you created. Leave the developer's own processes and data alone.

## Feature map

| Feature | How a user reaches it | How an agent drives it | What proves it works |
| --- | --- | --- | --- |
| `<e.g. add item to cart>` | `<UI: product page → Add>` | `<POST /cart/items {sku, qty}>` | `<GET /cart shows qty; 201 + Location header>` |
