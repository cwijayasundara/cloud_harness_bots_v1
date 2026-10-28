#!/usr/bin/env bash
# Run on the Grok Bot cloud computer (Linux), from a terminal the Foreman opens, or paste it to the Foreman to run.
# Safe to rerun: "Update Bot's Computer" keeps /workspace but removes installed packages, so rerun this after one.
# Secrets: never paste tokens into chat. Add them through Grok Bot's masked secrets input as GH_TOKEN and
# CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token` on your Mac). GH_TOKEN = a fine-grained token limited to the
# repos listed in REPOS, with Contents, Pull requests, Issues (labels) and Checks: read/write; nothing else.
set -euo pipefail

WS=/workspace
REPOS=${REPOS:-"cwijayasundara/rig_v1"}           # space-separated owner/name; personal and OSS repos only in phase 1
CHB_REPO=${CHB_REPO:-"cwijayasundara/cloud_harness_bots_v1"}   # this package

need() { command -v "$1" >/dev/null 2>&1; }

# Node 22.18+ (runs chb and rig as TypeScript), gh, python3 (the Uncle Bob tools build their own venvs), git.
if ! need node || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
fi
need gh || { sudo apt-get update -y && sudo apt-get install -y gh; }
need python3 || sudo apt-get install -y python3 python3-venv
python3 -m venv --help >/dev/null 2>&1 || sudo apt-get install -y python3-venv
need claude || npm install -g @anthropic-ai/claude-code

mkdir -p "$WS/repos" "$WS/chb/state" "$WS/chb/ledger" "$WS/chb/reports" "$WS/chb/postmortems" "$WS/chb/briefs"
[ -f "$WS/chb/touches.csv" ] || echo "# at,minutes,note" > "$WS/chb/touches.csv"

if [ -n "${GH_TOKEN:-}" ]; then gh auth status >/dev/null 2>&1 || echo "$GH_TOKEN" | gh auth login --with-token; fi
gh auth setup-git || true

if [ -n "$CHB_REPO" ]; then
  if [ -d "$WS/chb/pkg/.git" ]; then git -C "$WS/chb/pkg" pull -q --ff-only; else git clone -q "https://github.com/$CHB_REPO.git" "$WS/chb/pkg"; fi
fi
for r in $REPOS; do
  d="$WS/repos/${r#*/}"
  if [ -d "$d/.git" ]; then git -C "$d" pull -q --ff-only; else git clone -q "https://github.com/$r.git" "$d"; fi
done

export UB_TOOLS_DIR="$WS/ub-tools"
if [ -f "$WS/chb/pkg/bin/chb.ts" ]; then node --disable-warning=ExperimentalWarning "$WS/chb/pkg/bin/chb.ts" tools install; fi

cat > "$WS/chb/env.sh" <<EOF
export UB_TOOLS_DIR=$WS/ub-tools
export CHB_HOME=$WS/chb/state
export CHB_TZ=Europe/London
alias chb='node --disable-warning=ExperimentalWarning $WS/chb/pkg/bin/chb.ts'
EOF
echo "ready: source $WS/chb/env.sh   (repos in $WS/repos)"
claude --version || echo "claude CLI missing: dispatch will not work until it is installed and CLAUDE_CODE_OAUTH_TOKEN is set"
