# November 10 iOS live reply growth notices

Branch `t3/ios-inflight-deltas` over `114c4b4`, written on NicolasLaptop (Fedora, Linux x64),
Node 24.22.2. The iOS app's conversation stream moves from `?inflight=1` to `?inflight=2`. No
server code changed; the server still serves `?inflight=1` to installed builds.

**The Swift code is not compiled and not run yet.** Linux cannot build or test Apple code. Every
Swift check below is "not compiled, not run" until the Mac section is filled in.

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

Not run yet. To be filled in by the Mac task: the commit, Xcode and simulator versions, the
`validate-ios.sh` build and test results with counts, and the run of the new tests:

- `InflightDeltaTests.testGrowthNoticesMatchTheSharedVectors`
- `NativeContractTests.testGrowthNoticesExtendTheWholeLiveReplyWithoutRereading`
- `NativeContractTests.testAGrowthNoticeThatDoesNotContinueTheHeldReplyReloadsOnceAndReconnects`
- `NativeContractTests.testAChangeNoticeDropsTheHeldReplySoGrowthOfItIsRefused`

## Red proof on the Mac

Not run yet. Break each line by hand, run its test, record that it went red, and restore it:

| Line broken | Test that must go red |
| --- | --- |
| `Models.swift` `Inflight.extended`: `message.text.utf16.count` changed to `message.text.count` | `testGrowthNoticesMatchTheSharedVectors`, `testGrowthNoticesExtendTheWholeLiveReplyWithoutRereading` |
| `Models.swift` `Inflight.extended`: `if let toolCalls = delta.toolCalls { ... }` removed | `testGrowthNoticesMatchTheSharedVectors`, `testGrowthNoticesExtendTheWholeLiveReplyWithoutRereading` |
| `Models.swift` `Inflight.extended`: `botId == delta.botId` removed from the guard | `testGrowthNoticesMatchTheSharedVectors`, the "another assistant" case of the refusal test |
| `AppStore+Polling.swift`: `?inflight=2` changed back to `?inflight=1` | `testGrowthNoticesExtendTheWholeLiveReplyWithoutRereading` |
| `AppStore+Polling.swift`: the refusal branch's `else { ... }` body replaced with `event = ""; continue reading`, which drops the notice without reconnecting | `testAGrowthNoticeThatDoesNotContinueTheHeldReplyReloadsOnceAndReconnects` |
| `AppStore+Polling.swift`: `stream.task.cancel()` removed | `testAGrowthNoticeThatDoesNotContinueTheHeldReplyReloadsOnceAndReconnects`, through the old stream's `stopped`. If it stays green, URLSession closes the connection when the byte stream is released; record that. |
| `AppStore+Polling.swift`: `self.latestInflight = nil` in the change notice branch removed | `testAChangeNoticeDropsTheHeldReplySoGrowthOfItIsRefused` |

## Not exercised

No real Hermes reply streamed to the app, and no phone watched one. Nothing measured the bytes a
long reply costs on either mode. The backoff after repeated refusals has no test; it needs a
server that keeps sending deltas the app cannot apply.
