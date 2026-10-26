# Review 10: Questions recheck

Reviewer: Claude Opus 5.5, high effort. Cross-provider recheck of a GPT-6.1 Sol implementation.
Base: `8101836`. Scope: the delta between `09-questions-input.patch` and `10-questions-input.patch`, plus the code
that calls or is called by it. The live `git diff 8101836` (ledger excluded) matches `10-questions-input.patch`
byte for byte. Today, Home and unrelated Conversation code were not re-reviewed. Nothing was built, run or edited.

## Verdict

**Proceed to Approvals for web desktop, web phone and native iPad. Native iPhone needs one cheap check first (V1).**
All three must-fix items are closed against code and screenshots. I found no new confirmed blocker. One plausible
iPhone regression of M1 sits one tap past the opening. No capture covers that state, so a single capture settles it.

| Surface | Review 09 | Now | Notes |
| --- | --- | --- | --- |
| Web desktop (1440 light/dark, 768) | 8.5 | 9.0 | M1 closed. Card still sits flush under the header (old polish 4). |
| Web phone (390, 320, dark, 200%) | 7.5 | 9.0 | M1 and M3 closed on real fresh openings. |
| Native iPhone (default, dark, AX XL) | 8 | 9.0 if V1 passes, 8.5 if it fails | Opening is clean. See V1 for the first tap. |
| Native iPad (default, dark, AX XL) | 8.5 | 9.0 | M2 closed by code, a new UI test and captures. |

## Must-fix closure

### M1. "Jump to latest" over the opening question: closed

- Web code: `use-conversation.ts` sets `atQuestion` only when the opening clarify card is placed (`:348`). The
  button is gated on `!history.atQuestion` (`Conversation.tsx:267`). `atQuestion` clears on every real reader
  intent (`intend`, `:368`), jump (`:415`), send anchor (`:434`), `openMessage` (`:449`) and bot change (`:112`).
  It also clears when the opened card leaves the DOM (`:330-333`), which then sets `follow`, so the reply after an
  accepted answer is followed. Focus moves from `advance()` aren't intents, so answering by keyboard or tap keeps
  the pill hidden. That is correct.
- Web evidence: `questions-v2-after.json` `openings` lists eight fresh navigations: 390 light, desktop light/dark,
  390 light/dark, 320, tablet and 200%. All show `jumpVisible: false`. `firstChoiceVisible` is true for every
  normal size. At 200% it is false by design. I checked `questions-v2-web-review.png` and
  `reviews/10-collages/web-wide-openings.png`: no pill at any width, first choice clear at 390 and 320.
- Native code: `questionPosition` is set on opening (`ConversationView.swift:249`) and gates the overlay (`:283`).
  It clears on drag, scroll phase, jump, find, focus, attention request, send start and card removal.
- Native evidence: `XCTAssertFalse(app.buttons["jumpToLatest"].exists)` runs for all three iPhone and iPad opening
  variants. `questions-v2-native-opening.png` shows no pill on iPhone default, dark or AX XL, or on iPad.
- Test: `transcript-ui.test.ts:572-574` asserts no pill on opening and a pill after a wheel. The "card removed →
  follow" web branch has no unit test (N1).

### M2. Native placement never released, so following stayed off: closed

- Release now also fires when the card is fully inside the viewport (`:380`), and then sets `following = atEnd`.
  On iPad the card is clamped at the end, so `atEnd` is true and following resumes at once.
- `interacted` resumes following when at the end (`:369-371`). `sendStarted` (`:372-376`, called first in
  `sendAnswers`, `:900`) clears both pending states, sets `following = true` and scrolls to latest. That covers
  the long-card iPhone path too. Its card never fits, so it only releases at the top with `following = false`.
- Card removal while `questionPosition` is still set (for example, answered on another device) follows and scrolls
  (`:258-264`).
- Evidence: `testShortQuestionFollowsItsLongReply` taps one choice, sends, and asserts the final message sits
  inside the transcript frame with no jump button. Per the logs it passed on both devices.
  `questions-v2-ipad-follow.png` and `ios/questions-short-long-reply.png` show the long reply followed to
  "Your Saturday plan is ready." with no pill.
- My second risk from review 09 (VoiceOver or keyboard scrolling pulled back to the card) is now mostly moot.
  Placement stops repeating once the card lands or fits, so it can no longer pull a reader back after that. It is
  still not verified with VoiceOver.

### M3. 11 px phone failure text: closed

- `.conversation-panel .notice.error { font-size: 0.875rem; line-height: 1.5 }` (`transcript.css:134`) at
  specificity 0,3,0 beats the phone media `.notice` rule. The capture asserts `errorFontSize` 14. The 390 and 320
  frames in `questions-v2-web-review.png` wrap to two clean lines with the 44 px dismiss target. Both submissions
  carry identical payloads.
- Scoped to the conversation panel. Error notices on other phone panels keep the old size. That is outside this
  review.

## Verify before iPhone approval

### V1. The jump pill probably returns after the first tap on a long card (iPhone, plausible, unverified)

- Path: on iPhone default text the card is taller than the viewport. It releases at the top with
  `following = false` and `atEnd = false`. Only `questionPosition` hides the pill.
  1. Tapping "River loop" calls `advance(after:)`, which calls `scrollTranscript`. That runs an animated
     `proxy.scrollTo(..., anchor: .center)` (`:322`).
  2. `OnDrag.beganScrolling` fires on `.animating` and `.tracking` (`:1226`), so `questionPosition` becomes nil.
     A tap may already enter `.tracking`.
  3. `interacted` keeps `following` false because the reader is not at the end.
  4. The overlay condition `!following && !atEnd && questionPosition == nil` is now true. My geometry estimate
     puts about 140 pt of card below the centered second question, which is above the 100 pt `atEnd` threshold.
- Result: "Jump to latest" would cover the lower part of the same card one tap after opening. That's the M1 defect
  again, not triggered by a reader scroll. Nothing newer than the card exists.
- Why it isn't covered: the tour swipes to the bottom before it taps (`ScreenshotTourTests.swift:170-171`). The
  short-question test ends at the end, so `atEnd` is true there. On web, `advance()` only moves focus, which isn't
  an intent, so web is unaffected. On iPad the fixture card fits, so following resumes.
- Check: in `testQuestionsDesignReview` for `questions-loaded` on iPhone, tap `questionOption-plan-0` right after
  the opening assertions, wait for the scroll, and assert `!app.buttons["jumpToLatest"].exists`.
- If it fails, the smallest fix is to call `beganScrolling` only on `.interacting` (and `.decelerating` if
  wanted). Placement already stops after it lands, so `.tracking` and `.animating` are no longer needed to stop
  pull-back. Programmatic scrolls from `scrollTranscript`, jump and find already clear the state they own.

## Linked polish in this delta

- Helper text now reads "Answer every question to send." / "Ready to send." / "Answers sent." on both platforms
  (`AttentionCard.tsx:117`, `ConversationView.swift:833`). The duplicate native `.accessibilityHint` is gone. This
  closes review 09 polish 1.
- Success is announced: web through `role="status"` on the helper, native through an explicit
  `Announcement("Answers sent.")` after acceptance (`:912`). This closes polish 2 at source level. There was no
  VoiceOver run.
- `ErrorBanner` no longer announces on appear (`RootView.swift:291-307`). `ConversationView` announces each
  changed `store.error` while visible (`:115-117`). Retry calls `dismissError()` first, so a repeat failure with the
  same text changes nil → message and announces again. This closes polish 3. The other ErrorBanner call sites are
  back to base behavior with no announcement. That isn't a regression.
- Annotations checked: all seven before/after pairs match the screenshots. Native retry before shows the stale
  error after acceptance, and after clears it. The web recovery and writing panel titles are cut off at the
  right edge ("Readable recovery inst…"). That's cosmetic and only matters if they ship in a PR.

## Nonblocking follow-ups

1. N1. Add a web unit test for the opened clarify card disappearing: `atQuestion` clears, the mode goes to
   `follow`, and the transcript pins to the end. Native has the equivalent UI test. Web has none.
2. N2. After acceptance, the helper "Answers sent." sits directly above the disabled "Answers sent" button
   (`web-questions-answers-sent.png`). Hide the helper once settled, or give the button a different label.
3. N3. After answering, both platforms follow to the end of the reply, so a long reply opens at its last lines
   (`questions-short-long-reply.png`). I asked for this in review 09. A normal send instead anchors the sent
   message near the top so the reply is read from its start. Consider anchoring the answer the same way for
   consistency. Decide in the composer or status dock pass.
4. Still open from review 09: 4 (desktop and tablet card flush under the header,
   `web-wide-openings.png`), 5 (eyebrow case differs), 6 and 7 (composer copy, Stop, and AX/200% footprint,
   assigned to the composer pass), 9 (`dismissError` also dismisses `connectionError`), 10 (Cmd/Ctrl+Enter).
   Item 8, the `blocked → idle` avatar mapping, must be checked in the Approvals review.

## Limits

- Accepted without re-running: `questions-v2-tests.log` (51 + 1 tests), `questions-v2-build.log`, the two native
  xcresults and the v4 logs, and the fingerprints the brief quotes.
- Web acceptance still uses a mock reload, not live SSE. Native acceptance uses the fixture refresh.
- No physical device, VoiceOver, hardware keyboard or trackpad run. The scroll-phase release and both success
  announcements are verified by source reading only.
- V1 is a code-path inference with a geometry estimate. No screenshot shows it either way.
- Collages written for this review are in `reviews/10-collages/`: `ios-flow.png`, `web-wide-openings.png`,
  `web-flow.png`, `annotated-ios.png` and `annotated-web.png`.
