# November 8 account usage, iOS profile menu and Usage sheet

Code state: branch `t3/account-usage` at `ad4d013` plus uncommitted `ios/` changes,
`source-state.py ios` fingerprint `sha256:437b4ce8bb9a6e035276597edbe3fe66d04d5df12fb9fbe187e52389d12dc8df`
(317 source files). The Mac mini ran a task copy under `/Volumes/DevSSD/scratch/usage-ios`
(throwaway git snapshots `945f4c5`, `c884d03`), rsynced from this checkout, so its commit
hashes are not this branch's. Xcode 27.2 (27B52), iPhone 18 Pro simulator on iOS 27.0,
`.agents/tools/validate-ios.sh` through `mac-heavy-lock.sh`, derived data on DevSSD.
Fixture transport only: no real Hermes, provider or account was read.

## What changed

The home avatar is now a menu (name and email, Usage with the tightest-limit subtitle, Settings,
Sign out through the shared confirmation). Usage is a sheet from the menu and from Go to.
`AccountUsage.swift` ports `src/shared/account-usage.ts`. Debug fixtures serve
`/api/usage/accounts` and its reset route. UI tests that tapped `openSettings` now open the
menu first (`XCUIApplication.openSettingsFromProfileMenu`).

## Application tests

- Unit, run 4 (`AccountUsageTests`, `ContractFixtureTests`, `ShellFeatureTests`): every test passed,
  including the 17 new `AccountUsageTests` and both new contract fixtures.
- `UsageFlowTests` (4 UI tests: menu items and sheet content, reset confirm then outcome,
  sign-out asks first, sheet screenshot): all 4 passed in run `usage10`, on the code state before the
  dark-theme edit below.
- Existing UI tests that open Settings, same run family: `SettingsPolishTests` (9) passed,
  `AppUpdateFlowTests` banner test passed, `ParityFlowTests` Home pins, Not now and Settings failure
  retry passed, `ShellFlowTests` computer and both terminal tests passed.
- Four tests failed identically on a clean `git archive HEAD` export of the branch without these changes (run `base1`) and are not caused by
  this change: `NativeFlowTests.testNativeFailedUpdateOffersGuardedRecovery` (:297),
  `NativeFlowTests.testNativeUpgradeQualificationAndUncertainInstallRecovery` (:191),
  `ParityFlowTests.testComputerRowReportsWhoHasControlAndDisablesWhenUnavailable` (:209),
  `ParityFlowTests.testNotificationPromptAsksIosOnlyAfterEnableAndSettingsSwitchFollows` (:379).
  Their post-menu steps were not exercised, so the menu path into Settings is covered only by the
  tests above.

## Visual checks

Light phone screenshots of the menu, sheet, sheet footer, reset confirmation and result are in
`ios/evidence/usage-*.png`. iOS gives menu items no accessibility identifier, so the tests match them
by label, and a confirmation dialog is a popover here with no Cancel button.

## Not exercised

- Dark appearance. The first dark capture ignored the device appearance (the fixture theme was
  System and the screenshot rendered light), so those files were deleted. `UsageFlowTests` now sets
  `AGENT_INTERFACE_UI_THEME=dark`, but that edit never ran: the Mac mini's DevSSD began returning
  "Interrupted system call" on every access and had not recovered after more than an hour.
- Hand-break proof for the ported logic. `resetWouldBeWasted` was changed from `>= 100` to `> 100` in the
  Mac task copy only, but the run could not start for the same disk fault. The mutated
  `AccountUsage.swift` is still in `/Volumes/DevSSD/scratch/usage-ios`, with the original saved as
  `/Volumes/DevSSD/scratch/AccountUsage.swift.orig`; this checkout is unmutated. The test that should
  go red is `testAResetWouldBeWastedUnlessAnAccountWideLimitIsUsedUp`.
- iPad layout, Dynamic Type sizes, VoiceOver, a real server, Hermes or provider accounts, and a physical phone.

## Follow-up the same day

After the parent's review fixes the iOS side sends a request ID with each reset, keeps it across a failed or
uncertain attempt, drops a read that started before a reset, and refreshes the menu's Usage line once a minute
old. The Mac task copy was resynced from this checkout (snapshot `0e21f6f`, sources byte-identical to the
branch), the DevSSD had recovered, and `validate-ios.sh` on the same iPhone 18 Pro simulator ran
`AccountUsageTests`, `ContractFixtureTests`, `ShellFeatureTests`, `UsageFlowTests` (including the dark
appearance capture) and `SettingsPolishTests`: 71 passed, 0 failed. Removing the read generation check made
`testAReadThatStartedBeforeAResetNeverReplacesTheAccountItChanged` fail (2 banked resets instead of 1); the
check was restored. The earlier `resetWouldBeWasted` hand-break was not rerun.

