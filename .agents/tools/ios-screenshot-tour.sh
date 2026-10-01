#!/bin/bash
# Run on the Mac mini, using a simulator reserved for this task.
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo 'Usage: bash .agents/tools/ios-screenshot-tour.sh SIMULATOR_UUID OUTPUT_DIR' >&2
  exit 2
fi
simulator_id=$1
mkdir -p "$2"
output_dir=$(cd "$2" && pwd)
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_dir"
mkdir -p .private
result_path=".private/ios-screenshots-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcresult"
# xcodebuild forwards TEST_RUNNER_-prefixed variables to the UI test runner without the prefix.
TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR="$output_dir" \
xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath .private/ios-build \
  -resultBundlePath "$result_path" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= -parallel-testing-enabled NO \
  -only-testing:AgentInterfaceUITests/ScreenshotTourTests test
ls "$output_dir"/*.png
