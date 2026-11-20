# November 20 chat bubbles on iOS

Branch `t3/chat-bubbles-ios`, from origin/main `18b9699a`. The native app shows an assistant's reply prose in bubbles and keeps tables, code, rules, inline UI and cards at the full column width. Each person picks Bubbles or Classic and Tinted or Solid color for their own messages, saved as the optional `Preferences.chatStyle` and `Preferences.ownBubble`. The web client and server change in parallel on another branch.

Toolchain: Xcode 27.2 (27B52), iPhone 18 Pro Max simulator `270DC27B-4FBD-444E-9EEE-B02E93AA696F` and iPad Pro 11-inch (M5) simulator `A068DC6D-AB48-467D-A9D0-0564DE3D3840`, both iOS 27.0 (24A434). Every run went through `.agents/tools/validate-ios.sh`, which holds the Mac heavy lock. These are simulator runs, not device runs.

## New tests

`ChatBubblesTests` (14 tests) covers the block grouping as a pure function (prose only, a table between prose, code first, a rule, cards, a streaming reply at every seventh character and an empty reply), preference decoding with the fields absent, valid and unknown, encoding of a chosen value, and the solid fill: white text at 4.5:1 or better for the nine avatar colors, every hue at full sRGB chroma and four grays, the 0.52 lightness the web shares, and the drawn-avatar condition. `NativeContractTests.testSettingsSaveSendsChatStyleChoices` sends both choices through the queued settings save and reads them back. `TranscriptFlowTests.testChatStyleSettingSwitchesTheTranscript` switches to Classic in Settings, checks the reply leaves its bubble, and reopens Settings to the saved choice. `testChatBubbleScreens` only captures screenshots and skips unless `AGENT_INTERFACE_SCREENSHOT_DIR` is set.

## Red runs

Each mutation was applied by hand to the committed source, run with `IOS_VALIDATION_FRESH=1` against the test that guards it, and restored with `git checkout`; `git status` was clean after each. Logs are in `/Volumes/DevSSD/scratch/chat-bubbles-ios/red/`.

| Mutation                                         | Guarding test                                                                                               | Result                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tables count as prose in `ReplyBubbles.isProse`  | `testTablesCodeAndRulesStayOutsideBubbles`, `testAStreamingReplyGroupsAsItWillOnceSettled`                  | Red: `["bubble 3"]` against `["bubble 1", "table", "bubble 1"]`                           |
| An unknown or absent chat style reads as Classic | `testAServerWithoutChatStylesReadsAsBubblesAndTint`, `testAnUnknownChoiceReadsAsTheDefaultAndSurvivesASave` | Red: `classic` is not `bubbles`                                                           |
| Lightness cap 0.72 instead of 0.52               | `testSolidFillKeepsTheHueAndLeavesDarkColorsAlone`                                                          | Green on the first test version (see below), red after: #1084FE became #0074E4 at L 0.570 |
| A portrait avatar still tints                    | `testOnlyADrawnAvatarTintsTheBubble`                                                                        | Red: "A portrait keeps the tint"                                                          |
| A streaming bubble reports every block settled   | `testAStreamingBubbleMarksItsGrowingBlockUnsettled`                                                         | Red: `Int.max` is not less than 2                                                         |
| The settings save drops `chatStyle`              | `testSettingsSaveSendsChatStyleChoices`                                                                     | Red: nil is not "classic"                                                                 |
| The transcript always shows bubbles              | `testChatStyleSettingSwitchesTheTranscript`                                                                 | Red: "Classic moves the prose out of the bubble: 30.0 vs 30.0"                            |

The first lightness-cap run stayed green. The contrast guard in `SolidBubble.fill` lowered the lightness anyway, and the test compared against the constant it was meant to protect. The test now pins 0.52, the value the web uses, within 0.003 for 8-bit rounding, and went red on the same mutation. The guard loop itself never runs for any tested color, since the 0.52 cap already gives at least 5.1:1; it has no red run.

## Validation

The new tests first passed on `2074b1b3`: `bash .agents/tools/validate-ios.sh 270DC27B-4FBD-444E-9EEE-B02E93AA696F test -only-testing:AgentInterfaceTests/ChatBubblesTests -only-testing:AgentInterfaceTests/NativeContractTests/testSettingsSaveSendsChatStyleChoices -only-testing:AgentInterfaceUITests/TranscriptFlowTests/testChatStyleSettingSwitchesTheTranscript` ran 14, 1 and 1 tests with no failures.

On `bcbfad27`, one run took the whole unit target and eight UI classes: `-only-testing:AgentInterfaceTests` plus `TranscriptFlowTests`, `ParityFlowTests`, `SettingsPolishTests`, `ChatCardsFlowTests`, `ReplyExtrasFlowTests`, `AccessibilityAuditTests`, `DiscoveryFlowTests` and `NativeFlowTests`. Of 892 tests, the unit target passed 829 with two skips, and the UI classes ran 63 with two skips and one failure. Result: `.private/ios-test-20261120T034456Z-47811.xcresult`; output: `/Volumes/DevSSD/scratch/chat-bubbles-ios/logs/broad1.log`.

The failure was `TranscriptFlowTests.testRoutineRunsSitAmongTurnsAndOpenToTheirOutput`, which failed again alone. Its dark relaunch tapped the first routine run while that card sat under the header, because bubbles make replies taller. With the transcript forced to Classic, the same test passed. Commit `3625a267` scrolls the card into view before the tap and changes no assertion; the test then passed alone (`.private/ios-test-20261120T041813Z-69154.xcresult`).

The whole `TranscriptFlowTests` class on `3625a267` ran 17 tests with two skips and one failure: `testApprovalScopesTheDeclineHandoffARecommendedAnswerAndSteering` found no alert after tapping the Always allow menu row (`.private/ios-test-20261120T041929Z-70457.xcresult`). It passed in the broad run and passed twice alone on the same commit (`.private/ios-test-20261120T042401Z-73640.xcresult`, `.private/ios-test-20261120T042457Z-74749.xcresult`), so it is recorded as flaky. It was not run on main.

Screenshots from `testChatBubbleScreens` on both simulators, light and dark, Bubbles and Classic, Tinted and Solid, the work and progress fixtures, and Accessibility XL text, are in `/Volumes/DevSSD/scratch/chat-bubbles-ios/screenshots/`.

Not run: the unfiltered native suite, `ScreenshotTourTests` and the other UI classes, VoiceOver by hand, Increase Contrast and Reduce Motion on a simulator, and any physical device. The cross-provider review was left to the orchestrator.
