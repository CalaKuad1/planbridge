#!/usr/bin/env sh
# PlanBridge installer (macOS / Linux):  curl -fsSL https://raw.githubusercontent.com/CalaKuad1/planbridge/main/scripts/install.sh | sh
set -e
say() { printf '  %s\n' "$1"; }
printf '\n  PlanBridge installer\n\n'

if ! command -v node >/dev/null 2>&1; then
  say "Node.js is required (21.7+): https://nodejs.org"; exit 1
fi
NODE_OK=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>21||(a===21&&b>=7)?1:0)')
[ "$NODE_OK" = "1" ] || { say "Node $(node -v) is too old — need 21.7+"; exit 1; }

if ! command -v claude >/dev/null 2>&1; then
  say "Claude Code is not installed. Installing it first…"
  curl -fsSL https://claude.ai/install.sh | bash
fi

say "Installing planbridge…"
npm install -g "${PLANBRIDGE_SOURCE:-github:CalaKuad1/planbridge}" >/dev/null

planbridge skill install
planbridge doctor
say "Next:  planbridge start      (or: planbridge autostart on)"
say "Then:  planbridge open       to try the playground"
echo
