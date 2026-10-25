#!/usr/bin/env bash
# Usage: scripts/bump-version.sh 1.4.0
# Updates @version, the README badge/heading and the site badges, then prints
# the release command. The in-app updater reads the GitHub Releases API, so the
# release must be created, not just tagged.
set -euo pipefail
NEW="${1:?usage: bump-version.sh X.Y.Z}"
[[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a version: $NEW" >&2; exit 1; }
cd "$(dirname "$0")/.."
OLD=$(sed -n 's|^// @version *||p' releases/PulseGrab.user.js)
[ -n "$OLD" ] || { echo "no @version found" >&2; exit 1; }
sed -i '' "s|^// @version .*|// @version      $NEW|" releases/PulseGrab.user.js
sed -i '' "s|version-$OLD-brightgreen|version-$NEW-brightgreen|; s|Current Version: \*\*v$OLD\*\*|Current Version: **v$NEW**|" README.md
SITE=../site/index.html
# Site: only the machine-readable version; its badge and changelog section are edited by hand
# (a blanket replace would rename the old release's changelog heading too).
[ -f "$SITE" ] && sed -i '' "s|\"softwareVersion\": \"$OLD\"|\"softwareVersion\": \"$NEW\"|" "$SITE"
echo "Bumped $OLD -> $NEW. Add a README changelog entry, then:"
echo "  gh release create v$NEW releases/PulseGrab.user.js --title 'PulseGrab v$NEW' --notes-file NOTES.md"
