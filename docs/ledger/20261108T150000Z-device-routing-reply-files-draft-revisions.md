# November 8 device routing, reply file chips and email draft revisions

Workstream C of the Grok-inspired chat flow plan, on branch `t3/device-artifacts-email-revisions`
over `846ec70` (PR #264's head). Web and server checks ran at `c58bdb6`, and iOS at `c58bdb6` plus the two test fixes committed with this entry (source fingerprint
`sha256:f6ba72f4…`, 1522 files) on NicolasLaptop (Linux, Node 24.22.2, Python 3.14.10). iOS ran
on the Mac mini (macOS 27.0, Xcode 27) on a simulator created for this work, WildBots-C (iPhone 17,
iOS 27.0), from an rsync of `ios/` checksum-identical to `c58bdb6`, every run through
`mac-heavy-lock.sh`. No live Hermes, physical device, APNs delivery to a phone, mail client or screen
reader was exercised.

## Web and server

- `npm test`: 153 files, 2,127 tests passed. `npm run typecheck`, `npm run lint`, `npm run build`
  and `npm run test:e2e` (2 tests) passed. `npm run test:py`: 37 files passed (the Hermes add-on
  reads the edited `src/shared/inline-ui-instructions.json`). `npm run lint:py` did not run: ruff
  is not installed on this machine and no Python changed.
- One full-suite run failed `transcript-ui` "names a required field left empty and sends nothing"
  (a #264 form test) under load; it passed on three focused reruns and the next full run.

## Mutants

Each line below was broken by hand, its focused suite run, and the source restored
(`.private/mutants.py`, not committed). 35 mutants; 31 failed their tests at once. The four that
survived each got a sharper test and then failed:

- `attachSubscriptionDevice`'s own-endpoint guard survived because the status route checks first;
  a store-level test now labels another member's endpoint directly.
- Sign-out's `endSessionActivity` survived because the active-device query already requires a live
  session; the test now asserts the row itself is gone and another session's row stays.
- The scheduled-prompt turn boundary and the reply rule (`isConversationReply` versus any assistant
  row) survived the first vectors; two vectors now separate them (a file before a scheduled
  delivery, and a blank assistant row after a reply).

Killed on the first pass: the reached flag, the security fan-out, Apple's `BadDeviceToken`
clause, the `dead:` marker, skipping versus sending to quiet devices, the quiet iPhone's
read-elsewhere badge, keeping skipped endpoints out of tag clears, both sides of the 5-minute and
45-second boundaries, the session join, per-account `inactive`, the `idleMs` ceiling, device ID
folding, clearing a stale label, the web hook's boundary and sign-out report, device ID
validation, the status request's device ID, Generated-only chips, first-appearance attribution,
the 4-chip limit, the panel's focus, the diff tie-break, blank folding, the cell limit boundary,
the four-space tokenizer, assistant-only lineage, recording draft IDs, self-revision, lineage ID
validation, and Hide changes.

## External behavior, measured

- Dead Web Push endpoints, 2026-11-07, through `web-push` 3.6.7 with fresh VAPID keys at unknown
  endpoints: FCM 410 ("push subscription has unsubscribed or expired"), Mozilla autopush 404, and
  Apple Web Push 400 `{"reason":"BadDeviceToken"}` (403 `BadJwtToken` when the VAPID subject is an
  `.invalid` address). The worker already dropped 404 and 410; Apple's answer was retried forever,
  and is now treated as dead.
- Badge-only APNs push with the app's current entitlements: production (`APNS_ENVIRONMENT=production`)
  has sent `{"aps":{"badge":N}}` as an alert push at priority 5 after every read-elsewhere clear
  since October 25. Read-only checks on the Hermes VPS found 128 clears recorded since then and no
  "Notification clearing failed" line in the service journal since September 30, so Apple accepted
  them. Delivery of the new routing's badge push to a quiet physical phone was not observed.

## iOS

- Unit: the full `AgentInterfaceTests` suite ran 630 tests, 2 skipped, 6 failed. Two failures were
  this branch's and are fixed: `FixedWaitRuleTests` flagged an unlabelled pause in the new
  `DeviceActivityTests` (now the suite's `until` and an "Absence" comment), and
  `testTheObservedListNamesEveryTrackedProperty` lacked the new `replyFiles` and `draftRevisions`.
  `ShellFeatureTests.testComputerHelpMatchesTheWebHelpSource` failed only because the Mac copy
  lacked `src/shared`; it passed once copied. The three `DirectRouteTests` failures
  (`testUsesTheNextRouteWhenTheBestDoesNotAnswer`, `testAServerWithoutRoutesForgetsTheOnesItAdvertisedBefore`,
  `testAReadThatFailsOnTheRouteIsSentOnThePrimaryOriginAndTheRouteRests`) and the observed list's
  remaining `sending` versus `sendingRequests` mismatch fail the same way on an untouched `846ec70`
  checkout on the same simulator. A rerun of every failed test at `c58bdb6` plus the two test fixes:
  all passed except those four pre-existing ones.
- UI: `ReplyExtrasFlowTests` (2) and `ChatCardsFlowTests` (1) passed, the first in light and dark.
  `TranscriptFlowTests` ran 10 tests; `testQuestionOptionsAdvanceAndSendEveryAnswer` failed ("the
  note field never took keyboard focus") here and on `846ec70` alike.
- Earlier runs on this branch caught Swift 6 isolation errors, a doubled period in the spoken diff,
  a float rounding of 299.999 seconds to 299998 ms (now whole milliseconds capped at 299999), and
  VoiceOver reading the styled body as "SaturdaySunday" (now one element with "removed:" and
  "added:"). Each was fixed and its test passed after.
- The shared vectors `Vectors/reply-artifacts.json` and `Vectors/draft-diff.json` pass on both
  clients, including composed and decomposed "é" as different words and Windows line breaks split
  by scalar, as JavaScript does.

## Visual

Web: the real app server over a scripted runtime (`.private/shots-server.ts`), headless Chromium
1248 at 1280x860 and 390x844, light and dark: chips with "+2 more", the Artifacts panel opened on a
chip's file and from "+2 more", and a revised email draft with changes shown and hidden. The only
console errors were the 401s before local sign-in. The first capture showed the toggle's icon above
its label and replaced words run together; both were fixed and captured again. iOS: the
`ReplyExtrasFlowTests` attachments in light and dark. The first capture stacked one chip per line;
chips now size to their names.

Not exercised: Settings > Notifications gained no copy, so there is no routing visual.

## Review round: GPT-6.1 Sol, 846ec70..64080adb

Five findings, all reproduced and fixed at `006b561` plus the documentation and ledger commit
after it. Checks at that state: `npm test` 153 files and 2,137 tests passed; typecheck, lint,
build and e2e (2) passed; `npm run test:py` 37 passed. iOS on a fresh WildBots-C simulator
(iPhone 17, iOS 27.0) through `mac-heavy-lock.sh`: the full `AgentInterfaceTests` suite ran 632
tests, 2 skipped, 3 failed, all pre-existing on `846ec70` as recorded above (two
`DirectRouteTests` and the observed list's `sending` versus `sendingRequests`); UI
`ReplyExtrasFlowTests` (2) and `ChatCardsFlowTests` (1) passed. One build failed first on a
`private(set)` setter the new chip refresh writes from an extension; fixed before that run.

1. Email lineage broke released parsers. Shipped state, checked read-only: production web runs
   `release-71753bf9` (before #264), and main's native build is 22, set by #258 before #264
   merged, so no shipped client parses email cards yet; but main can ship #264 alone. Lineage
   now lives in the card id, `NEW__revises__EARLIER`; the parser is back to #264's exact email
   fields on both clients. `tests/fixtures/reply-cards-c2fae16.ts`, a frozen copy of #264's
   parser, must accept every vector card card for card.
2. Queued heartbeats. One report in flight, only the latest waiting, worked out (state and
   `idleMs`) as it goes, on web and iOS. Tests hold the server's answers and check that no
   active report follows leaving and that idle time is the sending time.
3. Device takeover. A device ID belongs to the account whose live session last reported it, or
   that registered it for push; another member's report is refused with 409 and its reason
   until that session signs out or expires. `inactive` keeps the hold; retention drops rows
   whose session ended.
4. Chips versus the panel after pagination. Both attribute from the window plus the
   file-bearing messages before it, read once per window through a shared cache (web) and the
   store's earlier-file page (iOS); a window after the start shows no chips until that history
   is known.
5. Status against an older server. On 400 the check asks once more without `deviceId`; any other
   failure is reported as before.

Hand-breaks (`.private/mutants2.py`, not committed): each line broken alone, its suite run,
source restored. All 17 failed their tests:

- 1: adding `draftId` to the email fields; teaching `draftId` in the guidance; dropping the
  self-revision check.
- 2: working the report out when queued instead of when sent; restoring the queue of every report.
- 3: skipping the ownership check; dropping the push-device owner, the labelled-subscription
  owner, or the live-session condition (the first run of that one only broke the SQL
  parameters, so it was rerun as `(1 OR live)` and failed the expired-session test); deleting
  the row on `inactive`; pruning regardless of session.
- 5: no legacy retry; retrying on any error.
- 4: not seeding first appearance from earlier files; chips before the history is known; chips
  or the panel attributing without the earlier files.

## Re-review round: GPT-6.1 Sol, 64080adb..8f35f7d

Five findings, all reproduced and fixed at `7305ddc` plus the test and ledger commit after it.
Checks: `npm test` 153 files and 2,142 tests passed; typecheck, lint, build and e2e (2) passed;
`npm run test:py` 37 passed. iOS on a fresh WildBots-C simulator through `mac-heavy-lock.sh`: the
full `AgentInterfaceTests` suite ran 635 tests, 2 skipped, 4 failed, all pre-existing on
`846ec70` (three `DirectRouteTests`, and the observed list's `sending` versus `sendingRequests`,
checked to be the only difference); UI `ReplyExtrasFlowTests` (2) and `ChatCardsFlowTests` (1)
passed. After the test fix below, `ArtifactsTests`, `DraftDiffTests` and `DeviceActivityTests`
ran again: 19 passed.

1. iOS reused an earlier-files page whose start was anywhere in an expanded window. It now
   takes only the page for the window's exact first message. The web cache was already keyed by
   the window's first message, so it had no such flaw.
2, 3. Device ownership is now session-bound only: the account whose live session last reported
   the device. Push registrations name a device but never hold one, so another member's label
   cannot lock out its owner, and an expired session frees a shared browser.
4. Any finished iOS earlier-files read, including one for an assistant left midway, now looks
   at the window on screen again, so that window's own read is no longer lost. The web keeps
   one cache entry and one listener set per window, so it had no such race.
5. The guidance gives the 80-character id budget and its fallback, a new short id without
   lineage. Shared `budget` vectors pin 80 accepted, 81 refused, by the current parser on both
   clients and the released parser.

Hand-breaks, each alone:

- Web (`.private/mutants3.py`): letting a labelled subscription hold a device, letting a
  registered iOS device hold one, and removing the budget from the guidance each failed their
  tests. The registered-device variant first survived because the test never had the owner use
  that device; the owner now reports from it, and it fails.
- iOS: restoring the "boundary anywhere in the window" check first passed, because the
  expanded test window did not contain the old boundary. With the test window corrected it
  failed (lines 82 and 84). Removing the refresh when a read finishes failed the
  assistant-switch test (lines 102 to 105).
