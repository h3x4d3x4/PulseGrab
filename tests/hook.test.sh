#!/usr/bin/env bash
# Generate the aria2 mover hook from the userscript and exercise it with sh.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
LIB="$T/lib"; mkdir -p "$LIB"
ST="$LIB/.pulsegrab-incoming"
HOOK="$T/hook.sh"

LIB="$LIB" node --input-type=module -e '
import { load } from "./tests/load.mjs";
const h = load(["shQuote", "remoteStagingRoot", "remoteHookScript"], { settings: { remoteLibraryDir: process.env.LIB } });
process.stdout.write(h.remoteHookScript());
' > "$HOOK" || { echo "FAIL: could not generate hook"; exit 1; }

fail=0
ok() { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
run() { sh "$HOOK" 1 1 "$1" 2>"$T/err"; }

if command -v shellcheck >/dev/null; then
  if shellcheck -s sh "$HOOK"; then ok "shellcheck clean"; else echo "note: shellcheck findings above (not failing the test)"; fi
else echo "skip - shellcheck not installed"; fi

# 1. move + .aria2 cleanup
mkdir -p "$ST/TV Shows/X/S1"; echo new > "$ST/TV Shows/X/S1/e1.mkv"; : > "$ST/TV Shows/X/S1/e1.mkv.aria2"
run "$ST/TV Shows/X/S1/e1.mkv"; rc=$?
if [ $rc -eq 0 ] && [ "$(cat "$LIB/TV Shows/X/S1/e1.mkv")" = new ] && [ ! -e "$ST/TV Shows/X/S1/e1.mkv" ] && [ ! -e "$ST/TV Shows/X/S1/e1.mkv.aria2" ]; then ok "moves into library, removes .aria2"; else bad "move (rc=$rc)"; fi

# 2. conflict: original untouched, new copy parked
mkdir -p "$ST/TV Shows/X/S1"; echo newer > "$ST/TV Shows/X/S1/e1.mkv"
run "$ST/TV Shows/X/S1/e1.mkv"; rc=$?
if [ $rc -eq 0 ] && [ "$(cat "$LIB/TV Shows/X/S1/e1.mkv")" = new ] && [ "$(cat "$ST/.conflicts/TV Shows/X/S1/e1.mkv")" = newer ]; then ok "conflict parked in .conflicts"; else bad "conflict (rc=$rc)"; fi

# 3. outside staging: exit 0, nothing touched
echo keep > "$T/outside.mkv"; before=$(find "$LIB" "$T/outside.mkv" -type f -exec cksum {} + | sort)
run "$T/outside.mkv"; rc=$?
after=$(find "$LIB" "$T/outside.mkv" -type f -exec cksum {} + | sort)
if [ $rc -eq 0 ] && [ "$before" = "$after" ]; then ok "outside path ignored"; else bad "outside path (rc=$rc)"; fi

# 4. '..' refused
echo evil > "$T/evil.mkv"
run "$ST/../../evil.mkv"; rc=$?
if [ $rc -ne 0 ] && [ -e "$T/evil.mkv" ] && grep -q refusing "$T/err"; then ok ".. path refused"; else bad ".. path (rc=$rc)"; fi

exit $fail
