#!/bin/bash
# Run on the Mac mini, using a simulator reserved for this task.
set -euo pipefail
if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo 'Usage: bash .agents/tools/validate-ios.sh SIMULATOR_UUID [test|build|live]' >&2
  exit 2
fi
simulator_id=$1
operation=${2:-test}
case "$operation" in test|build|live) ;; *) echo 'Choose test, build, or live' >&2; exit 2 ;; esac
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo_dir"
mkdir -p .private
result_path=".private/ios-${operation}-$(date -u +%Y%m%dT%H%M%SZ)-$$.xcresult"
derived_data=.private/ios-build
extra_options=(-parallel-testing-enabled NO)
if [[ "$operation" == live ]]; then
  # This smoke check refuses non-loopback hosts and servers without explicit local test auth.
  node .agents/tools/native-smoke.mjs http://127.0.0.1:3004
  derived_data=.private/ios-live-build
  extra_options+=(-only-testing:AgentInterfaceUITests/LiveConnectionTests 'SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG LIVE_HERMES_UI_TESTS')
  operation=test
fi
xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface \
  -destination "platform=iOS Simulator,id=$simulator_id" \
  -derivedDataPath "$derived_data" \
  -resultBundlePath "$result_path" CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- \
  DEVELOPMENT_TEAM= "${extra_options[@]}" "$operation"
