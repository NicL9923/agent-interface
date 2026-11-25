# November 12 the iOS app's Live Activities switch for this device

Branch `t3/ios-live-activity-setting` over `d8af3980` (`origin/main`), source fingerprint
`sha256:a86e6ad6caecaeed31d38051899d620db4be66e5d0aa11d670637865185f62da`. Written and run on the Mac mini
(macOS 27.0.1, Xcode 27.2 `27B52`, iPhone 18 Pro simulator) through `.agents/tools/validate-ios.sh` under the shared
heavy lock, with Node 24.22.2 for the web checks. These are simulator runs, not device runs. Nothing was deployed and no
Hermes process ran.

## Change

- Settings has a "Live Activities on this device" switch under Notifications. It is stored in `UserDefaults` under
  `liveActivity.enabled`, device-wide rather than per account, so it holds through sign-out and sign-in, and a background
  launch for a pushed start reads it before any account loads. Unset is on.
- Off ends every running activity, then sends `DELETE /native/live-activity` for the update tokens of this account's
  activities and `DELETE /native/live-activity/start`. Sends and foregrounds start nothing. A start the server pushes before
  it hears ends at once, and the start-token removal is sent again. Each foreground while off repeats the removal until
  the server confirms it.
- On registers the push-to-start token again. Switch changes run one after another, so a quick off and on reaches the
  server in that order.
- When iOS Settings has Live Activities off for the app, the switch shows off, is disabled, says so and links to the app's
  iOS Settings page.
- ActivityKit is reached through `LiveActivitySystem`, so the tests stand in for iOS at that edge. No server change.

## Red proof

`/Volumes/DevSSD/scratch/ios-live-activity-setting/mutate.py` broke each line alone, ran the five switch tests through
`validate-ios.sh` with `IOS_VALIDATION_FRESH=1`, restored the file byte for byte and checked it. Every mutant went red
(exit 65):

| Broken line | Red test |
| --- | --- |
| `shouldEnd` drops `!turnedOn` | `testAPushedActivityEndsBesideTheAppsOwnForAnotherAccountOrWithTheSwitchOff` |
| unset switch reads as off | `testTurningLiveActivitiesOffEndsEveryActivityAndForgetsBothTokens` |
| `enabled` ignores the switch | `testWhileLiveActivitiesAreOffNothingStartsAndForegroundsRepeatOnlyTheUnconfirmedRequest` |
| foreground's `guard turnedOn` removed | `testWhileLiveActivitiesAreOff...` |
| off does not end activities | `testTurningLiveActivitiesOff...` |
| off does not remove update tokens | `testTurningLiveActivitiesOff...` |
| off does not remove the start token | `testTurningLiveActivitiesOff...`, `testWhileLiveActivitiesAreOff...`, `testTurningLiveActivitiesOnSendsTheStartTokenOnlyAfterTheOffRequestIsAnswered` |
| `tokensToForget` keeps another account's token | `testTurningLiveActivitiesOff...` |
| start removal never recorded as confirmed | `testWhileLiveActivitiesAreOff...` |
| start removal recorded before the server answers | `testWhileLiveActivitiesAreOff...` |
| switch changes not chained (`await previous?.value`) | `testTurningLiveActivitiesOnSends...` |
| on does not register the start token | `testTurningLiveActivitiesOnSends...` |
| start token ignores iOS Settings | `testWhenIosHasLiveActivitiesOffTheSwitchSaysSoAndNothingRegisters` |
| `LiveActivitySwitch` ignores iOS Settings | `testWhenIosHasLiveActivitiesOff...` |

## Final runs

- `SystemSurfaceTests` and `NativeFeatureTests` in full plus the new UI test: 24 of 25 passed. The one failure,
  `NativeFeatureTests/testRealAvatarRendersToAPicture`, came from the run setup: it writes sample pictures into
  `TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR`, which did not exist yet. It passed in the next run once the folder existed.
- The UI test `SettingsPolishTests/testLiveActivitiesSwitchStaysOffAfterRelaunchAndDefersToIosSettings` passed in light and
  in dark (`TEST_RUNNER_AGENT_INTERFACE_UI_THEME=dark`). It covers the default, turning the switch off, a relaunch and the
  iOS Settings state. Screenshots:
  [on, light](../evidence/ios-live-activities-on-light.png), [on, dark](../evidence/ios-live-activities-on-dark.png),
  [off in iOS Settings, light](../evidence/ios-live-activities-off-in-settings-light.png),
  [off in iOS Settings, dark](../evidence/ios-live-activities-off-in-settings-dark.png).
- `.agents/tools/check-all`: typecheck, lint, ruff, build (894 modules) and e2e (55 tests) passed. `test` had 4 failures in
  3883 tests, all in `direct-routes`, `live-turn-timing`, `native-contract` and `static-cache`. They fail because macOS
  does not answer on `127.0.0.2`, and branch `t3/mac-test-failures` is fixing them. This branch changes no TypeScript and
  no file those tests read.

## Not exercised

ActivityKit itself and APNs: a real activity ending, a pushed start while off, and the token removals reaching a
production server. Those need a signed physical device with the push entitlement. The full iOS UI suite was not run; the
change touches one Settings row and the Live Activity controller.
