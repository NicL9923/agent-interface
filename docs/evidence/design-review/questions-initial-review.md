# Review 09: Questions

Reviewer: Claude Opus 5.5, high effort. Cross-provider review of a GPT-6.1 Sol implementation.
Base: `810183606d7536df493b1dbcd7f030240676ef63`. Reviewed: tracked diff `09-questions-input.patch`, the untracked
`.agents/fixtures/questions-design.json`, and the final captures listed in the brief. The live `git diff 8101836`
matches the frozen patch except for the ledger "Questions" section added afterward. No source was changed and nothing was
built or run.

## Verdict

**Do not proceed to Approvals yet.** Three must-fix items remain. Two show in the opening screenshots on three of
the four surfaces, and one is a native scroll regression. All three are small, scoped fixes. After them, a scoped
recheck should be enough: the opening captures at 320, 390, desktop and tablet widths, native iPhone default/dark/AX
opening, and one native iPad answer-then-reply check.

| Surface | Score | Blocking reason |
| --- | --- | --- |
| Web desktop (1440, light/dark) | 8.5 | "Jump to latest" sits over the card on opening (M1) |
| Web phone (320/390/768, dark, 200%) | 7.5 | M1 covers choices at 320 and 390; the failure message is 11 px (M3) |
| Native iPhone (default, dark, AX XL) | 8 | M1 covers a choice at default and dark sizes and the card description at AX XL |
| Native iPad (default, dark, AX XL) | 8.5 | Looks right, but answering a card that fits leaves the transcript not following (M2) |

Without M1 to M3, I would score the card itself at 9 to 9.5 on every surface. The hierarchy, field treatment,
option targets, retry and duplicate handling are all good.

## Must fix

### M1. "Jump to latest" covers the question on opening (web and iPhone)

- Evidence:
  - `after/web-questions-initial-phone.png`: the pill covers "A picnic packing list". This is the real opening capture.
  - `after/web-questions-narrow.png` (320): it covers the first question's third choice, "Write my own answer".
  - `after/web-questions-tablet.png`: it covers "Anything else I should know?".
  - `after/web-questions-desktop.png`: it sits on the "Your answer" field.
  - `after/web-questions-large-text.png`: it covers the card description.
  - `after/ios/questions-loaded.png` and `questions-dark.png`: it covers "An offline route map".
  - `after/ios/questions-large-text.png`: it covers the description, "a route and a simple packing list".
  - The annotated `questions-ios-opening.png` and `questions-web-opening.png` call this state clean. They don't
    mention the pill.
- Cause: opening at the card leaves the reader off the end on purpose.
  - Web: `use-conversation.ts:338-341` sets `mode.current = "free"`, so `!history.atLatest` shows the button at
    `Conversation.tsx:267`.
  - Native: `ConversationView.swift:240` sets `following = false` and `atEnd` is false, so the overlay at
    `ConversationView.swift:275` shows.
- Why it blocks: this is the screen's first impression. The pill hides an answer choice or the request text at
  every phone size. The label is also wrong here. Nothing newer than the card exists; "latest" only means the card's
  own bottom edge. The status dock already covers the "there is more below" job.
- Fix direction: while the opening placement is still the reader's position, with no scroll, drag or wheel yet, hide
  the jump control. Native: add `openingCard == nil` to the overlay condition. Web: track the opened-card state the
  same way, or treat a pending attention card that ends the transcript as "latest" once its top is in view. After
  the reader scrolls, the current behavior can stay. Add a capture assertion that no `.jump-latest` or jump button
  intersects `.attention-card` on opening.

### M2. Native opening placement never releases when the card can't reach the top, so following stays off after answering

- Evidence:
  - `after/ipad/questions-loaded.png`: the card starts about 140 pt below the viewport top. The live row and
    whitespace sit above it because the transcript is clamped at its end. The release check at
    `ConversationView.swift:361-362` needs `abs(top) <= 1`, so it never passes in this case. This happens on iPad,
    and on iPhone for any short question that fits on screen.
- Consequences, from reading the code:
  1. `following` was set to false at `:240`. The guard added at `:437` (`&& openingCard == nil`) stops the
     end-of-transcript check from turning it back on while the card is pending.
  2. When the reader answers by tapping, `interacted` (`:226-228`) clears `openingCard` but leaves `following` false.
     With no scroll event, nothing resets it.
  3. When the request is removed, the handler at `:254-260` restores following only when `openingCard` is still set.
     By now it's nil, so the handler does nothing.
  4. When the card disappears and the reply streams in, `contentMoved` (`:425-433`) skips `scrollToLatest`. The
     reply grows off screen behind a jump pill.
  5. On the base commit, the chat opened following at the end, and taps never changed that, so this is a
     regression. It hits the most common case: one short question answered without scrolling.
  - The capture doesn't show it, because the fixture's `afterAnswer` content fits the iPad screen.
- Second risk, plausible but not verified: until the reader drags or taps, every geometry change of the card calls
  `placeOpeningCard` (`:362`, `:331`, `:431`). `OnDrag` (`:1193-1199`) listens only for `.interacting`. VoiceOver
  three-finger scrolling, VoiceOver moving focus to an earlier message, and keyboard scrolling probably don't report
  `.interacting`, so those readers may get pulled back to the card. Needs a VoiceOver check on a device or
  simulator.
- Also unverified: whether the iPhone card reaches the release condition at all. The `transcript` coordinate space
  sits on a scroll view whose content runs under the navigation bar. If its origin isn't the visible top, `top`
  never reaches 0 there either, and both consequences apply on iPhone too.
- Fix direction:
  - Release the pending placement once it has been applied and either the card's top is in view at the top, or the
    transcript is at its maximum offset.
  - When the opening card is released or its request is removed, set `following = atEnd`. When the request is
    removed with the reader at the end, follow and scroll to latest.
  - Add a UI test: one-question fixture on iPad, answer by tap, append a reply taller than the viewport, then assert
    the latest message is visible and no jump button exists.

### M3. Web phone failure message is 11 px

- Evidence: `after/web-questions-submit-error.png`. "The connection was interrupted. Your answers are kept. Try
  again." renders far smaller than the 16 px card text beside it, in red on the raised surface.
- Cause: `styles.css:1263-1266` sets `.notice` to `0.6875rem` in the phone media query. The base is `0.75rem` at
  `:801-805`. This delta enlarged only the dismiss button (`transcript.css:188`).
- Why it blocks: this message is the recovery instruction for the screen's failure state. It's the smallest text on
  the page, while native renders the same message at footnote size or larger (`after/ios/questions-submit-error.png`).
- Fix direction: give `.notice.error` at least `0.875rem` with matching line height on every width. Check the
  320 px wrap.

## Accepted improvements

- Native opening no longer clips the first choice. Frame assertions in `ScreenshotTourTests.swift` cover normal and
  dark sizes on both devices. The web places the clarify card once, before paint, and keeps the reader's position on
  refresh. `tests/transcript-ui.test.ts` covers this.
- Written answers are multiline on both platforms. They have a readable "Your answer" prompt, a 44 pt minimum, an
  accent focus border on native, and a visible web focus ring (`web-questions-own-answer-focus.png`). They no longer
  repeat the question in faint placeholder text.
- Number keys inside a written answer no longer select options (`AttentionCard.tsx:61`), and a test covers it.
- Duplicate prevention works:
  - Web: a `busy`/`settled` guard in `onSubmit`, a disabled fieldset after acceptance, and the "Answers sent" label.
  - Native: `guard !busy && !settled`, `.disabled(settled)`.
  - Tests and the capture assert two identical payloads and no third.
- Retry clears the stale error first (`report("")` / `store.dismissError()`) and keeps every answer. Native error
  banners now use `Palette.danger`, have a 44 pt dismiss target, and post a VoiceOver announcement.
- Hierarchy is more legible: 16 px legends, the "Choose any that apply" helper on its own line, 24 px spacing between
  questions, `message-meta` key hints, and 44 pt native option rows.
- At large text, the decision dock now wraps and keeps the full count with Review below it. The send/stop glyph is
  capped inside its 44 pt circle. This fixes the before-state truncation in `annotated/questions-ios-large-text.png`.
- The question helper, the official-interface paragraph and the activity shimmer now use `Palette.muted`. That closes
  the review08 follow-ups assigned here.
- The character stays recognizable while waiting, and the card and dock carry the state. The annotations' pointers
  for this and for the field changes check out against the screenshots.

## Nonblocking polish

1. "Answer every question to send." stays visible once everything is answered and after "Answers sent"
   (`web-questions-answers-sent.png`, `ios/questions-answers.png`). Show it only while Send is disabled, or swap it
   for a short sent confirmation. On native, the visible text plus `.accessibilityHint` makes VoiceOver read the same
   guidance twice.
2. Success isn't announced. Web has no live region for "Answers sent", and native gives only a haptic. Add a polite
   announcement.
3. `ErrorBanner` now announces in `.onAppear` at every call site, about 30 of them, many inside `List` sections such
   as `BotSettingsView`, `ModelPickerView` and `CollaborationViews`. Rows can re-appear on scroll or navigation and
   re-announce an old error. Consider announcing only on a new message, or at report time.
4. In web scroll captures the card can sit flush under the header, with its rounded top hidden
   (`web-questions-desktop.png`). A 12 to 16 px scroll margin would read as intentional. The real opening at 390 has
   a gap.
5. Web eyebrow is uppercase ("A QUESTION FOR YOU") while native uses sentence case. Pick one.
6. While the assistant is blocked on the person, the composer still reads "Guide Ranch hand while they work…" and
   shows Stop. Assign this to the composer and status dock pass.
7. At AX XL on iPhone and 200% on web, the dock and composer take about half the screen. This predates the delta;
   assign it to the composer pass.
8. The header and live-row avatar now map `blocked` to `idle` on both platforms (`ChatHeader.tsx:42`,
   `Conversation.tsx:225`, `ConversationView.swift:155,533`). This also changes the Approvals waiting state, so
   confirm it in the Approvals review.
9. Native `sendAnswers` calls `store.dismissError()`, which also marks any current `connectionError` dismissed
   (`AppStore` `dismissError`). Send needs `store.connected`, so the risk is low. Clearing only `error` would be
   cleaner.
10. Enter in a web written answer now adds a newline instead of submitting the form. That's fine for multiline, but
    a Cmd/Ctrl+Enter shortcut would help keyboard users.

## Limits

- Only the 390x844 light web capture is a real opening. The desktop, dark, narrow and tablet captures use
  `scrollIntoView` (`questions-after-capture.js:108`). The web 200% capture sets the root font size after the failure,
  so its error banner is carried over. It isn't a 200% opening.
- The native AX XL opening isn't asserted. Its first choice is off screen by design, and only scroll captures cover
  it.
- I found no VoiceOver session, physical device, hardware keyboard or trackpad run. M2's second risk and polish
  item 3 need one.
- Web acceptance uses a reload, not live SSE. Native acceptance uses the debug fixture's refresh.
- I didn't verify whether the iPhone opening placement ever releases (see M2). The test checks visibility, not
  release.
- I accepted the reported test and build results from `questions-tests.log`, `questions-build.log` and the native
  `summary.txt` files without re-running them. I inspected individual final screenshots and four of the six
  annotations. I did not use stale root collages.
