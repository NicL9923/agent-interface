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
# The machine-wide lock covers the build and the complete simulator lifetime.
if [[ "${WILDBOTS_NATIVE_LOCKED:-}" != "1" ]]; then
  exec "$HOME/.agents/tools/mac-heavy-lock.sh" env WILDBOTS_NATIVE_LOCKED=1 bash "$0" "$@"
fi
if [[ $# -ge 2 ]]; then shift 2; else shift; fi
cd "$repo_dir"
# Simulator state remains on the internal Data volume even when builds are on SSD.
# Keep a conservative 5 GiB reserve and fail before any simulator or build command.
python3 -c 'import os, sys; s = os.statvfs("/System/Volumes/Data"); free = s.f_bavail * s.f_frsize; minimum = 5 * 1024**3; print(f"Internal Data headroom: {free / 1024**3:.2f} GiB available; 5 GiB required."); sys.exit(0 if free >= minimum else "Not enough internal disk space for iOS validation. Free space before retrying; no simulator or build command has started.")'
mkdir -p .private

# Xcode's simctl shim can stall in its first-launch version check. Use the
# installed CoreSimulator tool directly when available.
simctl=(/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl)
if [[ ! -x "${simctl[0]}" ]]; then simctl=(xcrun simctl); fi
# A prior interrupted capture may have left a simulator booted. The lock keeps
# other native jobs out while this run shuts it down and uses one device.
"${simctl[@]}" shutdown all >/dev/null 2>&1 || true
shut_down_simulator() {
  "${simctl[@]}" shutdown "$simulator_id" >/dev/null 2>&1 || true
}
trap shut_down_simulator EXIT
"${simctl[@]}" boot "$simulator_id"
"${simctl[@]}" bootstatus "$simulator_id" -b

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
# After a failure, xcodebuild runs `simctl diagnose`, which stalls on this host for its full ten
# minutes. Pass -collect-test-diagnostics on-failure to collect it anyway.
if [[ " ${test_options[*]} " != *" -collect-test-diagnostics "* ]]; then
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
status=0
xcodebuild test-without-building -xctestrun "$patched" -destination "$destination" \
  -resultBundlePath "$result_path" "${test_options[@]}" || status=$?

# A summary beside the result bundle lets a later run of the same iOS inputs reuse this result.
summary=".private/ios-${run_id}.txt"
{
  echo "commit: $(git rev-parse HEAD)"
  echo "xcode: $(xcodebuild -version | tr '\n' ' ')"
  echo "simulator: $("${simctl[@]}" list devices | awk -v id="$simulator_id" '/^-- /{runtime=$2" "$3} index($0, id){sub(/ *\((Booted|Shutdown)\) *$/, ""); sub(/^ +/, ""); print $0", "runtime; exit}')"
  # A different configuration or compiler setting builds a different app, so a reader judging reuse needs these.
  echo "operation: $operation"
  echo "project: ios/AgentInterface.xcodeproj, scheme: AgentInterface"
  echo "destination: $destination"
  echo "derived data: $derived_data"
  echo "build options: $(shell_words "${build_options[@]}")"
  echo "test options: $(shell_words "${test_options[@]}")"
  echo "exit status: $status"
  echo "result bundle: $result_path"
  xcrun xcresulttool get test-results summary --path "$result_path" --compact 2>/dev/null || echo 'No test summary in the result bundle.'
} > "$summary"
echo "Summary: $summary"
exit "$status"
