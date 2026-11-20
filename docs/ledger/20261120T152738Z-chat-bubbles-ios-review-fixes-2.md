# November 20 chat bubbles on iOS, second review fixes

Branch `t3/chat-bubbles-ios-fixes-2`, from `origin/t3/research-openbot-chat-bubbles` at `20bfd71a`. This fixes three findings from a re-review of the iOS chat style settings, which the reviewer made by reading the code on Linux. Each regression test was written first and run on the unfixed code.

Toolchain: Xcode 27.2 (27B52) and the iPhone 18 Pro Max simulator `270DC27B-4FBD-444E-9EEE-B02E93AA696F` on iOS 27.0. Every run went through `.agents/tools/validate-ios.sh`, which holds the Mac heavy lock. These are simulator runs, not device runs. Logs are in `/Volumes/DevSSD/scratch/chat-bubbles-ios/review-fixes-2/logs/`.

## Commits

| Commit     | Change                                                                                                                                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c3afc5a0` | Every Settings control queues its edit from its binding as the person makes it, naming the chat style choice it sets. `SettingsForm` holds what Settings shows and takes the server's copy only while the queue holds no unsaved edit. `preferencesLastSent` is gone. |
| `87d2b12e` | The stream capture needs a streamed and a saved sample in each style, and finds the saved copy by its time row's identifier, `messageTime-<message id>`, instead of a time label that depends on the simulator's locale and time zone.                                |

## Red runs

`SettingsForm` did not exist before the fix. For the unit tests, the red run used a version of it that copied the old view's logic: an edit showed at once and was queued on a later main-actor turn, as `onChange(of: preferences)` did, behind the old guard that skipped a value equal to the draft or the server's copy, and the server's copy replaced the form whenever no save was out. The old view itself stayed in place, so the UI test ran against the real Settings.

| Finding                                | Guarding test                                                                         | Result on the unfixed code                                                                                                           | Run                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1, change back dropped, Chat style     | `NativeContractTests.testSettingsSavesAChoiceChangedBackToTheSavedOneWhileASaveIsOut` | Red: the last save carried `classic`, the server kept it and the form showed it                                                      | `red.log`, `.private/ios-test-20261120T133536Z-43557.xcresult`    |
| 1, change back dropped, Your messages  | The same test, second case                                                            | Red: `solid` instead of `tint`, in the save, on the server and in the form                                                           | The same                                                          |
| 1, through Settings                    | `TranscriptFlowTests.testAChoiceChangedBackWhileItsSaveIsOutStays`                    | Red: after both saves, Chat style read Classic and Your messages read Solid color, and both reopened that way                        | `red-ui.log`, `.private/ios-test-20261120T150939Z-98290.xcresult` |
| 2a, edit and server copy in one update | `NativeContractTests.testSettingsKeepsAnEditWhenTheServersCopyChangesInTheSameUpdate` | Red: the form went back to Bubbles, and the save went out without `chatStyle`                                                        | `red.log`                                                         |
| 3, capture without a stream            | `TranscriptFlowTests.testStreamedReplySettlesForReview`, fixture sending no chunks    | Red: "bubbles: no sample caught the reply while it streamed; saved samples: 11". The old test, run as a copy in the same run, passed | `red.log`                                                         |

The first UI attempt held each save for 4 seconds and passed on the unfixed view (`trace.log`, `.private/ios-test-20261120T150450Z-91590.xcresult`). A temporary trace written by the app (`settings-trace.txt`) showed why: reopening the menu takes XCTest about 5 seconds, so the change back landed 1.2 seconds after the first save had answered. Its "Saving…" check also passed after the save had ended, so it could not show this. The test now holds each save for 15 seconds and fails unless the change back lands within 12 seconds of the first choice. The rerun on the unfixed view (`settings-trace-red.txt`) shows the change back at 5 seconds with the save still out, the old guard skipping it, and the first save winning.

After the fix, two lines were broken by hand on `87d2b12e` in one run (`red-mutations.log`, `.private/ios-test-20261120T153959Z-38875.xcresult`) and restored with `git checkout -- ios`; `git status` was clean after:

| Break                                                                              | Guarding test                                                     | Result                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| `SettingsForm.resync` takes the server's copy and ignores the queued edit          | `testSettingsKeepsAnEditWhenTheServersCopyChangesInTheSameUpdate` | Red: the form showed Bubbles                                 |
| `SettingsForm.edit` queues only a value unequal to the draft and the server's copy | `testSettingsSavesAChoiceChangedBackToTheSavedOneWhileASaveIsOut` | Red in both cases: the first choice went out last and stayed |

Neither break affects the other test: the first changes only what the form shows after saves, and the second only which edits reach the queue.

## Findings left as they were

**2b, a read that started before a save.** `refreshBootstrap` orders bootstrap reads only against each other (`bootstrapRead > appliedBootstrapRead`), then replaces the whole bootstrap, preferences included. A read that started before a save and answers after it puts the old preferences back until the next refresh. The same probe ran on this branch and on `origin/main` `d6b53105`: hold `/api/bootstrap`, start a refresh, save, release the read.

| Code           | Preference                         | Result                          | Run                                                                                                                             |
| -------------- | ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `origin/main`  | theme `dark`                       | Back to `system` after the read | `main-probe-2b.log`, `/Volumes/DevSSD/scratch/chat-bubbles-ios/main-probe-2b/.private/ios-test-20261120T150338Z-89374.xcresult` |
| Unfixed branch | theme `dark`, chat style `classic` | Back to `system` and Bubbles    | `red.log`                                                                                                                       |

On main the read starts at `ios/AgentInterface/AppStore+Polling.swift:227`, line 228 checks only the read counter, and line 257 replaces the bootstrap (`if bootstrap != value { bootstrap = value; applied = true }`); the save sets `bootstrap?.preferences = saved` at `AppStore+Preferences.swift:13`. `AppStore+Polling.swift` and `AppStore+Session.swift` are unchanged on this branch, and the chat style fields travel in the same `Preferences` value as theme. The bug predates this branch, so the polling code stays as it is. A fix needs saves and reads on one ordering, for example a counter that a preferences save also bumps, so a read that started before the last save leaves `preferences` alone.

**Reauthentication sends the previous member's settings.** On main, `signIn` installs the new token at `AppStore+Session.swift:114` and only then awaits `refreshBootstrap` at line 119. The account switch happens when that read answers, at `AppStore+Polling.swift:252-255`, which calls `resetAccountContent`, and that bumps `generation` and calls `resetPreferenceSaves` (`AppStore+Session.swift:232, 260`). Settings stays open through sign-in: its "Sign in again" button calls `signIn`, and "Retry saving settings" at `PreferencesView.swift:79` queues the form, which still holds member A's preferences. `signIn` clears `sessionExpired` at line 115, so the Display controls enable again. A Retry or any edit between line 114 and the read sends A's whole preferences with B's token. On this branch the save also carries any chat style choice A left queued. The exchange already returns the member (`TokenExchange.user`, `Models.swift:1171`). A fix would compare `result.user.id` with `bootstrap?.user.id` before installing the token and, when they differ, run the account switch first (`clearOfflineLibrary`, `persistDraft`, `resetAccountContent`), so no account-owned write from A can start under B's token. This was confirmed by reading main, not by a run.

## Validation

The full native suite ran on `72f3e024`. This change touches only the preference save path, one UI test and one accessibility identifier, so the run on `87d2b12e`, the last code commit, covers the unit target and the five UI classes that reach Settings or the transcript.

| Part | Scope                                                       | Run | Passed | Failed | Skipped | Result bundle                                       |
| ---- | ----------------------------------------------------------- | --- | ------ | ------ | ------- | --------------------------------------------------- |
| 1    | `AgentInterfaceTests`, the whole unit target                | 842 | 840    | 0      | 2       | `.private/ios-test-20261120T154251Z-43236.xcresult` |
| 1    | `SettingsPolishTests`, `DailyFlowTests`                     | 18  | 18     | 0      | 0       | the same                                            |
| 2    | `TranscriptFlowTests`, `ParityFlowTests`, `NativeFlowTests` | 49  | 46     | 0      | 3       | `.private/ios-test-20261120T181435Z-6967.xcresult`  |

That is 909 tests: 904 passed, none failed and 5 skipped. The skips are the two evidence renderers and three capture-only transcript tests that run only when `AGENT_INTERFACE_SCREENSHOT_DIR` is set. Both known flakes passed: `SettingsPolishTests.testChoosingATalkVoiceSavesItAndSamplesPlayAndStop` and `TranscriptFlowTests.testApprovalScopesTheDeclineHandoffARecommendedAnswerAndSteering`. The first attempt at part 2 was stopped by the 2 hour limit on a background command after 6,637 seconds in the lock queue and about 9 minutes of tests, all passing (`verify-2-stopped.log`). The rerun ran detached.

The stream capture ran with screenshots on the same code before it was split into commits (`green-targeted.log`, `.private/ios-test-20261120T151221Z-2604.xcresult`, frames in `/Volumes/DevSSD/scratch/chat-bubbles-ios/review-fixes-2/shots-green/stream/`). Bubbles caught 16 streaming and 39 saved samples, and Classic caught 16 and 38. The same run passed all 165 `NativeContractTests`, the new Settings test, and the two older chat style Settings tests.

## Not run

VoiceOver, a physical device, an iPad, and the UI classes outside the five named here. `check-all` was not run: it covers the web, server and Python, none of which changed.
