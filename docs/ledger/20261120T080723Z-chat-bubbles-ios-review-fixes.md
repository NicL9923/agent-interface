# November 20 chat bubbles on iOS, review fixes

Branch `t3/chat-bubbles-ios-fixes`, from `origin/t3/research-openbot-chat-bubbles` at `56ca3b01`. This fixes the findings of an independent review of the iOS chat bubbles, which the reviewer made by reading the code on Linux. Each finding got a regression test that first failed on the unfixed code.

Toolchain: Xcode 27.2 (27B52), iPhone 18 Pro Max simulator `270DC27B-4FBD-444E-9EEE-B02E93AA696F` and iPad Pro 11-inch (M5) simulator `A068DC6D-AB48-467D-A9D0-0564DE3D3840`, both iOS 27.0. Every run went through `.agents/tools/validate-ios.sh`, which holds the Mac heavy lock. These are simulator runs, not device runs. Logs are in `/Volumes/DevSSD/scratch/chat-bubbles-ios/review-fixes/logs/`.

## Commits

| Commit     | Change                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9c0718d5` | A settings save sends only the chat style choice the person changed, and only a value the app knows. When the server answers without a choice it was sent, Settings shows a notice and its controls show what the server holds. |
| `c9143b67` | Bubble contrast, scheduled deliveries out of the person's bubble, solid bubble edges and opacity, the 560 pt cap, the tail on the final segment, and the independent color reference.                                           |
| `532c90ba` | A fixture that streams a reply and saves it, and a capture-only UI test for the settle in both chat styles.                                                                                                                     |
| `87c140ab` | Settings takes the server's values after saves only while its controls still match what the queue last sent, so an edit made as the queue finished is not replaced.                                                             |
| `72f3e024` | `SettingsPolishTests.testFollowAndHomeSectionsUseOneListEach` scrolls the reorder row into view before checking it.                                                                                                             |

## Red runs

The tests were written first, with small seams that kept the old behavior (for example `PersonBubbles.border` returning no edge for a solid fill, and `Palette.quote` equal to `muted`). One run on that state, `red-unfixed.log`, result `.private/ios-test-20261120T073812Z-93199.xcresult`:

| Finding                     | Guarding test                                                                      | Result on the unfixed code                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1, stale choice overwrites  | `NativeContractTests.testASettingsSaveSendsOnlyTheChatStyleChoiceThePersonChanged` | Red: the body carried `ownBubble: "tint"` when only Chat style changed                               |
| 1, unknown value sent back  | `NativeContractTests.testAnUnknownChatStyleChoiceIsNeverSentBack`                  | Red: the body carried `"compact"` and `"gradient"` on a theme change                                 |
| 2, quote and secondary text | `ChatBubblesTests.testTextInsideABubbleKeepsItsContrastInBothAppearances`          | Red: block quote 4.07:1 on the light reply fill; a file's size 3.22:1 on the light person's fill     |
| 3, scheduled delivery       | `TranscriptFlowTests.testAScheduledDeliveryStaysOutOfThePersonsBubble`             | Red: the delivery's table started at x 87 against 16 and was 323 pt wide against 408; label at x 362 |
| 4, old server               | `NativeContractTests.testAServerThatDropsAChatStyleChoiceSaysItCannotSaveIt`       | Red: no notice                                                                                       |
| 4, old server in Settings   | `TranscriptFlowTests.testAServerWithoutChatStylesExplainsWhyTheChoiceDidNotSave`   | Red: no notice, and the Chat style control kept showing Classic                                      |
| 5a, Increase Contrast edge  | `ChatBubblesTests.testIncreasedContrastGivesEveryPersonsBubbleAVisibleEdge`        | Red: eight solid fills under 3:1 against the dark surface, lowest #292929 at 1.13:1                  |
| 5b, solid while sending     | `ChatBubblesTests.testASolidBubbleOnItsWayKeepsItsTextReadable`                    | Red: every colored fill under 4.5:1, lowest 2.85:1 (#00BCA6 and #97683D, light)                      |
| 6, width cap                | `ChatBubblesTests.testThePersonsBubbleStopsAt560Points`                            | Red: 774 pt in a 900 pt column                                                                       |
| 6, tail                     | `ChatBubblesTests.testOnlyTheReplysFinalBubbleCarriesTheTail`                      | Red: a bubble followed by a table or code block had the 4 pt tail                                    |

Finding 4 reproduced differently than the review described. Settings did not snap back to the default. It kept showing Classic while the server held nothing and the transcript drew Bubbles.

Three more breaks were applied by hand to `c9143b67` in one run, `red-mutations.log`, result `.private/ios-test-20261120T074756Z-845.xcresult`, and restored with `git checkout -- ios`; `git status` was clean after:

| Break                                                                       | Guarding test                                                                    | Result                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| OKLab coefficient 0.0514459929 changed to 0.0564459929                      | `ChatBubblesTests.testSolidFillMatchesAnIndependentReference`                    | Red: #1084FE became #0061D7 against #0066CA, 13 units; #9159FE off by 4 |
| The same break                                                              | `ChatBubblesTests.testSolidFillKeepsTheHueAndLeavesDarkColorsAlone`              | Green, which is the gap finding 7 named                                 |
| The save queue subtracts the choices it sent instead of taking them at send | `NativeContractTests.testAChoiceChangedBackDuringASaveGoesOutAgain`              | Red: the second save omitted `chatStyle`, so the server kept Classic    |
| Settings does not resync its controls after saves finish                    | `TranscriptFlowTests.testAServerWithoutChatStylesExplainsWhyTheChoiceDidNotSave` | Red: the notice showed, but the control still read Classic              |

## Color reference

The reference fills the review supplied came from an implementation that reduces chroma in 2% steps, with 4 units allowed a channel. On the unfixed code, `#FF263C` failed that check: the app gives `#C50025` and the reference `#C40826`, 8 apart in green. The app's fill is at the sRGB edge; a 2% step lands inside it, and near zero the sRGB curve is steep, so a small chroma change moves a channel by several units. The web draws `oklch(from tint min(l, 0.52) c h)` and lets the browser fit it to sRGB, so the edge is the rule. The test uses an independent implementation, sRGB to OKLab by way of CIE XYZ with chroma bisected to the edge, written in Python apart from the app. It matches the app exactly for all nine colors, so the test allows 1 unit for rounding. The same Python with 2% steps reproduces the review's nine values exactly.

## Contrast inside bubbles

`ChatBubblesTests.testTextInsideABubbleKeepsItsContrastInBothAppearances` resolves each color from the app's palette in light and dark and computes the WCAG ratio on its fill.

| Text                                      | Color            | On the reply fill, light / dark | On the person's tinted fill, light / dark |
| ----------------------------------------- | ---------------- | ------------------------------- | ----------------------------------------- |
| Body, headings, inline code, list numbers | system label     | 17.14 / 14.06                   | 17.75 / 12.05                             |
| Link                                      | accent           | 4.91 / 8.01                     | not drawn there                           |
| Block quote, before                       | muted            | 4.07 / 6.50                     | not drawn there                           |
| Block quote, after                        | message metadata | 4.72 / 6.50                     | not drawn there                           |
| A task's empty box (graphic, 3:1), before | system secondary | 3.16 / 5.30                     | not drawn there                           |
| A file's size, before                     | system secondary | not drawn there                 | 3.22 / 4.77                               |
| Secondary text in a bubble, after         | message metadata | 4.72 / 6.50                     | 4.89 / 5.57                               |

Inline code has no color of its own; it is body text in a monospaced font. On the plain surface, a quote in message metadata is 5.45:1 in light, up from 4.70.

## Left alone

**Images in prose.** `MarkdownBlock` has no image case. `Markdown.inlineSource` turns `![alt](url)` into an inline "Open image" link, so no Markdown image is drawn as a block anywhere in a reply. Files attached to a reply show as chips below it, outside the bubbles.

**A card fence under a list item.** `ReplyCards.fencedBlocks` accepts a fence indented up to 3 spaces, so a card under a list item splits the Markdown into the list before it, the card and the rest. That code dates from `53816dcb` on main. In Classic the two list fragments render flat around the card; in Bubbles each fragment is a bubble around the full-width card. The split, the order and the list numbering are the same in both, so bubbles do not make it worse. This was checked by reading the code, not by a run.

**Saving a streamed reply.** The fixture streamed a reply over the chat's event stream and then saved it, and `testStreamedReplySettlesForReview` took a screenshot and read the reply's position about every 250 ms through the settle (`stream.log`, `.private/ios-test-20261120T080441Z-14662.xcresult`, frames in `/Volumes/DevSSD/scratch/chat-bubbles-ios/review-fixes/shots/stream/`). When the saved copy replaced the streamed one, the "thinking" row gave way to the time and actions row and the whole reply moved 38 pt down, in Bubbles from y 499 to 537 and in Classic from 517 to 555. The grouping into bubbles was the same before and after, and no sample showed the reply missing. Bubbles are not worse than Classic, so this stays as existing behavior. The sampling interval cannot rule out a flicker shorter than about 250 ms.

## Validation

All runs below are on `72f3e024`, the last code commit, on the iPhone 18 Pro Max simulator unless noted. A first unfiltered run on `532c90ba` stopped at the 2 hour limit of a background command partway through `SettingsPolishTests` (`full-iphone.log`), so the final suite ran in three parts that together cover the unit target and every UI class. `LiveConnectionTests` runs only with the wrapper's `live` operation against a local server and is not part of `test`.

| Part | Scope                                                                                                                                                      | Run | Passed | Failed | Skipped | Result bundle                                       |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------ | ------ | ------- | --------------------------------------------------- |
| 1    | `AgentInterfaceTests`, the whole unit target                                                                                                               | 840 | 838    | 0      | 2       | `.private/ios-test-20261120T105251Z-15858.xcresult` |
| 1    | `AccessibilityAuditTests`, `AppUpdateFlowTests`, `AutomationFlowTests`, `ChatCardsFlowTests`, `DailyFlowTests`                                             | 29  | 26     | 0      | 3       | the same                                            |
| 2    | `DiscoveryFlowTests`, `ExperienceFlowTests`, `MainAssistantFlowTests`, `NativeFlowTests`, `ParityFlowTests`, `ReplyExtrasFlowTests`, `ScreenshotTourTests` | 72  | 68     | 1      | 3       | `.private/ios-test-20261120T110946Z-26326.xcresult` |
| 3    | `SettingsPolishTests`, `ShellFlowTests`, `TabletPresentationTests`, `TalkFlowTests`, `TranscriptFlowTests`, `UsageFlowTests`, `VaultFlowTests`             | 67  | 62     | 1      | 4       | `.private/ios-test-20261120T125245Z-85732.xcresult` |
| iPad | `TabletPresentationTests` on the iPad Pro 11-inch (M5) simulator                                                                                           | 1   | 0      | 1      | 0       | `.private/ios-test-20261120T131408Z-11199.xcresult` |

On iPhone that is 1,008 tests: 994 passed, 2 failed and 12 skipped. The skips are the two evidence renderers, the three W3 trigger flows that need their design fixture, three screenshot tour captures, three capture-only transcript tests that skip unless `AGENT_INTERFACE_SCREENSHOT_DIR` is set, and the tablet test, which needs an iPad. The README and the wrapper do not call for an iPad pass; the tablet class ran there because the 560 pt cap only matters in a wide column.

### Failures

| Test                                                                     | Where it failed                                                               | Alone on this branch                                                     | On origin/main `d6b53105`, same simulator | Class                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- | ---------------------------- |
| `ScreenshotTourTests.testWorkTriggerAfterDesignReview`                   | Part 2 and the stopped run: "Wrong W3 fixture."                               | Failed the same way on `532c90ba`                                        | Failed the same way                       | Baseline                     |
| `SettingsPolishTests.testChoosingATalkVoiceSavesItAndSamplesPlayAndStop` | Part 3 and the stopped run: "voiceOption.cedar" never became hittable         | `532c90ba`: 4 passed, then 1 failed; `72f3e024`: 1 passed, then 1 failed | Failed on its first run                   | Baseline flake               |
| `TabletPresentationTests.testIPadSplitNavigationSettingsAndAvatarStates` | iPad: no Name field after opening the assistant's settings, line 34           | This was the alone run                                                   | Failed at the same line                   | Baseline                     |
| `AccessibilityAuditTests.testLargeTextAccessibility`                     | Only the stopped run on `532c90ba`: "Dynamic Type font sizes are unsupported" | 5 of 5 passed; passed in part 1                                          | 5 of 5 passed                             | Flaky                        |
| `SettingsPolishTests.testFollowAndHomeSectionsUseOneListEach`            | The second run on `532c90ba` (`full-iphone-2.log`): no reorder row            | Failed on its first run                                                  | 5 of 5 passed                             | Caused by this branch, fixed |

`-test-iterations` stops a test at its first failure, so the counts above end there. The reorder row failure also occurred on `56ca3b01`, before these fixes: the Chat style and Your messages rows the bubbles branch added push the row below the fold on this phone, and a Form does not create a row until it scrolls in. `72f3e024` scrolls it into view with the test's own `reveal` helper, which requires the row to become hittable, then passed 5 of 5 alone (`follow-fix.log`) and in part 3. While chasing it, `87c140ab` closed a race in the Settings resync added for finding 4; that change alone did not fix this test (`resync-fix.log`), and no test reproduces the race on demand. `TranscriptFlowTests.testApprovalScopesTheDeclineHandoffARecommendedAnswerAndSteering`, the known approvals flake, passed in part 3.

## Not run

VoiceOver by hand, Increase Contrast and Reduce Motion from the simulator's Settings (the screenshots use a fixture trait override for Increase Contrast), a server from before chat styles (a fixture stands in for it), a real Hermes stream, the web change for solid bubbles while sending, which the orchestrator owns, and any physical device. `check-all` was not run: it covers the web, server and Python, none of which changed, and this checkout has no `node_modules`.
