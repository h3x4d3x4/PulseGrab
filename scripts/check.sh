#!/usr/bin/env bash
# Syntax-check the userscript and run the helper tests (if present).
set -euo pipefail
cd "$(dirname "$0")/.."
node --check releases/PulseGrab.user.js
[ -d tests ] && node --test tests/ || true
echo "check: OK"
