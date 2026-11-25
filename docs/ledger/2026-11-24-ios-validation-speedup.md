# iOS Validation Speedup (`validate-ios.sh` + `ScreenshotTourTests.swift`)

- **Date:** 2026-11-24
- **Branch:** `t3/speed-up-ios-validation`

## Changes

1. `.agents/tools/validate-ios.sh` defaults unfiltered `--allow-full-suite` runs to parallel simulator clones (`-parallel-testing-enabled YES -parallel-testing-worker-count 4`, overridable via `IOS_FULL_SUITE_WORKERS` or explicit `-parallel-testing-enabled NO`) under the whole-Mac lock, while keeping focused `-only-testing:` runs serial under `--sim`.
2. `.agents/tools/validate-ios.sh` resolves linked git worktrees' default `DerivedData` to `<main-checkout>/.private/ios-build-<SIMULATOR_UUID>` (still isolated per simulator and protected by the simulator/whole-Mac lock), so fresh worktrees reuse incremental Swift builds.
3. `ios/AgentInterfaceUITests/ScreenshotTourTests.swift` splits the monolithic 31-test `ScreenshotTourTests` class into base class `ScreenshotTourTestCase` plus 15 balanced `XCTestCase` subclasses (giving each multi-minute Memory and Work Tasks part its own class) so XCTest distributes heavy design-review tours evenly across parallel simulator clones. `.agents/tools/ios-screenshot-tour.sh` lists all 15 subclasses.

## Red-run proof

- Temporarily mutated `default_parallel=1` to `default_parallel=0` in `.agents/tools/validate-ios.sh`.
- Ran `python3 scripts/run-python-tests.py tests/validate_ios_test.py` → exited 1 with 3 failures (`test_full_suite_worker_env_and_worktree_derived_data_sharing`, `test_summary_records_the_effective_build_and_test_options`, `test_the_lock_is_asked_for_what_the_run_uses`).
- Restored `.agents/tools/validate-ios.sh` byte for byte; `tests/validate_ios_test.py`, `tests/ios_validation_test.py`, and `npm run verify:ci` (4,750 Vitest tests) all pass.
