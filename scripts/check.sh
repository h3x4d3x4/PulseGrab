#!/usr/bin/env bash
# Syntax-check the userscript and run the helper tests (if present).
set -euo pipefail
cd "$(dirname "$0")/.."
node --check releases/PulseGrab.user.js
if [ -d tests ]; then
  node --test tests/*.test.mjs
  bash tests/hook.test.sh
fi
# Headless smoke test against a fake Emby (needs Google Chrome; SKIP_SMOKE=1 to skip).
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
if [ -z "${SKIP_SMOKE:-}" ] && [ -x "$CHROME" ]; then node tests/smoke/run.mjs; fi
echo "check: OK"
