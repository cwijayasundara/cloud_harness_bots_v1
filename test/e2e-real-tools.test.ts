// Real tools, real git: a small Python repo with legacy debt, then a branch that adds new debt and fixes it.
// Runs only when crapper, dryer and mutator are installed (UB_TOOLS_DIR or ~/.ub-tools) and CHB_E2E=1; CI sets both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/chb.ts')
const TOOLS = process.env.UB_TOOLS_DIR || path.join(os.homedir(), '.ub-tools')
const ready = process.env.CHB_E2E === '1' && ['crapper', 'dryer', 'mutator'].every(t => fs.existsSync(path.join(TOOLS, t, t)))

const LEGACY = `def discount(kind, amount, loyal, coupon):
    if kind == "gold":
        if loyal and amount > 100:
            return amount * 0.8
        elif coupon:
            return amount * 0.85
        return amount * 0.9
    elif kind == "silver":
        if loyal or coupon:
            return amount * 0.92
        return amount * 0.95
    elif kind == "staff" and amount > 10:
        return amount * 0.5
    return amount
`
const LINES = (fn: string, a: string, b: string) => `def ${fn}(items, tax):
    lines = []
    for ${a} in items:
        net = ${a}["qty"] * ${a}["price"]
        gross = net + net * tax
        lines.append({"sku": ${a}["sku"], "net": net, "gross": gross})
    return ${b}
`
const BAD = `

def shipping(zone, weight, express):
    if zone == "eu":
        if express and weight > 5:
            return 30
        elif express:
            return 20
        return 10
    elif zone == "us":
        if weight > 10 or express:
            return 40
        return 25
    return 50
`
const GOOD = `

RATES = {"eu": (30, 20, 10), "us": (40, 40, 25)}


def shipping(zone, weight, express):
    if zone not in RATES:
        return 50
    fast_heavy, fast, slow = RATES[zone]
    return (fast_heavy if weight > 5 else fast) if express else slow
`

test('real tools: legacy warns, new debt blocks, a split + tested function passes, a copy blocks', { skip: !ready && 'set CHB_E2E=1 and install the tools (chb tools install)', timeout: 15 * 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chb-e2e-'))
  const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' })
  const chb = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHB, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, UB_TOOLS_DIR: TOOLS, CHB_BASE: 'main' } })
  const put = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c) }
  const commit = (m: string) => { sh('git', ['add', '-A']); sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', m]) }

  put('pyproject.toml', '[project]\nname = "shop"\nversion = "0.1.0"\n[tool.pytest.ini_options]\npythonpath = ["src"]\n')
  put('.gitignore', '.venv/\n__pycache__/\n.metrics/\n.rig/ub/results/\ntarget/\n')
  put('src/shop/__init__.py', '')
  put('src/shop/pricing.py', LEGACY)
  put('src/shop/invoice.py', LINES('invoice_lines', 'item', 'lines'))
  put('src/shop/receipt.py', LINES('receipt_rows', 'entry', 'lines'))
  put('tests/test_pricing.py', 'from shop.invoice import invoice_lines\n\n\ndef test_invoice():\n    assert invoice_lines([{"sku": "a", "qty": 2, "price": 3}], 0.5) == [{"sku": "a", "net": 6, "gross": 9.0}]\n')
  put('.rig/sensors.json', '{"sensors": []}\n')
  sh('python3', ['-m', 'venv', '.venv'])
  sh(path.join(dir, '.venv/bin/pip'), ['install', '-q', 'pytest'])
  sh('git', ['init', '-q', '-b', 'main']); commit('base')

  let r = chb('baseline', 'write', '--skip', 'mutate')
  assert.equal(r.status, 0, r.stderr)
  const base = JSON.parse(fs.readFileSync(path.join(dir, '.rig/ub-baseline.json'), 'utf8'))
  assert.deepEqual(Object.keys(base.crap), ['shop.pricing#discount'], 'only the repo\'s own source, never .venv')
  assert.deepEqual(base.dry, { 'src/shop/invoice.py|src/shop/receipt.py': 1 })
  commit('baseline')

  sh('git', ['checkout', '-q', '-b', 'sdlc/shipping'])
  put('src/shop/pricing.py', LEGACY + BAD); commit('shipping, untested')
  r = chb('gate', 'crap')
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /warn {2}shop\.pricing#discount .* legacy/)
  assert.match(r.stdout, /BLOCK shop\.pricing#shipping .* new function over the bar/)

  put('src/shop/pricing.py', LEGACY + GOOD)
  put('tests/test_shipping.py', 'from shop.pricing import shipping\n\n\ndef test_rates():\n    assert [shipping("eu", 6, True), shipping("eu", 5, True), shipping("eu", 9, False)] == [30, 20, 10]\n    assert [shipping("us", 11, False), shipping("us", 1, True), shipping("mars", 1, False)] == [25, 40, 50]\n')
  commit('shipping: table-driven and tested')
  r = chb('gate', 'crap')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stdout.trim().split('\n').at(-1), '0')
  r = chb('gate', 'mutate')
  assert.ok([0, 1].includes(r.status ?? -1), r.stderr)

  put('src/shop/credit.py', LINES('credit_lines', 'row', 'lines')); commit('a copy')
  r = chb('gate', 'dry')
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.match(r.stdout, /BLOCK src\/shop\/credit\.py/)
  assert.doesNotMatch(r.stdout, /BLOCK src\/shop\/invoice\.py:1-7 ≈ src\/shop\/receipt\.py/, 'the legacy pair is not this branch\'s debt')
})
