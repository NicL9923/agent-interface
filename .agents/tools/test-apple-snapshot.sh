#!/bin/bash
# Exercise the production Foundation model without a simulator or EventKit access.
set -euo pipefail
if [[ $# != 1 || ! -d "$1" ]]; then
  echo 'Usage: test-apple-snapshot.sh EXISTING_OUTPUT_DIRECTORY' >&2
  exit 2
fi
if [[ "${WILDBOTS_APPLE_TEST_LOCKED:-}" != 1 ]]; then
  exec "$HOME/.agents/tools/mac-heavy-lock.sh" env WILDBOTS_APPLE_TEST_LOCKED=1 bash "$0" "$@"
fi
repo=$(cd "$(dirname "$0")/../.." && pwd)
output=$1
xcrun swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
  -module-cache-path "$output/module-cache" \
  "$repo/ios/AgentInterface/AppleSnapshot.swift" "$repo/tests/apple-snapshot-checks.swift" -o "$output/checks"
"$output/checks"
