# November 20 chat bubbles on iOS, follow-up

Branch `t3/chat-bubbles-ios`, after `e1bf75c3`. This follow-up merges origin/main `2eb5a123` (#456, the floating glass composer), keeps a list or quote holding a full-width block out of the reply bubble, matches the web's bubble fill, and checks the approvals UI test that failed once.

Toolchain: Xcode 27.2 (27B52), iPhone 18 Pro Max simulator `270DC27B-4FBD-444E-9EEE-B02E93AA696F` on iOS 27.0. Every run went through `.agents/tools/validate-ios.sh`, which holds the Mac heavy lock. These are simulator runs, not device runs. Logs are in `/Volumes/DevSSD/scratch/chat-bubbles-ios/followup/logs/`.

## Merge

Merge commit `abec8653` merged origin/main with no conflicts. #456 drops the composer's blur backdrop and makes the message box Liquid Glass; the bubbles branch changes neither. Screenshots from `testChatBubbleScreens` at the end of the chat show the last reply bubble, its action row and the person's last bubble above the glass box in Bubbles and Classic, light and dark, and at Accessibility XL text. The reply bubbles have no material, glass, blur or shadow. Nothing needed a fix.

## Nested full-width blocks

`ReplyBubbles.isProse` counted every list and quote as prose, so a fenced code block under a list item put the whole list, code included, in one bubble. `MarkdownParser` nests list item and quote content as blocks, so the case occurs here. A list or quote is now prose only when every block inside it is, at any depth. Images in this parser become inline "Open image" links inside paragraphs, so they stay prose; the parser has no other media block.

`ChatBubblesTests.testAListOrQuoteHoldingAFullWidthBlockLeavesTheBubble` covers a numbered list with a code block in its second item, a table two levels down a list, a quote holding a code block, a quote holding a rule, and a list and quote of plain prose that stay in one bubble.

## Red runs

| Break                                           | Guarding test                                           | Result                                                                                                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The unfixed code: every list and quote is prose | `testAListOrQuoteHoldingAFullWidthBlockLeavesTheBubble` | Red: `["bubble 3"]` against `["bubble 1", "list", "bubble 1"]` (`red-nested-list.log`). The first test version then crashed on an index; it now checks the count first. |
| A quote is always prose (`case .quote: true`)   | the same test                                           | Red: `["bubble 2"]` against `["bubble 1", "quote"]`, and `["bubble 1"]` against `["quote"]` (`red-quote.log`)                                                           |

The quote break was applied by hand to `8aaa18c4`, run with `IOS_VALIDATION_FRESH=1`, and restored with `git checkout`; `git status` was clean after. The fix then passed: `ChatBubblesTests` ran 15 tests with no failures (`green-and-shots.log`).

## Fill

`Palette.replyBubble` is now #EAE8E2 in light and #272D29 in dark, the web's 7% ink mixed into the surface in OKLab. Recomputing that mix from the ink and surface values in OKLab gives the same two colors. The doc comment said sRGB and now says OKLab. No test pins the constant.

## Approvals UI test

`TranscriptFlowTests.testApprovalScopesTheDeclineHandoffARecommendedAnswerAndSteering` ran 20 times on each side, alone, in the same simulator:

| Code                    | Runs   | Passed | Failed |
| ----------------------- | ------ | ------ | ------ |
| This branch, `8aaa18c4` | 5 + 15 | 18     | 2      |
| origin/main, `2eb5a123` | 5 + 15 | 19     | 1      |

Every failure, on both sides, is the same assertion at line 99: no alert after the coordinate tap on the Always allow menu row. The failed branch run's recording shows the menu open and its row at a stable frame; the tap leaves the menu open. Because main fails the same way, this is a baseline flake and the test is unchanged. Results: `.private/ios-test-20261120T043934Z-90395.xcresult` and `.private/ios-test-20261120T044510Z-97586.xcresult` on the branch; on main, the result bundles went with the detached worktree they ran in, and the console output remains in `flake-main.log` and `flake-main-15.log`.

## Validation

On `8aaa18c4`, one run took `-only-testing:AgentInterfaceTests` plus `TranscriptFlowTests`, `DailyFlowTests`, `ParityFlowTests`, `SettingsPolishTests` and `ChatCardsFlowTests`. The unit target ran 830 tests with two skips, and the UI classes ran 51 with two skips, all passing. The skips are the evidence renderers and the two screenshot-only tests, which skip unless `AGENT_INTERFACE_SCREENSHOT_DIR` is set. The approvals test passed in this run. Result: `.private/ios-test-20261120T045707Z-12233.xcresult`; output: `final.log`.

Screenshots are in `/Volumes/DevSSD/scratch/chat-bubbles-ios/followup/shots/`, from `testChatBubbleScreens` with `TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR` set. The new `iphone-nested-code-*` set uses the `AGENT_INTERFACE_UI_NESTED_CODE` fixture.

## Not run

The unfiltered native suite, iPad screenshots for this follow-up, VoiceOver by hand, Increase Contrast and Reduce Motion on a simulator, and any physical device.
