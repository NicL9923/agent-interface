#!/bin/bash
# Compile the production Foundation share-inbox code without a simulator or account data.
set -euo pipefail
[[ $# == 1 && -d "$1" ]] || { echo 'Usage: test-share-inbox.sh EXISTING_OUTPUT_DIRECTORY' >&2; exit 2; }
heavy_lock="$HOME/.agents/tools/mac-heavy-lock.sh"
held=0
MAC_HEAVY_LOCK_TIMEOUT=0 "$heavy_lock" --check-held 2>/dev/null || held=$?
case "$held" in
  0) ;;  # Verified ancestor ownership.
  1)
  exec "$heavy_lock" bash "$0" "$@"
    ;;
  *) echo 'Update agent-memory before running this helper; the shared lock needs --check-held support.' >&2; exit 75 ;;
esac
repo=$(cd "$(dirname "$0")/../.." && pwd)
output=$1
xcrun swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
  -module-cache-path "$output/module-cache" \
  "$repo/ios/Shared/ShareInbox.swift" "$repo/tests/share-inbox-checks.swift" -o "$output/checks"
"$output/checks" "$output"
