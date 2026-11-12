# November 12 the iOS app reads an earlier page before the message, not the whole tail

Branch `t3/ios-earlier-page-before` over `7a2c54e1` (`origin/main` with #373 and #374), written and run on the Mac mini (macOS
27.0.1, Xcode 27.2, iPhone 17 simulator, iOS 27.0) through `.agents/tools/validate-ios.sh`, Node 24.22.2 for the web checks. Simulator
runs, not device runs. Nothing was deployed and no Hermes process ran.

## Defect

`AppStore.loadEarlier` asked `start=<first loaded>&turns=20`, so every earlier page answered everything from the new start to the
newest message (see `20261112T053000Z-earlier-page-only.md` for the sizes). The web client moved to `before=` in #373; iOS did not.

## Change

- `loadEarlier` reads `before=<first loaded message>&turns=20` and puts the page in front of that message with
  `Conversation.prepending`, which takes only the page's messages, files and `earlier`/`earlierFiles` and keeps the view's live state,
  draft and version, as `prependPage` does on the web. The window start moves to the page's first message, so polls and change
  notices read the whole loaded window from there. The page is stored in `conversationCache` and the offline library; it does not
  touch `appliedConversationRead`, the capture time, the Saved copy banner or the reply watch.
- An answer that does not name the message (the history lost it) is the latest page and goes through the old path: the
  `read > appliedConversationRead` rule, `hearReplies`, `apply`. A page the view can no longer place, because it no longer holds
  that message, is read again the old way, `start=` that message.
- A page for a window that moved while it loaded, as when opening at an older message, is dropped.
- When another read was in flight, the window move drops it when it answers, so the whole window is read again.
- `Conversation.before` decodes the echo. `DebugFixtures` and the XCTest mock server answer `before` as the app server does.
- `ios/Parity.md` and `docs/native-api.md` describe it. Older iOS builds keep working: the server still answers `start=`.

## Red proof

Each line was broken by hand alone, the tests below ran, and the file was restored with `git checkout`. The mutation runs used
`validate-ios.sh` with `IOS_VALIDATION_FRESH=1` and the `NativeContractTests` and `ConversationParityTests` cases for the page.

| Broken line | Result |
| --- | --- |
| page asked with `start=` instead of `before=` | red: windowed history, late poll, newer read, lost message, view lost, files (6 tests) |
| any answer treated as the page (`value.before == first` dropped) | red: lost message page, lost message after a newer read (2 tests) |
| unplaceable page returns instead of reading whole | red: `testAnEarlierPageIsReadWholeWhenTheViewNoLongerHoldsItsMessage` |
| `windowGeneration += 1` removed from the page path | red: `testAReadAskedBeforeAPageCannotShrinkTheWindowEvenWhenTheReadAfterThePageFails` |
| `historyStarts` not moved by the page | red: late poll, newer read, windowed history (3 tests) |
| refresh after a page that outran a read removed | red: `testAPollThatAnsweredLateCannotReplaceExpandedHistory` |
| `conversationCache[id] = merged` removed | red: `testConversationRequestsAreWindowedAndEarlierHistoryExtendsTheWindow` |
| `read > appliedConversationRead` skipped on a whole answer | red: `testALostMessagePageAnsweringAfterANewerReadIsReadFreshInsteadOfShown` |
| `requestedWindow == windowGeneration` guard removed | red: `testAnEarlierPageIsDroppedWhenTheWindowMovedWhileItLoaded` |
| `prepending` repeats the page's files | red: `testAnEarlierPageCountsFilesFromItsStartAndKeepsEachFileOnce` |
| `prepending` keeps the view's `earlier` and `earlierFiles` | red: files, windowed history and `testFilesFromBeforeTheWindowLoadOnDemandAndMergeWithoutDuplicates` (3 tests) |
| `prepending` keeps messages before the anchor | red: `testAnEarlierPageDropsWhateverTheViewHoldsBeforeItsMessageAndPlacesNothingWithoutIt` |

The first eleven mutations ran at `9fc88008`; the window and anchor mutations were run again, and the guard mutation added, at the
final test set (`db3dc9f2`), where the baseline run of those 13 tests passed first.

## Final runs

- `validate-ios.sh 0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0 test` at `db3dc9f2`, validated inputs
  `92eab35ae5f4f6a68cfd519575554127397275ef163185000cdc2377ed0b7481`: 796 unit tests passed (2 skipped), and
  `testLongChatOpensAtLatestPagesEarlierAndJumpsBack` passed, which pages through the fixture's `before` answers. Of 948 tests,
  908 passed, 29 skipped, 10 UI tests failed.
- Nine of those ten fail identically on `origin/main` (`7a2c54e1`) on this Mac: `DailyFlowTests/testHomePushesKeepDraftAndFindOpensMessageActions`,
  `DiscoveryFlowTests/testSearchSavedItemsAutomationAndEditableStarter`, `NativeFlowTests/testNativeFailedUpdateOffersGuardedRecovery`,
  `NativeFlowTests/testNativeUpgradeQualificationAndUncertainInstallRecovery`, `ParityFlowTests/testAssistantCatalogAndUnsavedChangesAreProtected`,
  `ParityFlowTests/testComputerRowReportsWhoHasControlAndDisablesWhenUnavailable`, `ParityFlowTests/testNotificationPromptAsksIosOnlyAfterEnableAndSettingsSwitchFollows`,
  `ParityFlowTests/testTodayAndTabletLayout` and `TranscriptFlowTests/testQuestionOptionsAdvanceAndSendEveryAnswer`. The tenth,
  `VaultFlowTests/testSecureRequestsAdvanceWithoutSendingChatAndClearOnBackground`, failed in the full run on "never took keyboard
  focus" and passed alone on this branch and on `origin/main`.
- `.agents/tools/check-all` on this Mac stops at `test` with four failures that fail the same on `origin/main`:
  `tests/direct-routes.test.ts` (2), `tests/native-contract.test.ts` (the `native-routes.json` LAN route list depends on the
  host's network interfaces) and `tests/static-cache.test.ts`. The other 3879 tests passed. `typecheck`, `lint`, `ruff` and `build`
  pass; `e2e` cannot start because the Playwright Chromium is not installed on this Mac. This change touches no web or server code.

## Not covered

No physical device and no real Hermes. The Debug fixture and the mock server mirror the app server's `before` answer; the real
answer is covered by the server tests in #373. A page's own `earlierFiles` can count a file a later loaded message passes on again,
as for the web; the next read of the whole window corrects it.
