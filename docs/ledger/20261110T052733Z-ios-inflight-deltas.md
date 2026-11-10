# November 10 iOS live reply growth notices

Branch `t3/ios-inflight-deltas` over `114c4b4`, written on NicolasLaptop (Fedora, Linux x64),
Node 24.22.2. The iOS app's conversation stream moves from `?inflight=1` to `?inflight=2`. No
server code changed; the server still serves `?inflight=1` to installed builds.

Linux cannot build or test Apple code, so the Swift was written uncompiled. The Mac mini then
compiled it and ran the unit tests on a simulator, with no source changes needed; see the Mac
sections below.

## Application tests on Linux

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/inflight-delta.test.ts`: 15 passed. The cases now come from
  `ios/AgentInterfaceTests/Vectors/inflight-delta.json`, which the Swift tests read too.
- `npx vitest run`: 170 files, 2579 tests passed.
- `python3 ios/tools/generate-project.py` added `InflightDeltaTests.swift` to the project; run on
  `origin/main` first, it reproduced the checked-in project byte for byte.

### Red proof of the shared vectors against the web

Each line in `src/shared/inflight.ts` was broken by hand, the file test went red, and the line was
restored:

- `toolCalls: held.toolCalls` in place of `delta.toolCalls ?? held.toolCalls`: the two tool call
  replacement cases failed.
- Always setting `reasoning`, in place of only when it is not empty: 4 cases failed, including the
  emoji, CJK and joined emoji cases, whose replies carry no reasoning.

## Mac validation

Mac mini, macOS 27.0.1 (26A434), Xcode 27.2 (27B52), iOS Simulator SDK 27.2, simulator
iPhone 17 `0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0` on iOS 27.0 (24A434). Source state
`d2a6d6b`. Every run went through `validate-ios.sh`, which holds `mac-heavy-lock.sh` from build
through simulator shutdown. Queued is the lock's `wait_s`; run is its `hold_s`, build included.

The Swift compiled as written. None of the parts flagged as unsure needed a change: the labeled
`reading:` loop with `break reading` inside the nested `guard`, the `merging` dictionary
literals, the labeled tuple array, and the `[String?]?` comparison all compiled with no warning
in a changed file.

| Command | Result | Queued | Run |
| --- | --- | --- | --- |
| `bash .agents/tools/validate-ios.sh 0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0 test -only-testing:AgentInterfaceTests/InflightDeltaTests -only-testing:AgentInterfaceTests/NativeContractTests` | 141 unit tests passed, 0 failed, including all four new tests | 0.17 s | 111 s |
| `bash .agents/tools/validate-ios.sh 0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0 test -only-testing:AgentInterfaceTests` | 745 unit tests: 743 passed, 2 skipped (the two evidence renderers), 0 failed | 0.17 s | 76 s |
| `bash .agents/tools/validate-ios.sh 0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0 test -only-testing:AgentInterfaceUITests/ShellFlowTests` | 13 UI tests: 11 passed, 2 failed, both on base too | 0.16 s | 263 s |
| The two failures above on a detached `114c4b4` worktree with its own `IOS_DERIVED_DATA` | Both failed the same way on base | 0.18 s | 124 s |

The new tests and their run times on the simulator:

- `InflightDeltaTests.testGrowthNoticesMatchTheSharedVectors`: passed, 0.01 s.
- `NativeContractTests.testGrowthNoticesExtendTheWholeLiveReplyWithoutRereading`: passed.
- `NativeContractTests.testAGrowthNoticeThatDoesNotContinueTheHeldReplyReloadsOnceAndReconnects`:
  passed, 1.97 s for all five refusal cases.
- `NativeContractTests.testAChangeNoticeDropsTheHeldReplySoGrowthOfItIsRefused`: passed, 0.08 s.

`ShellFlowTests` covers the household stream, whose reader changed from `lines` to
`stream.lines`: `testARoomAnotherMemberMadeAppearsOnHomeFromTheStreamNotice` passed. The two
failures predate this branch and match the November 1 baseline list. `testCommandKOpensTheQuickSwitcherAndGoesWhereChosen`
fails at line 302 because the quick switcher never opens. `testGroupChatNamesSendersSuggestsMentionsAndUpdatesLive`
fails at line 141 because the sender's name never shows, before the per-room group stream is awaited.
No unit or UI test reaches the per-room stream (`/api/events?group=`) in `GroupMentions.swift`.
Its change is the same one-line move to `stream.lines`, and it compiled.

## Red proof on the Mac

Each line was broken by hand, its tests were run with `IOS_VALIDATION_FRESH=1` and the same
selector form as above, and the line was restored with `git checkout`. Queued time was
0.15 to 0.18 s for every run.

| Line broken | Tests run | Result | Run |
| --- | --- | --- | --- |
| `Models.swift` `Inflight.extended`: `message.text.utf16.count` changed to `message.text.count` | vectors test, extend test | Red. The vectors failed for 5 cases: the emoji refusal and emoji, combining accent, CJK and joined emoji growth. The extend test timed out waiting for the growth, read the conversation 2 more times and opened 3 streams instead of 1. | 52 s |
| `Models.swift` `Inflight.extended`: `if let toolCalls = delta.toolCalls { ... }` removed | vectors test, extend test | Red. Vectors "replaces tool calls when the notice carries them" and "an empty tool call list replaces them too" failed, and the extend test got `[nil]` for the tool call results instead of `["3 results"]`. | 38 s |
| `Models.swift` `Inflight.extended`: `botId == delta.botId` removed from the guard | vectors test, refusal test | Red. Vector "refuses a notice for another assistant" failed, and so did the refusal test's "another assistant" case: no reload, no reconnect, and the reply was kept. | 38 s |
| `AppStore+Polling.swift`: `?inflight=2` changed back to `?inflight=1` | extend test | Red: the query was `inflight=1`, not `inflight=2`. | 26 s |
| `AppStore+Polling.swift`: the refusal branch's `else { ... }` body replaced with `event = ""; continue reading` | refusal test | Red for all five cases. Each timed out waiting for the reconnect and had 1 stream, not 2. The four cases that held a reply still showed it, and no case reloaded. | 79 s |
| `AppStore+Polling.swift`: `stream.task.cancel()` removed | refusal test | **Stayed green.** URLSession closes the connection when the `URLSession.AsyncBytes` is released at the end of the `do` block. Experiment: the same change plus every opened byte stream kept alive in an array went red, timing out on the old stream's `stopped` in all five cases. With the cancel restored and the streams still kept alive, it passed. So the test catches a connection left open, and the explicit cancel closes it on its own. | 28 s; experiments 79 s and 28 s |
| `AppStore+Polling.swift`: `self.latestInflight = nil` in the change notice branch removed | change notice test | Red. The read after the change was still overlaid with "Howdy", no reconnect followed the stale growth, and "Howdy partner" was applied. | 36 s |

## Not exercised

No real Hermes reply streamed to the app, and no phone or simulator watched one. The iOS docs name
no scripted server. The only live route is `validate-ios.sh live` against an isolated Hermes runtime
and app server on `127.0.0.1:3004`, and none was running or set up for this task. Nothing measured the bytes a
long reply costs on either mode. The backoff after repeated refusals is now tested; see the review round below.

## Review round 1: GPT-6.1 Sol

GPT-6.1 Sol reviewed head `0976055` and found no production defect. It asked for tests of two
recovery paths and a fix to one stale comment. Commit `5c3482e`, written and run on the Mac mini.

### Seam

`AppStore.resyncPause: (Duration) async throws -> Void`, defaulting to `Task.sleep(for:)`, in the
style of `TalkController.sleep`. The refusal backoff in `watchConversation` calls it in place of
`Task.sleep`; the delay, the `try?` and the cancellation behavior are unchanged. No other sleep uses
it. The tests substitute `ResyncPauses`, which records each wait and either returns at once or holds
in a real `Task.sleep` that only cancellation ends, so no test waits real seconds for the backoff.

### New tests

All in `NativeContractTests`, with the network faked at the API client boundary as before.

- `testAnUnreadableNoticeOrAWholeReplyForAnotherAssistantDropsTheHeldReplyAndReconnectsOnce`: three
  cases, each holding "Howdy" first. An `inflight-delta` with truncated JSON; a truncated whole
  `inflight` followed by growth based on "Howdy"; and a whole `inflight` for assistant `family`
  followed by the same growth. Each must drop the held reply, reconnect once and read the
  conversation once, then grow a new whole reply correctly. The growth after the whole events keeps
  base lengths 5 and 0, so a whole event that failed to drop "Howdy" would let it apply.
- `testRepeatedRefusalsWaitThreeSecondsMoreEachTimeUpToThirtyAndAnAppliedNoticeResetsThem`: twelve
  refusals in a row reconnect at once, then wait 3, 6, 9 ... 27, 30, 30 seconds. An applied growth
  notice makes the next refusal immediate again, and the one after waits 3 seconds.
- `testPollingReadsTheConversationDuringTheBackoffAndSwitchingChatsEndsItWithoutReconnecting`: during
  a held 3-second wait, a poll pass reads the conversation and leaves the stream alone. Switching to
  another chat cancels the wait, the old stream loop ends, the old chat does not reconnect, and the
  new chat opens its own stream.

### Red proof

Each line in `AppStore+Polling.swift` was broken by script, the one test that protects it was run with
`IOS_VALIDATION_FRESH=1`, and the file was restored with `git checkout`. Every build compiled, and
every failure was an assertion, not a build error.

| Line broken | Test | Result | Queued | Run |
| --- | --- | --- | --- | --- |
| Delta decode split into its own `guard` that skips an unreadable notice | unreadable or foreign | Red, unreadable growth case: no reconnect, "Howdy" kept, 1 stream, 2 reads | 0.18 s | 39 s |
| Whole-reply `else` changed to `else if patch != nil` | unreadable or foreign | Red, unreadable whole case only: "Howdy partner" applied, no reconnect | 0.17 s | 45 s |
| Whole-reply `else` changed to `else if patch == nil` | unreadable or foreign | Red, other assistant case only: "Howdy partner" applied, no reconnect | 0.17 s | 39 s |
| `if refused > 1` changed to `if refused > 0` | backoff | Red: the first refusal waited 0 s, and the waits after a reset were `[0, 3]` | 0.17 s | 28 s |
| `min(30, ...)` removed | backoff | Red: the twelfth refusal waited 33 s | 0.17 s | 28 s |
| `refused = 0` on an applied notice removed | backoff | Red: the refusals after an applied notice waited 30 s and 30 s | 0.16 s | 28 s |
| `self.streamHeardAt = nil` before the resync branch removed | poll and switch | Red: the poll during the wait read nothing | 0.17 s | 29 s |
| `while !Task.isCancelled` of the stream loop changed to `while true` | poll and switch | Red: the left chat opened a third stream after the cancelled wait | 0.18 s | 28 s |

### Mac validation

Same Mac, Xcode, simulator and lock as above. Source state `5c3482e`.

| Command | Result | Queued | Run |
| --- | --- | --- | --- |
| `bash .agents/tools/validate-ios.sh 0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0 test` with the three new tests and `FixedWaitRuleTests` | 5 unit tests passed, 0 failed | 0.17 s | 31 s |
| `bash .agents/tools/validate-ios.sh 0915E0B2-A1A0-43FC-9A9A-35DF02CAF0F0 test -only-testing:AgentInterfaceTests` | 748 unit tests: 746 passed, 2 skipped (the two evidence renderers), 0 failed | 0.16 s | 80 s |

An earlier run with the existing refusal test also selected passed it. The UI target was not run
again; its two `ShellFlowTests` failures also fail on `main`.

### Comment

`src/server/conversation-routes.ts` now says mode 1 serves older installed iOS builds and cached web
bundles, and that the web and iOS apps read mode 2. No server code changed. `npm run lint` and
`npm run typecheck` were not run: this checkout has no installed `node_modules`, and the change is a
comment.
