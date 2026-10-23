# October 23 cleanup round 2 validation

This entry covers the #186 fixes on branch `t3/761beee4`, commit `f100e68` on main
`305364e`. Claude Opus 5.5 implemented the change. The native source fingerprint,
`python3 .agents/tools/source-state.py ios/`, is
`sha256:bc843fec1050b062bb93a7dbb156c7590d4d8be8e7315847f7f8c4b9a9070f00` over 217
files. With the runner added, `source-state.py ios/ .agents/tools/validate-ios.sh
.agents/tools/patch-xctestrun.py` gives
`sha256:43e72ddedc8ac84260d60385cbacb1cb8b3e1ac01052bfff995db99dc96b1dce` over 219
files. This is the runner used for the native run, not a fingerprint of the later
script-only fixes. The merged runner fingerprint is
`sha256:3bf7bfcc948bc48fce14a3dcfb773596f9511ec1226c768180290c5dab3d2e99`
over 219 files. Those fixes route explicit parallel-worker limits to test execution
and record effective build options. They leave the native sources and the default
execution command unchanged. Seven isolated fake-CLI tests cover the final script;
four fail against its previous version.

All native runs used the Mac mini with Xcode 27.1 (27A9275) on an iPhone 17 simulator
running iOS 27.0. `validate-ios.sh` held `.private/ios-validation.lock`, ran
`build-for-testing`, then ran `test-without-building` from an xctestrun copy with a
15-second crash-report wait and without failure-time diagnostics.

## Causes

- `NativeFlowTests.testOnboardingValidatesAddressWithoutDroppingEnteredText` tapped
  Continue from a stale frame. While `typeText` types, it hides the software
  keyboard, and the keyboard comes back as typing ends. The layout then moves up
  about 110 points, and the tap landed where the button had been. The failure
  hierarchy had no error banner, and the recording shows the keyboard leaving and
  returning. The app behaved correctly.
- `AutomationFlowTests.testAdvancedRoutineSavesScriptAndKeepsInheritedModel`
  revealed the switch row. A 4-point sliver of the row showed below the sheet's
  navigation bar, so the row counted as hittable while its UISwitch stayed
  covered. The app behaved correctly.

## Application tests

- On unchanged main code, onboarding failed its run, and the routine test failed
  on the second iteration of a run-until-failure loop. A first attempt that waited
  for the keyboard before typing still failed onboarding 6 of 6.
- After the fix, at the runner fingerprint above, each test passed 6 of 6 runs.
- The full scheme at `f100e68` passed: 391 unit tests with 2 evidence-only skips,
  and 63 UI cases with 2 skips (`ScreenshotTourTests` and the iPad-only
  `TabletPresentationTests`). The result bundle reports 454 cases, 450 passed,
  4 skipped and 0 failures. The UI suite took 28 minutes.
- `npm run test:py -- tests/patch_xctestrun_test.py` and ruff passed.

Not exercised: `LiveConnectionTests` against a real Hermes, physical phones and
APNs delivery.

## Combined branch

The combined implementation is `5ff29c6`, with source fingerprint
`sha256:68f75f6e0e2a80860722067826a511537fb6cca39b899f3c9f5065dad03ded90`
over 1,066 files. Ledger entries do not affect that fingerprint. The iOS-only
fingerprint above matches this branch exactly, so the full native result applies
to its compiled native sources. The simulator was shut down and the shared lock
released after the run.

- `npm run typecheck`, `npm test` on Node 26.10.0, and `npm run build` passed at
  `7e662fc`. All 88 Vitest files, 1,023 tests, passed. Only the validation script,
  its new Python tests and its tool-index description changed afterward; application
  inputs are unchanged.
- The exact production-version command, `PATH=/opt/homebrew/opt/node@24/bin:$PATH
  node node_modules/vitest/vitest.mjs run`, passed at `5ff29c6` on Node 24.21.0:
  88 files and 1,023 tests.
- `TMPDIR=/Volumes/DevSSD/scratch/agent-interface-cleanup-r2/tmp npm run test:py`
  passed at `5ff29c6`: 32 files, no skips or failures, Python 3.14.7. `tmux` was
  installed locally so the real PTY/reconnect test ran instead of skipping.
- `npm run lint:py`, Bash syntax and diff whitespace checks passed.
- GPT-6.1 Sol independently reviewed the Claude implementation at high reasoning
  effort. The server review found no actionable issue. Two web findings, a stale
  room reload and stale automation error, and two native-script findings, lost
  worker limits and incomplete build metadata, were fixed with regression tests.
  Separate second rounds found no further issue.

## Visual and integration checks

An agent exercised goal resume/pause, task creation/start, a skill-diff review and
immediate group-message visibility in the local fixture using Playwright WebKit.
No page errors or automation-panel overflow appeared. Screenshots and local logs
are retained under `/Volumes/DevSSD/scratch/agent-interface-cleanup-r2`.
The shared preview opened, but snapshots timed out twice; the documented WebKit
fallback completed the interaction checks. This fixture does not establish real
Hermes behavior. No host qualification, deployment, physical-phone acceptance or
APNs delivery was performed in this round.
