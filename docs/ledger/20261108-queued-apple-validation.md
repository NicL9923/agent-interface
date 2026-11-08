# Queued Apple validation

The shared agent-memory lock remains single-slot. Native helpers probe verified
ancestor ownership and fail fast with an older shared helper. The main runner
checks reusable evidence before queuing and after acquiring the lock, fingerprints
uncommitted iOS inputs, and invalidates an earlier pass when a fresh attempt fails.
Live checks, captures, repetitions and external custom inputs run fresh.

At `9ca0c02c3d740d5fc25905f46e60fd0f9e9f134e`, the 16 tests in
`tests/ios_validation_test.py` and the 7 tests in `tests/validate_ios_test.py`
passed. They run the real runner and evidence helper against fake external tools,
with real Git and filesystem state. Ruff passed for the repository. No native app
runs in these Python suites.

The regression tests exposed macOS Bash 3.2 empty-array behavior under `set -u`;
portable array expansions fixed it. Replacing the source digest with a constant
failed the dirty-input reuse test, and removing receipt invalidation failed the
forced-rerun failure test. Both mutations were restored before committing.

Grok 4.7 at high effort reviewed the project changes. Its findings led to moving
the new tests into repository discovery, updating the older runner fixtures and
option expectations, and correcting `ios/README.md`. Native execution also exposed
XCTest already shutting down the selected device. Cleanup now accepts that state,
polls transitional states for at most 30 seconds, and preserves a failed test's
status and summary if cleanup also fails. The cleanup failure regression failed
before the status fix and passed afterward.

With the installed shared helper from agent-memory PR #32, the runner at
`217c1a882dd4804432dec8c8a2c684d172fde8fb` executed 20 PresentationTests with
zero failures on an iPhone Air simulator. The Foundation Apple snapshot and
share-inbox smoke scripts also passed. This is simulator and native-script
evidence, not physical-device verification or full UI-suite coverage.

Logs live under `/Volumes/DevSSD/scratch/apple-validation-rollout-20261108/`.
