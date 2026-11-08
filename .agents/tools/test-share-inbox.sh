#!/bin/bash
# Compile the production Foundation share-inbox code without a simulator or account data.
set -euo pipefail
[[ $# == 1 && -d "$1" ]] || { echo 'Usage: test-share-inbox.sh EXISTING_OUTPUT_DIRECTORY' >&2; exit 2; }
if [[ "${WILDBOTS_SHARE_TEST_LOCKED:-}" != 1 ]]; then
  exec "$HOME/.agents/tools/mac-heavy-lock.sh" env WILDBOTS_SHARE_TEST_LOCKED=1 bash "$0" "$@"
fi
repo=$(cd "$(dirname "$0")/../.." && pwd)
output=$1
xcrun swiftc -swift-version 6 -strict-concurrency=complete -parse-as-library \
  -module-cache-path "$output/module-cache" \
  "$repo/ios/Shared/ShareInbox.swift" "$repo/tests/share-inbox-checks.swift" -o "$output/checks"
"$output/checks" "$output"
