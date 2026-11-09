# November 9 iOS live Talk, parity fixes and the live voice status route

Branch `nic/audit-mobile-voice-parity`, based on `114caa10`, on the Mac mini. It merges
`parity/ios-voice-picker-crashes` and `parity/ios-computer-peek`, each with its own entry from
today. Xcode 27.2, iPhone Air simulator on iOS 27, `validate-ios.sh` with derived data on DevSSD.
Fixture transport only, except for the WebSocket probe below. Code state: `source-state.py` fingerprint `sha256:46f741835a1d050217a7b71811d6b55d9b6034677364fbef975ef4365ebd3d61 (1655 source files)` at the final code.

## What changed

- **Live voice status.** Hermes's dashboard registers a `GET /{full_path:path}` catch-all
  before the add-on's routes and answers any unmatched `/api/` path with "No such API endpoint".
  `GET /api/agent-interface/voice/status` was the add-on's only GET route, so production reported
  "This Hermes add-on predates live voice" while minting still worked. The route is POST now, and
  `scripts/spike/app-probe.mjs` asserts during qualification that the status reaches the add-on
  through real Hermes routing.
- **iOS live Talk.** The app uses OpenAI's Realtime WebSocket with the short-lived client secret,
  not WebRTC, plus AVAudioEngine with voice processing. It ports the web's tool loop.
- **iOS chat.** On iPhone, the Advanced model chip is the provider's mark alone in the header
  row. The message box floats over the transcript. The transcript keeps room the box's measured
  height before its end, so the latest message, placed cards, the undo toast, Jump to latest and
  the computer preview all sit above the box.
- **Native build 24.**

## External dependency check

On the production host, a client secret minted through the add-on's service route opened
`wss://api.openai.com/v1/realtime` three ways: with the secret as a bearer header, as an
`openai-insecure-api-key.` subprotocol, and without the model query. Each answered
`session.created` with `gpt-realtime-2.1`, 24 kHz `audio/pcm` in and out, the minted voice and
`semantic_vad`. The same host answered 404 "No such API endpoint" to the service-bridge GET of
voice status.

## Application tests

- **Talk unit tests.** `TalkLoopTests` (9), `TalkPlaybackTests` (5) and `TalkControllerTests` (10)
  all pass on the final code, with `CrashReportTests` (15).
- **Talk mutants.** Four applied together turned exactly the four guarding tests red, then were
  restored: no response queue, no truncate on interruption, `>` for the idle limit, and audio
  opened before `session.created`.
- **UI flows.** `TalkFlowTests` (3), `TranscriptFlowTests` (11), `ChatCardsFlowTests`,
  `VaultFlowTests` (14), `ParityFlowTests.testLongChatOpensAtLatestPagesEarlierAndJumpsBack` and
  the new `DailyFlowTests.testTranscriptRunsUnderTheMessageBox` all pass. The latter checks that
  the transcript reaches under the box and that the latest message ends above it.
  `NativeFlowTests.testComposerAttachMenuAndAdvancedModelSwitch` checks that the phone header
  shows the mark alone.
- **Full suite at `6e5097ee`.** 733 unit tests ran with 2 skipped and 4 failures, and 80 UI tests
  ran with 23 skipped (screenshot-only) and the 10 baseline failures below. The unit failures were
  the two baseline tests, the Talk sleep comment fixed in the next commit, and
  `NativeContractTests.testUploadFinishingWhileReturningDraftLoadsKeepsTheFile`. That test passed in
  the earlier full run and then 5 of 5 alone, so it is a timing flake this branch does not touch.
- **Baseline.** These failed identically on a clean `114caa10` checkout, same simulator:
  - `DailyFlowTests.testHomePushesKeepDraftAndFindOpensMessageActions`
  - `DiscoveryFlowTests.testSearchSavedItemsAutomationAndEditableStarter`
  - `NativeFlowTests`: CommandPeriod and FailedUpdate
  - `ParityFlowTests`: AssistantCatalog, ComputerRow, NotificationPrompt and TodayAndTablet
  - `ShellFlowTests`: CommandK and GroupChatNames
  - `NativeContractTests.testTheObservedListNamesEveryTrackedProperty`: `accountUsage` was missing
    from main's list.
  - `FixedWaitRuleTests`: two sleeps in main's `AccountUsageTests`.
- **Server, Node 24.22.2.** `npm run typecheck` and `npm run lint` pass, and vitest passes 2,403
  of 2,406. `tests/direct-routes.test.ts` (2) and `tests/native-contract.test.ts` (1) fail the same
  way on `114caa10` on this Mac, because of its network interfaces. Python tests pass 39 of 40;
  `tests/release_app_test.py` fails the same way on base. The new adapter assertion that voice
  status is a POST went red with the old call and green with the fix.

## Independent review

GPT-6.1 Sol reviewed the full diff, then each fix commit in four scoped rounds. Round 1 found
four medium issues:

1. The playback ledger kept one item.
2. Playback stalls counted as heard.
3. A headset change dropped queued voice without telling the model.
4. Per-thread MetricKit stacks were reversed.

Later rounds found a stopped engine's clock read as zero, an uncancelled cut response, an
unscoped cancel, and pruning inside the recovery look-back. All were fixed. The fifth round
found nothing.

## Not exercised

Real microphone audio, echo cancellation, OpenAI's voice, a headset change mid-sentence,
MetricKit delivery and audible voice samples all need a physical iPhone. They are listed under
external acceptance in `ios/Parity.md`.
