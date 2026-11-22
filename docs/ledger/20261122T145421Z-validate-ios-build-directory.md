# A test builds in its own simulator's directory

Recorded 2026-11-22. The Mac mini's lock runs tests on different simulators together, and a build beside a
test. `validate-ios.sh` built every run in `.private/ios-build` unless the caller set `IOS_DERIVED_DATA`, and
it deletes the directory's `.xctestrun` files before each build. Two runs from one checkout could delete each
other's test plan or overwrite each other's products. The independent review of this branch found it by
reading the script and running the lock's admission logic. Nobody saw it happen on the Mac, because agents
gave each concurrent run its own checkout.

## What changed

- A `test` run builds in `.private/ios-build-SIMULATOR_UUID`. The lock runs one job at a time on a simulator,
  so no two runs share that directory.
- A `build` run keeps `.private/ios-build`. The lock runs one build at a time.
- A `live` run keeps `.private/ios-live-build`. It has the whole Mac.
- `IOS_DERIVED_DATA` still overrides all three.

A checkout's first test on each simulator compiles from scratch once. Tests on two simulators no longer share
build products.

## Red run

`derived_data` for a test was set back to `.private/ios-build` by hand in `.agents/tools/validate-ios.sh`,
`tests/validate_ios_test.py` was run, and the file was restored byte for byte. Unmutated: 10 tests, OK.

| Mutant                                | Failing tests                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A test builds in the shared directory | `test_a_test_builds_apart_from_a_build_in_the_same_checkout` (`operation='test'`); the summary's test |

`tools/mutate-py.py` handles Python files only, so the mutation was a hand edit of the shell script.

## Not run

No Mac run. The change is a path, and the fake `xcodebuild` in the tests records the path each call receives.
The first native run on this branch after this commit is its first real use.
