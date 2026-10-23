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
# Every checkout and worktree shares one lock in the main checkout, because they share the simulators.
lock="$(cd "$(git -C "$repo_dir" rev-parse --git-common-dir)/.." && pwd)/.private/ios-validation.lock"
if [[ "${IOS_VALIDATION_LOCKED:-}" != "$lock" ]]; then
  mkdir -p "$(dirname "$lock")"
  status=0
  IOS_VALIDATION_LOCKED=$lock lockf -k -t 0 "$lock" bash "$0" "$@" || status=$?
  if [[ $status -eq 75 ]]; then
    echo "Another iOS validation holds $lock. This script takes the lock itself, so do not wrap it in lockf." >&2
  fi
  exit "$status"
fi
if [[ $# -ge 2 ]]; then shift 2; else shift; fi
cd "$repo_dir"
mkdir -p .private

# Each booted simulator runs hundreds of processes, and four exhausted the per-user process limit.
booted=$(xcrun simctl list devices booted | grep -c '(Booted)' || true)
if xcrun simctl list devices booted | grep -q "($simulator_id)"; then
  was_booted=1
else
  was_booted=0
  if [[ $booted -ge 3 ]]; then
    echo "$booted simulators are already booted. Shut one down before booting another." >&2
    exit 1
  fi
fi
shut_down_simulator() {
  if [[ $was_booted -eq 0 ]]; then xcrun simctl shutdown "$simulator_id" >/dev/null 2>&1 || true; fi
}
trap shut_down_simulator EXIT

run_id="${operation}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
result_path=".private/ios-${run_id}.xcresult"
# Concurrent runs need separate derived data; IOS_DERIVED_DATA selects it.
derived_data=${IOS_DERIVED_DATA:-.private/ios-build}
destination="platform=iOS Simulator,id=$simulator_id"
build_options=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
if [[ "$operation" == build ]]; then
  xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface -destination "$destination" \
    -derivedDataPath "$derived_data" -resultBundlePath "$result_path" "${build_options[@]}" build "$@"
  exit 0
fi

test_options=(-parallel-testing-enabled NO)
if [[ "$operation" == live ]]; then
  # This smoke check refuses non-loopback hosts and servers without explicit local test auth.
  node .agents/tools/native-smoke.mjs http://127.0.0.1:3004
  derived_data=${IOS_DERIVED_DATA:-.private/ios-live-build}
  build_options+=('SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG LIVE_HERMES_UI_TESTS')
  test_options+=(-only-testing:AgentInterfaceUITests/LiveConnectionTests)
fi
# Test selection and repetition options apply when the tests run; everything else is a build option.
while [[ $# -gt 0 ]]; do
  case "$1" in
    -only-testing:* | -skip-testing:* | -retry-tests-on-failure | -run-tests-until-failure)
      test_options+=("$1"); shift ;;
    -only-testing | -skip-testing | -test-iterations | -test-repetition-relaunch-enabled \
      | -only-test-configuration | -skip-test-configuration | -test-timeouts-enabled \
      | -default-test-execution-time-allowance | -maximum-test-execution-time-allowance \
      | -collect-test-diagnostics | -parallel-testing-enabled)
      if [[ $# -lt 2 ]]; then echo "$1 needs a value" >&2; exit 2; fi
      test_options+=("$1" "$2"); shift 2 ;;
    *) build_options+=("$1"); shift ;;
  esac
done
# After a failure, xcodebuild runs `simctl diagnose`, which stalls on this host for its full ten
# minutes. Pass -collect-test-diagnostics on-failure to collect it anyway.
if [[ " ${test_options[*]} " != *" -collect-test-diagnostics "* ]]; then
  test_options+=(-collect-test-diagnostics never)
fi

# The fingerprint covers uncommitted edits. A run whose inputs changed under it tests neither state.
inputs() { python3 .agents/tools/source-state.py ios/ .agents/tools/validate-ios.sh .agents/tools/patch-xctestrun.py; }
inputs_before=$(inputs)
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
status=0
xcodebuild test-without-building -xctestrun "$patched" -destination "$destination" \
  -resultBundlePath "$result_path" "${test_options[@]}" || status=$?

# A summary beside the result bundle lets a later run of the same iOS inputs reuse this result.
summary=".private/ios-${run_id}.txt"
{
  echo "commit: $(git rev-parse HEAD)"
  inputs_after=$(inputs)
  if [[ "$inputs_after" == "$inputs_before" ]]; then
    echo "ios inputs: $inputs_before"
  else
    echo "ios inputs: changed during the run, from $inputs_before to $inputs_after. Do not reuse this result."
  fi
  echo "xcode: $(xcodebuild -version | tr '\n' ' ')"
  echo "simulator: $(xcrun simctl list devices | awk -v id="$simulator_id" '/^-- /{runtime=$2" "$3} index($0, id){sub(/ *\((Booted|Shutdown)\) *$/, ""); sub(/^ +/, ""); print $0", "runtime; exit}')"
  echo "options: ${test_options[*]}"
  echo "exit status: $status"
  echo "result bundle: $result_path"
  xcrun xcresulttool get test-results summary --path "$result_path" --compact 2>/dev/null || echo 'No test summary in the result bundle.'
} > "$summary"
echo "Summary: $summary"
exit "$status"
