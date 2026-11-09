# November 9 iOS baseline test fixes

Branch `fix-ios-baseline-tests`, based on `origin/main` at `7a1f782`. Swift edited on Linux; built and run on the
Mac mini.

## What changed

Two `AgentInterfaceTests` failed on `main`. Both rule tests caught real drift from #276, which added account usage:

- `NativeContractTests/testTheObservedListNamesEveryTrackedProperty`: `AppStore.accountUsage` is tracked by
  Observation but was missing from `observedForTests`. It is now listed.
- `FixedWaitRuleTests/testEveryFixedSleepSaysWhyItIsNotABoundedWait`: `AccountUsageTests.swift` polled with
  `Task.sleep` in two loops that waited for a request to arrive. They now use `until`. The old loops gave up
  silently after 2 s; `until` fails the test on timeout.

## Checks that ran

Both tests failed on `main` at `7a1f782`, on the Mac mini, earlier on November 9 (PR #284 and #285 runs). That is the
red half of the proof. The Mac mini results for this branch are below.

Simulator-verified at `1f873b2` on the Mac mini, iPhone 18 Pro, iOS 27, through `validate-ios.sh`. The full
`AgentInterfaceTests` target ran 733 tests: 0 failures, and 2 skipped (`testRenderPropEvidence` and
`testRenderEvidence`, which need `AGENT_INTERFACE_EVIDENCE_DIR`). Both rule tests and all 20 `AccountUsageTests` passed.
`AccountUsageTests` ran twice more with no failures, so the `until` waits did not flake in 3 runs.
