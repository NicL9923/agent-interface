#!/bin/bash
# Run on the Mac mini, using a simulator reserved for this task.
set -euo pipefail
if [[ $# -lt 1 ]]; then
  echo 'Usage: bash .agents/tools/validate-ios.sh SIMULATOR_UUID [test [--allow-full-suite]|build|live] [xcodebuild options...]' >&2
  exit 2
fi
simulator_id=$1
operation=${2:-test}
case "$operation" in test|build|live) ;; *) echo 'Choose test, build, or live' >&2; exit 2 ;; esac
repo_dir=$(cd "$(dirname "$0")/../.." && pwd)
if [[ $# -ge 2 ]]; then shift 2; else shift; fi
allow_full_suite=()
if [[ $operation == test && ${1-} == --allow-full-suite ]]; then
  allow_full_suite=("$1")
  shift
fi
request_options=("$@")
build_options=(CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
test_options=()
if [[ "$operation" == live ]]; then
  build_options+=('SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG LIVE_HERMES_UI_TESTS')
  test_options+=(-only-testing:AgentInterfaceUITests/LiveConnectionTests)
fi
# Test selection, repetition and parallelism options apply when the tests run; everything else is a build option.
has_test_selection=0
explicit_parallel=""
has_worker_option=0
while [[ $operation != build && $# -gt 0 ]]; do
  case "$1" in
    -only-testing:*)
      selection=${1#-only-testing:}
      if [[ $selection != [-@]* && $selection == *[![:space:]]* ]]; then
        has_test_selection=1
      fi
      test_options+=("$1"); shift ;;
    -skip-testing:* | -retry-tests-on-failure | -run-tests-until-failure)
      test_options+=("$1"); shift ;;
    -only-testing | -skip-testing | -test-iterations | -test-repetition-relaunch-enabled \
      | -only-test-configuration | -skip-test-configuration | -test-timeouts-enabled \
      | -default-test-execution-time-allowance | -maximum-test-execution-time-allowance \
      | -collect-test-diagnostics | -parallel-testing-enabled | -parallel-testing-worker-count \
      | -maximum-parallel-testing-workers | -maximum-concurrent-test-simulator-destinations \
      | -maximum-concurrent-test-device-destinations)
      if [[ $# -lt 2 ]]; then echo "$1 needs a value" >&2; exit 2; fi
      if [[ $1 == -only-testing && $2 != [-@]* && $2 == *[![:space:]]* ]]; then
        has_test_selection=1
      elif [[ $1 == -parallel-testing-enabled ]]; then
        explicit_parallel=$(printf '%s' "$2" | tr '[:lower:]' '[:upper:]')
      elif [[ $1 == -parallel-testing-worker-count || $1 == -maximum-parallel-testing-workers ]]; then
        has_worker_option=1
      fi
      test_options+=("$1" "$2"); shift 2 ;;
    *) build_options+=("$1"); shift ;;
  esac
done
if [[ $operation == test && ${allow_full_suite[0]-} == "" && $has_test_selection == 0 ]]; then
  echo 'iOS test needs an inline test selection. Pass -only-testing:Target/Class/test or --allow-full-suite immediately after test.' >&2
  exit 2
fi
default_parallel=0
full_suite_workers=${IOS_FULL_SUITE_WORKERS:-4}
if [[ $operation == test && ${allow_full_suite[0]-} == --allow-full-suite && $has_test_selection == 0 && -z "$explicit_parallel" ]]; then
  if [[ $has_worker_option == 0 && ! $full_suite_workers =~ ^[1-9][0-9]*$ ]]; then
    echo "IOS_FULL_SUITE_WORKERS must be a positive integer: $full_suite_workers" >&2
    exit 2
  fi
  default_parallel=1
fi
cd "$repo_dir"
# Forward shared fixtures to XCTest, while allowing callers to select an alternate fixture.
for fixture in "$repo_dir"/.agents/fixtures/*.json; do
  [[ -f "$fixture" ]] || continue
  name=$(basename "$fixture" .json)
  name=${name%-design}
  name=$(printf '%s' "$name" | tr '[:lower:]-' '[:upper:]_')
  variable="TEST_RUNNER_AGENT_INTERFACE_DESIGN_${name}_PATH"
  if [[ ! ${!variable+x} ]]; then export "$variable=$fixture"; fi
done
state_tool="$repo_dir/.agents/tools/ios-validation-state.py"
source_before=$(python3 "$state_tool" source)
inputs_before=$(python3 "$state_tool" key "$operation" "$simulator_id" ${request_options[@]+"${request_options[@]}"})
can_reuse=0
if python3 "$state_tool" eligible "$operation" ${request_options[@]+"${request_options[@]}"}; then
  can_reuse=1
  if [[ ${IOS_VALIDATION_FRESH:-0} != 1 ]] && python3 "$state_tool" lookup "$inputs_before"; then exit 0; fi
fi
# The machine lock shares the Mac with a job that says what it uses. A test confined to this simulator names it, and
# a build boots nothing. A live run binds a fixed port, and parallel testing or another destination boots devices
# this helper cannot name, so those runs keep the whole Mac.
lock_scope=()
case "$operation" in
  test) lock_scope=(--sim "$simulator_id") ;;
  build) lock_scope=(--build) ;;
esac
if [[ $default_parallel == 1 ]]; then
  lock_scope=()
fi
for ((i = 0; i < ${#request_options[@]}; i++)); do
  case "${request_options[i]}" in
    -destination | -parallel-testing-worker-count | -maximum-parallel-testing-workers \
      | -maximum-concurrent-test-simulator-destinations)
      lock_scope=() ;;
    -parallel-testing-enabled)
      parallel=$(printf '%s' "${request_options[i + 1]-}" | tr '[:lower:]' '[:upper:]')
      [[ $parallel != YES ]] || lock_scope=() ;;
  esac
done
# The wrapper verifies real ancestor ownership, including an agent's outer wrapper, and that the hold covers this
# scope. Re-entry repeats the evidence check after waiting in the queue.
heavy_lock="$HOME/.agents/tools/mac-heavy-lock.sh"
held=0
MAC_HEAVY_LOCK_TIMEOUT=0 "$heavy_lock" --check-held ${lock_scope[@]+"${lock_scope[@]}"} 2>/dev/null || held=$?
case "$held" in
  0) ;;  # Verified ancestor ownership that covers this scope.
  1)
  exec "$heavy_lock" ${lock_scope[@]+"${lock_scope[@]}"} bash "$repo_dir/.agents/tools/validate-ios.sh" "$simulator_id" "$operation" ${allow_full_suite[@]+"${allow_full_suite[@]}"} ${request_options[@]+"${request_options[@]}"}
    ;;
  *) echo 'Update agent-memory before running this helper; the shared lock needs scoped --check-held support.' >&2; exit 75 ;;
esac
mkdir -p .private
# A fresh attempt supersedes older evidence even when it fails.
if [[ $operation == test ]]; then python3 "$state_tool" invalidate "$inputs_before"; fi
booted_here=0
cleanup() {
  [[ $booted_here == 1 ]] || return 0
  booted_here=0
  local deadline=$((SECONDS + 30)) device_state
  while (( SECONDS < deadline )); do
    device_state=$(xcrun simctl list devices available --json | python3 -c 'import json,sys; groups=json.load(sys.stdin)["devices"]; print(next(d["state"] for ds in groups.values() for d in ds if d["udid"]==sys.argv[1]))' "$simulator_id")
    case "$device_state" in
      Shutdown) return 0 ;;
      Booted|Booting)
        if xcrun simctl shutdown "$simulator_id"; then continue; fi
        ;;
      "Shutting Down") ;;
      *) echo "Cannot clean up selected simulator in state $device_state" >&2; return 1 ;;
    esac
    sleep 1
  done
  echo "Selected simulator did not shut down within 30 seconds: $simulator_id" >&2
  return 1
}
trap cleanup EXIT

run_id="${operation}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
result_path=".private/ios-${run_id}.xcresult"
# Two runs that share derived data delete each other's test plans and overwrite each other's products. The machine
# lock runs tests on different simulators together, so a test builds in its own simulator's directory. Linked git
# worktrees share the main checkout's per-simulator directory so fresh worktrees reuse incremental Swift builds
# under the same simulator lock. Builds run one at a time on the Mac, and a live run has the Mac to itself.
# IOS_DERIVED_DATA overrides the choice.
git_common=$(git rev-parse --git-common-dir 2>/dev/null || true)
common_root="$repo_dir"
if [[ -n "$git_common" ]]; then
  if [[ "$git_common" != /* ]]; then git_common="$repo_dir/$git_common"; fi
  common_root=$(cd "$git_common/.." && pwd)
fi
if [[ "$common_root" != "$repo_dir" ]]; then
  derived_base="$common_root/.private"
else
  derived_base=".private"
fi
case "$operation" in
  test) derived_data=${IOS_DERIVED_DATA:-$derived_base/ios-build-$simulator_id} ;;
  live) derived_data=${IOS_DERIVED_DATA:-$derived_base/ios-live-build} ;;
  *) derived_data=${IOS_DERIVED_DATA:-$derived_base/ios-build} ;;
esac
destination="platform=iOS Simulator,id=$simulator_id"
if [[ "$operation" == build ]]; then
  xcodebuild -project ios/AgentInterface.xcodeproj -scheme AgentInterface -destination "$destination" \
    -derivedDataPath "$derived_data" -resultBundlePath "$result_path" "${build_options[@]}" build "$@"
  inputs_after=$(python3 "$state_tool" key "$operation" "$simulator_id" ${request_options[@]+"${request_options[@]}"})
  [[ $inputs_before == "$inputs_after" ]] || { echo 'iOS inputs changed while building.' >&2; exit 75; }
  exit 0
fi

if [[ "$operation" == live ]]; then
  # This smoke check refuses non-loopback hosts and servers without explicit local test auth.
  node .agents/tools/native-smoke.mjs http://127.0.0.1:3004
fi
# Respect explicit caller settings. Full-suite runs fan out across cloned simulators by default; focused
# runs stay serial to avoid simulator clone overhead and keep per-simulator lock sharing. Enable Xcode's
# built-in per-test allowance instead of choosing an unmeasured custom limit for legitimate long tests.
if [[ -z "$explicit_parallel" ]]; then
  if [[ $default_parallel == 1 ]]; then
    test_options+=(-parallel-testing-enabled YES)
    if [[ $has_worker_option == 0 ]]; then
      test_options+=(-parallel-testing-worker-count "$full_suite_workers")
    fi
  else
    test_options+=(-parallel-testing-enabled NO)
  fi
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
build_args=(-project ios/AgentInterface.xcodeproj -scheme AgentInterface -destination "$destination"
  -derivedDataPath "$derived_data" -resultBundlePath ".private/ios-${run_id}-build.xcresult"
  "${build_options[@]}" build-for-testing)
xcodebuild "${build_args[@]}"
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
test_args=(test-without-building -xctestrun "$patched" -destination "$destination"
  -resultBundlePath "$result_path" ${test_options[@]+"${test_options[@]}"})
xcodebuild "${test_args[@]}" || status=$?
cleanup_status=0
cleanup || cleanup_status=$?
if [[ $status == 0 && $cleanup_status != 0 ]]; then status=$cleanup_status; fi
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
  echo "cleanup exit status: $cleanup_status"
  echo "result bundle: $result_path"
  xcrun xcresulttool get test-results summary --path "$result_path" --compact 2>/dev/null || echo 'No test summary in the result bundle.'
} > "$summary"
echo "Summary: $summary"
if [[ $status == 0 && $can_reuse == 1 ]]; then
  if [[ $(python3 "$state_tool" source) != "$source_before" ]]; then
    echo 'iOS inputs changed while validation ran.' >&2
    status=75
  elif ! python3 "$state_tool" record "$inputs_before" "$source_before" "$result_path" "$summary" "${build_args[@]}" --test-invocation-- "${test_args[@]}"; then
    echo 'Validation succeeded, but no reusable evidence was recorded.' >&2
    if [[ $(python3 "$state_tool" source) != "$source_before" ]]; then status=75; fi
  fi
fi
exit "$status"
