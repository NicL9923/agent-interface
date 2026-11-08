#!/bin/bash
# Run on the Mac mini, using a simulator reserved for this task.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'Usage: bash .agents/tools/ios-screenshot-tour.sh SIMULATOR_UUID OUTPUT_DIR' >&2
  exit 2
fi
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
simulator_id=$1
mkdir -p "$2"
output_dir=$(cd "$2" && pwd)
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_dir"
# Capture is an explicit fresh run. Share the normal runner's ownership,
# diagnostic limits and selected-device cleanup instead of duplicating them.
IOS_VALIDATION_FRESH=1 TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR="$output_dir" \
  bash "$repo_dir/.agents/tools/validate-ios.sh" "$simulator_id" test \
    -only-testing:AgentInterfaceUITests/ScreenshotTourTests
ls "$output_dir"/*.png
