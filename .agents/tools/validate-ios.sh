#!/bin/bash
# Run on the Mac mini, using a simulator reserved for this task.
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo 'Usage: bash .agents/tools/validate-ios.sh SIMULATOR_UUID [test|build|live] [xcodebuild options...]' >&2
  exit 2
fi
simulator_id=$1
operation=${2:-test}
case "$operation" in test|build|live) ;; *) echo 'Choose test, build, or live' >&2; exit 2 ;; esac
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
if [[ $# -ge 2 ]]; then shift 2; else shift; fi
cd "$repo_dir"
state_tool="$repo_dir/.agents/tools/ios-validation-state.py"
request_options=("$@")
inputs_before=$(python3 "$state_tool" key "$operation" "$simulator_id" ${request_options[@]+"${request_options[@]}"})
can_reuse=0
if python3 "$state_tool" eligible "$operation" ${request_options[@]+"${request_options[@]}"}; then
  can_reuse=1
  if [[ ${IOS_VALIDATION_FRESH:-0} != 1 ]] && python3 "$state_tool" lookup "$inputs_before"; then exit 0; fi
fi
# The wrapper verifies real ancestor ownership, including an agent's outer
# wrapper. Re-entry repeats the evidence check after waiting in the queue.
heavy_lock="$HOME/.agents/tools/mac-heavy-lock.sh"
held=0
MAC_HEAVY_LOCK_TIMEOUT=0 "$heavy_lock" --check-held 2>/dev/null || held=$?
case "$held" in
  0) ;;  # Verified ancestor ownership.
  1)
  exec "$heavy_lock" bash "$repo_dir/.agents/tools/validate-ios.sh" "$simulator_id" "$operation" ${request_options[@]+"${request_options[@]}"}
    ;;
  *) echo 'Update agent-memory before running this helper; the shared lock needs --check-held support.' >&2; exit 75 ;;
esac
mkdir -p .private
# A fresh attempt supersedes older evidence even when it fails.
if [[ $operation == test ]]; then python3 "$state_tool" invalidate "$inputs_before"; fi
booted_here=0
cleanup() {
  if [[ $booted_here == 1 ]]; then
    xcrun simctl shutdown "$simulator_id"
    booted_here=0
  fi
}
trap cleanup EXIT

run_id="${operation}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
result_path=".private/ios-${run_id}.xcresult"
# Concurrent runs need separate derived data; IOS_DERIVED_DATA selects it.
derived_data=${IOS_DERIVED_DATA:-.private/ios-build}
destination="platform=iOS Simulator,id=$simulator_id"
build_options=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
if [[ "$operation" == build ]]; then
  xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface -destination "$destination" \
    -derivedDataPath "$derived_data" -resultBundlePath "$result_path" "${build_options[@]}" build "$@"
  inputs_after=$(python3 "$state_tool" key "$operation" "$simulator_id" ${request_options[@]+"${request_options[@]}"})
  [[ $inputs_before == "$inputs_after" ]] || { echo 'iOS inputs changed while building.' >&2; exit 75; }
  exit 0
fi

test_options=()
if [[ "$operation" == live ]]; then
  # This smoke check refuses non-loopback hosts and servers without explicit local test auth.
  node .agents/tools/native-smoke.mjs http://127.0.0.1:3004
  derived_data=${IOS_DERIVED_DATA:-.private/ios-live-build}
  build_options+=('SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG LIVE_HERMES_UI_TESTS')
  test_options+=(-only-testing:AgentInterfaceUITests/LiveConnectionTests)
fi
# Test selection, repetition and parallelism options apply when the tests run; everything else is a build option.
while [[ $# -gt 0 ]]; do
  case "$1" in
    -only-testing:* | -skip-testing:* | -retry-tests-on-failure | -run-tests-until-failure)
      test_options+=("$1"); shift ;;
    -only-testing | -skip-testing | -test-iterations | -test-repetition-relaunch-enabled \
      | -only-test-configuration | -skip-test-configuration | -test-timeouts-enabled \
      | -default-test-execution-time-allowance | -maximum-test-execution-time-allowance \
      | -collect-test-diagnostics | -parallel-testing-enabled | -parallel-testing-worker-count \
      | -maximum-parallel-testing-workers | -maximum-concurrent-test-simulator-destinations \
      | -maximum-concurrent-test-device-destinations)
      if [[ $# -lt 2 ]]; then echo "$1 needs a value" >&2; exit 2; fi
      test_options+=("$1" "$2"); shift 2 ;;
    *) build_options+=("$1"); shift ;;
  esac
done
# Respect explicit caller settings. Enable Xcode's built-in per-test allowance
# instead of choosing an unmeasured custom limit for legitimate long tests.
if [[ " ${test_options[*]-} " != *" -parallel-testing-enabled "* ]]; then
  test_options+=(-parallel-testing-enabled NO)
fi
if [[ " ${test_options[*]-} " != *" -test-timeouts-enabled "* ]]; then
  test_options+=(-test-timeouts-enabled YES)
fi
# After a failure, xcodebuild runs `simctl diagnose`, which stalls on this host for its full ten
# minutes. Pass -collect-test-diagnostics on-failure to collect it anyway.
if [[ " ${test_options[*]-} " != *" -collect-test-diagnostics "* ]]; then
  test_options+=(-collect-test-diagnostics never)
fi

# Quotes each argument so the summary shows values with spaces unambiguously.
shell_words() { local words; words=$(printf '%q ' "$@"); echo "${words% }"; }

# Build once, then run the tests from a copy of the generated test plan that limits XCTest's
# crash-report wait. Without it this host waits about 300 seconds after every UI test.
products="$derived_data/Build/Products"
mkdir -p "$products"
find "$products" -maxdepth 1 -name '*.xctestrun' -delete
xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface -destination "$destination" \
  -derivedDataPath "$derived_data" -resultBundlePath ".private/ios-${run_id}-build.xcresult" \
  "${build_options[@]}" build-for-testing
xctestruns=("$products"/*.xctestrun)
if [[ ${#xctestruns[@]} -ne 1 || ! -f "${xctestruns[0]}" ]]; then
  echo "Expected one .xctestrun in $products after building." >&2
  exit 1
fi
patched="${xctestruns[0]%.xctestrun}-crash-wait.xctestrun"
python3 .agents/tools/patch-xctestrun.py "${xctestruns[0]}" "$patched" 15
# Build-only and build-for-testing do not need a booted simulator. XCTest
# boots the selected device when execution starts; leave pre-existing devices up.
booted_here=$(xcrun simctl list devices booted --json | python3 -c 'import json,sys; groups=json.load(sys.stdin)["devices"]; print(0 if any(d["udid"]==sys.argv[1] for ds in groups.values() for d in ds) else 1)' "$simulator_id")
status=0
xcodebuild test-without-building -xctestrun "$patched" -destination "$destination" \
  -resultBundlePath "$result_path" ${test_options[@]+"${test_options[@]}"} || status=$?
cleanup
inputs_after=$(python3 "$state_tool" key "$operation" "$simulator_id" ${request_options[@]+"${request_options[@]}"})
if [[ $inputs_before != "$inputs_after" ]]; then
  echo "iOS inputs changed while validation ran; these results do not validate one source state." >&2
  status=75
  python3 "$state_tool" invalidate "$inputs_after"
fi

# A summary beside the result bundle lets a later run of the same iOS inputs reuse this result.
summary=".private/ios-${run_id}.txt"
{
  echo "commit: $(git rev-parse HEAD)"
  echo "validated inputs: $inputs_before"
  echo "inputs after run: $inputs_after"
  echo "xcode: $(xcodebuild -version | tr '\n' ' ')"
  echo "simulator: $(xcrun simctl list devices | awk -v id="$simulator_id" '/^-- /{runtime=$2" "$3} index($0, id){sub(/ *\((Booted|Shutdown)\) *$/, ""); sub(/^ +/, ""); print $0", "runtime; exit}')"
  # A different configuration or compiler setting builds a different app, so a reader judging reuse needs these.
  echo "operation: $operation"
  echo "project: ios/AgentInterface.xcodeproj, scheme: AgentInterface"
  echo "destination: $destination"
  echo "derived data: $derived_data"
  echo "build options: $(shell_words "${build_options[@]}")"
  echo "test options: $(shell_words ${test_options[@]+"${test_options[@]}"})"
  echo "exit status: $status"
  echo "result bundle: $result_path"
  xcrun xcresulttool get test-results summary --path "$result_path" --compact 2>/dev/null || echo 'No test summary in the result bundle.'
} > "$summary"
echo "Summary: $summary"
if [[ $status == 0 && $can_reuse == 1 ]]; then
  python3 "$state_tool" record "$inputs_before" "$result_path" "$summary" || echo 'Validation succeeded, but no reusable evidence was recorded.' >&2
fi
exit "$status"
