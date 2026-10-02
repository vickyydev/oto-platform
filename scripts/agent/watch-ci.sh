#!/bin/sh
# Watch the CI run for one exact commit on main.
# Usage: scripts/agent/watch-ci.sh <full-sha> [max-minutes]
# Matches by head SHA, never by title (gh truncates titles). Needs gh auth (GH_TOKEN).
sha="$1"; max="${2:-70}"
[ -n "$sha" ] || { echo "usage: watch-ci.sh <full-sha> [max-minutes]"; exit 2; }
cd "$(git rev-parse --show-toplevel)" || exit 2
i=0
while [ "$i" -lt "$max" ]; do
  line=$(gh run list --branch main --commit "$sha" --limit 1 --json databaseId,status,conclusion,displayTitle --jq '.[0] | "\(.status) \(.conclusion) \(.databaseId) \(.displayTitle)"' 2>/dev/null)
  case "$line" in
    completed*) echo "CI: $line"; exit 0 ;;
    "") echo "no run yet for $sha" ;;
  esac
  i=$((i+1)); sleep 60
done
echo "TIMEOUT after $max min: $line"; exit 1
