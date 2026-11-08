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
