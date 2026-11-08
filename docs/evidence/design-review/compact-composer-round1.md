# Compact composer and #206 follow-ups: review, round 1

Reviewer: Claude Opus 5.5, Anthropic. Requested effort High. The session
reports a numeric reasoning setting that does not map to a named tier, so I
cannot confirm the effective tier from inside the run. OpenAI Sol and Terra
implemented the reviewed changes, so this is a cross-provider review. Round 1
of at most 3. Head `b630d93` on `nic/design-followups-compact-composer`, base
`3812a91`.

Scope: all product changes in `3812a91..b630d93` and the code those lines
call or are called by. Excluded from judgment: the Anthropic shared-text
durability work, meaning `SharedTextReceipt`, `ShareInbox.transferText`,
`DraftAddition.capture`, `holdShared`, `sharedTextAdded`, `landAdditions`,
`persistDraft` visibility, `sharedTextReceipts` storage, their new tests, and
the `ShareCaptureView` onAppear dedupe and transfer flow. A separate OpenAI
reviewer covers that work. Capture tooling in `.agents/tools/` was not
reviewed.

Method: source reads and saved images only. No browser, tests, builds or
simulator runs. Evidence root:
`/Volumes/DevSSD/scratch/wildbots-design-review/followups-composer/`. My crops
and collages are in its `review-round1/` folder. Collage order:
`web-390-states.png` row 1 is idle, draft, multiline, recording,
transcription-error, transcribed, speaking. Row 2 is audio-ready,
upload-error, upload-retried, large-paste, ime, advanced, offline. The stale
`after/states-collage.png` was ignored. Labels: **pixels** means seen in a
render, **source** means verified only in code, **unverified** means neither
a render nor the code settles it.

## Code findings, separate from the visual score

### C1. The hidden measuring span can make the whole page scroll sideways. Fix before merge.

Source, high confidence. Not covered by any capture.

`src/app/Composer.tsx:107-108` copies the whole draft into
`.composer-measure`. `src/styles.css:764` gives it `position: absolute;
white-space: pre`. Nothing between it and the root is positioned. I checked
`.composer`, `.composer-area`, `.conversation-panel`, `.app-shell`, `body` and
`html`. So its containing block is the initial containing block. The
`overflow: hidden` on `.app-shell` does not clip it, because that element is
not its containing block. `visibility: hidden` still counts toward scrollable
overflow.

Repro: at 390 px, type one line of about 100 characters with no newline. The
span is roughly 750 px wide and starts at the composer's left edge, so
`document.documentElement.scrollWidth` goes past `innerWidth` and the page
scrolls sideways. iOS Safari lets the person pan the layout. The overflow
guard in the capture never triggers because every draft in the capture is
short or multiline.

The same line also writes up to 50,000 characters into the DOM and forces
layout on every keystroke.

Fix: give `.composer` `position: relative`, and give `.composer-measure`
`top: 0; left: 0; max-width: none; overflow: hidden`, or set `contain: layout
paint` on the composer. Measure only `input.value.slice(0, 201)`, since
`shouldStackComposer` stacks anything longer than 200 characters anyway. Add a
capture step at 390 with a 150-character single line, using the existing
`scrollWidth` assertion.

### C2. Routine recipient checkboxes shrink from 44 to 36 px tall. Low.

Source. `src/components/experience.css:160` (`.routine-manager fieldset
.checkbox-label`, specificity 0,2,1) overrides `.settings-dialog
.checkbox-label { min-height: 44px }` (0,2,0, `src/styles.css:1045`). The
routine manager renders inside that dialog (`src/BotSettings.tsx:300, 851`).
That still passes WCAG 2.5.8, but it breaks the 44 px touch convention the
rest of the dialog and this composer follow. Fix: keep 44 px under
`(pointer: coarse)`, or tighten the fieldset gap instead.

The same #206 item asks to "Preserve the card during reload so saved-edit
focus stays in place." This diff changes nothing for that. Either confirm it
was already handled or leave the item open.

### C3. Artifacts: the fix cannot be reached in production, and its test expects a misleading empty state. Low.

Source. `ArtifactsButton` mounts only when `ownConversation` exists
(`src/app/BotDetails.tsx:86`), with a per-bot key. So `current` is never
undefined while the sheet is open, and `hadConversation` has no effect. The
updated test (`tests/artifacts-ui.test.ts:220-224`) now expects "No artifacts
yet" after the conversation disappears. That claim is false whenever the
earlier window had files. If this state can happen, show "Artifacts are
unavailable while this conversation reloads" instead of claiming the list is
empty. If it cannot happen, drop the ref and say so on the #206 item.

### C4. Home and Today deep-link tokens are never cleared. Low.

Source. `RootView.swift:81` and `:91` both run `onChange(..., initial:
true)`, and neither `todayRequest` nor `homeRequest` is reset after it is
handled. If RootView is rebuilt while both are set, both handlers run in
declaration order and Home always wins, whichever link was tapped last.
Setting the token back to nil after navigating removes the problem.
Real widget taps are unverified because no system host or device was
available.

### C5. Dead CSS left by the layout change. Low.

Source. Leftovers in files this change touches:

- `.composer-hint` at `src/styles.css:1154`. The element is gone.
- `.composer-voice` at `src/components/experience.css:84`.
- `.composer-tools .send-button { margin-left: auto }` in the 620 px block, around `src/styles.css:1258`. The send button is no longer inside `.composer-tools`.
- The `@media (max-width: 620px)` rule in `voice-controls.css:9`. It now duplicates the base rule.

One more stale rule matters. The 900 px block still sets `.composer-area {
padding: 8px 22px max(15px, …) }` at `src/styles.css:1151`. Widths from 621
to 900 px therefore keep the old, looser dock while every other width uses
6/12/8. Neither width range was captured.

### C6. Keyboard order no longer matches the inline layout. Low, a11y.

Source. In the inline layout, Attach sits visually left of the textarea but
comes after it in the DOM, so Tab goes textarea, Attach, voice, Send. Starting
in the textarea is defensible. If you keep it, record that it was deliberate.
Otherwise, move `.composer-tools` before the textarea in the DOM. Grid areas
keep the visuals, and the textarea element is not recreated.

### Checked and found correct

- **Keeping the same input element.** Web keeps one textarea and switches only `data-layout`. The capture's `el === expected` and focus assertions pass. Native `ComposerRowLayout` places one `ComposerTextView` subview in both layouts. Stacking is decided from the inline-slot measurement, so the layout cannot flip back and forth on either platform. The ResizeObserver now watches the form and controls, not the textarea whose width the stacking changes.
- **Questions during an outage.** Web blocks both submit and the button, keeps answers in component state and shows the guidance in `role="status"`. The new test covers it. Native already disabled Send while disconnected and now explains why.
- **Definitive refusals.** `refreshed: false` carries a refusal through a failed refresh, the create path no longer reports "may have created" for a 4xx, `uncertain` still locks further changes, and the trigger edit test covers a server message that starts with "Not confirmed."
- **Palette and sign-out.** New Settings commands go to Following, each home section, or Sign out. The palette shortcut is blocked while any dialog is open (`src/app/shortcuts.ts:78`), so an already-mounted sheet never receives a stale `destination`. Sign-out now asks for confirmation, and its focus returns to `#settings-signout`. Three tests were updated for the extra step.
- **Groups.** On web, the repeated "In thread with" line is suppressed only for consecutive events in the same thread, and the first load of a single-page room scrolls to the latest message. On native, the same run logic applies and it scrolls after load. Rooms with more than one page still open at the top on web, which matches the existing forward cursor model.
- **Account boundaries.** Nothing in scope reads across `boot.user.id` or `store.scope`. The composer and voice keys still include the user id.
- **Native batching row.** The picker now has a plain "Batching" label, and the explanation sits below it. That is source only, because no valid render exists. See E1.
- **Shared-draft guard, OpenAI part only.** `botId != savedBotId` blocks the swipe-down once the assistant is changed. The 50,000-character checks use `.count`, which matches `ShareInbox.valid` and the share extension. A text that fits in characters but runs over in UTF-16 still falls to the existing "combined draft is too large" message, which is accurate.
- **Unsupported microphone.** The record button is now enabled. Tapping it shows the specific `role="alert"` error, and the tooltip still explains the problem. That is acceptable and covered by a test.

## Evidence defects

- **E1.** `after/native-Groups.png` and `after/native-Notifications.png` both show the **Widget preview** page, not Groups or Notifications. The native Groups thread-run change, scroll-to-latest and the batching picker therefore have no valid render. Recapture them, or mark them source only.
- **E2.** The large-paste frame says "34 KB" while the chip shows "TXT · 38 B". That comes from the fixture upload route returning `size: 38`, not from the product. Not graded.
- **E3.** In `ime-390` the textarea is stacked and two lines tall around "にほんご". The capture presses Enter during a CDP composition, which probably inserted a newline. A real IME commits on Enter. Not graded as a product defect. Nothing was sent, as asserted.

## Composer visual score: 7.6 / 10, round 1 of 3, not yet passing

This score covers the whole composer screen on web at 1440, 390 and 320 px
and on native iPhone. Avatar and demo transcript styling are excluded.

What works, seen in the renders: the idle web card is a clean 54 px pill at
1440 and 390, down from 132 px. That gives about 78 px back to the transcript
on a phone, as `composer-phone-before-after.png` shows. Short drafts stay
inline at 1440. Multiline drafts stack with the controls on one bottom row and
grow to the cap. Recording, the transcription error, speaking, upload failure
and retry, and offline states all fit the new card without clipping. Native
idle, focused, dark and multiline match the web proportions, with the 26 pt
continuous corner and 44 pt targets. AX3 stacks as designed.

### Issues, most important first

1. **Pixels, web.** After one "Listen to reply", a "Play audio" button stays in its own row for the rest of the session. It adds about 56 px under the controls. It shows in `audio-ready`, `upload-error`, `upload-retried`, `large-paste` and `ime` at both widths, from 1440 at y≈955-1000 down to 390. The button used to sit inline in the tool row, so moving it into `.voice-panel` cancels much of the compaction once a person has listened to a reply. Fix: make it a transient inline state of the speaker button, for example a play glyph for about 30 seconds or until the next send. You could also clear `playable` when `reply.id` changes, which also stops it replaying an old reply.
2. **Pixels, web 390.** Two voice buttons leave the inline slot about 166 px wide (366 − 8 − 44 − 92 − 44 − 12). Any draft longer than about 20 characters stacks right away. "Can you check the gate before dinner?" makes a 98 px card in `draft-390`. The rule is behaving correctly, but on a phone the compact state mostly lasts until the first few words. Both references, Grok and t3code, keep only attach, input, mic and send in the row. Suggestion: on narrow widths, hide "Listen to reply" while the draft has text, or move it onto the reply bubble. That buys about 48 px, enough for a short sentence.
3. **Pixels, web 390.** The placeholder is cut off mid-ellipsis as "Message Ranch hand." (`idle-390`, `composer-phone-before-after.png` right). `white-space: nowrap` with no `text-overflow` cuts it at the edge. Use a shorter narrow-width placeholder, such as "Message", or set `text-overflow: ellipsis; overflow: hidden` on the placeholder and test it in Chromium and WebKit.
4. **Pixels, native AX3.** The mic and speaker glyphs grow with Dynamic Type, but their frames stay 44 pt. In `native-ComposerAX3.png` the speaker glyph is wider than its frame and touches the Send circle, which stays small. Spacing 4 leaves no visual gap. Fix: cap the glyph sizes with `.dynamicTypeSize(...accessibility1)` or a `@ScaledMetric` frame, and make Send scale the same way. Increase the trailing gap at accessibility sizes.
5. **Pixels, native focused.** The placeholder shrinks to "Message Ran..." once the hide-keyboard button appears (`native-ComposerFocused.png`). It is legible but loses the assistant's name, so the same placeholder change as item 3 applies.
6. **Pixels, web.** The voice status and error lines are about 12 px and muted or red, in the bottom-left of the panel (`recording-*` "Recording", `transcription-error-*`). The error is the only explanation of the failure, so it should use the 13 px used by the attachment error just above it in `upload-error-390`.
7. **Unverified, native.** `card.fixedSize(vertical: true)` together with `maximumLines` 6 at accessibility sizes means that on a small phone in portrait with the keyboard up, AX3 or larger could make the card taller than the space left. That would push the transcript to zero or clip the header. There is no render of AX plus keyboard plus multiline. Consider 3 lines when `dynamicTypeSize.isAccessibilitySize`, as compact height already does.
8. **Not captured.** No frame at 621-900 px, where the old 22/15 px dock padding still applies (see C5). There are also no native voice-state renders.

Passing needs items 1 to 4 fixed, plus C1 above. Items 5 and 6 are quick
polish. Items 7 and 8 need either a capture or a deliberate, documented
choice.

## Validation not done in this review

The implementer reports these results, and I did not repeat them: 1529 web
tests passed after one outdated sign-out test was updated, 99 affected tests
passed, both builds passed, and native app and extension captures passed under
`mac-heavy-lock`. Native XCTest cannot run because of the CoreSimulator and
Xcode mismatch. No connected iPhone, so real EventKit, push, share host,
widget taps and VoiceOver remain unverified.
