# Conversation and composer web recheck

Reviewer: Claude Opus 5.5, high effort. The implementer was OpenAI GPT-6.1 Sol, so this review is cross-provider.
Scope: the web part of the diff between `05-conversation-input.patch` and `06-conversation-input.patch`, and the rendering it affects. That is the new `--message-meta` token in `src/styles.css` (light `#5f685e`, dark `#a6b4a7` in both dark blocks), `.message-attribution` using it, the removed `.message-unconfirmed .message-delivery` amber rule, the textarea `min-height: 3rem`, and the `capture-design.js` checks for metadata contrast and keyboard focus. Type, width, Home and Today were settled in earlier reviews and I did not review them again. I read the native changes in the patch only to keep them out of this score.
Evidence: the fresh `after/web-conversation-*.png` captures, written at 00:03, after review 05 at 23:58. Also `conversation-v2-after.json`, `conversation-v2-build.log`, the `before/` captures, and the review 05 collages. My collages and crops are in `reviews/06-collages/`.
Not performed by me: tests, builds, browser runs, simulator runs or any interaction. I accepted the reported build, the browser report and the 76 focused tests from the earlier run as given. The 76 tests ran before this styling-only correction and were not rerun. That is reasonable because the web delta has no JavaScript behavior changes.

## Scores

| Surface | Score | Gate |
| --- | --- | --- |
| Web conversation | 9/10 | Passes |
| Web composer | 9.5/10 | Passes |
| Native iPhone and iPad | Not scored | Pending. No fresh native captures exist |

The web screen meets the 9 bar. The whole Conversation screen cannot advance yet because the native gate is still open.

## Resolved from review 05

1. **User-bubble metadata contrast. Resolved.** `.message-attribution` now uses `var(--message-meta)` (`src/styles.css:554`). I recalculated from the tokens. On the light bubble `#e7eee4` it measures 4.89:1, which matches the browser's computed 4.891. On the light surface it measures 5.45:1. In dark mode it measures 5.57:1 on the bubble and 7.57:1 on the surface. The `.message-delivery` span sits inside the attribution, so delivery labels inherit the same color. In `crop-desktop-bubble-before-after.png`, "Nicolas  Yesterday, 2:00 PM" is visibly firmer than before and still reads as secondary to the 16 px message text.
2. **Amber "Not confirmed yet" removal. Correct.** The old `--attention` `#9b6733` measured 4.05:1 on the light bubble, so it failed too. Removing it was the right call. The written status still shows (`src/app/Conversation.tsx:400`). No capture shows the unconfirmed state, so I checked this from the source only.
3. **Code-focus evidence. Resolved.** `after/web-conversation-code-focus.png` now shows a clear green focus ring on "Copy code", which differs from the copied-code capture. The capture script reaches the button with Shift+Tab then Tab and fails if `:focus-visible` does not match. The report shows `codeKeyboardFocus: true`.
4. **200% composer placeholder. Resolved.** With `min-height: 3rem`, `after/web-conversation-large-text-latest.png` and `-large-text.png` show "Message Ranch hand..." in full over two lines. Before, it was cut off at "Message Ranch". At 100%, 3rem is 48 px, so the default layout is unchanged. The desktop, phone, 320 px and dark captures confirm that.

## New regressions

None found. The phone, phone dark, 320 px, desktop and desktop dark captures show the same layout as in review 05, apart from the darker metadata. The browser report lists no overflow at any size, `codeCopied: true` and `draftEnabledSend: true`. At 200%, the bubble's attribution wraps the name and time onto two lines. That wrap is the existing `flex-wrap` behavior and reads fine.

## Not blocking

1. **"Sending..." is faint while a message is in flight.** `.message-sending` sets `opacity: 0.66` on the whole bubble (`src/styles.css:572`). That brings the effective metadata contrast to about 2.6:1 in light mode and 3.4:1 in dark mode. It lasts only until Hermes accepts the message, it was already true before this diff, and the faded bubble is the intended "not sent yet" signal. If it bothers anyone, fade the bubble background only and keep the text at full opacity.
2. **"Not confirmed yet" now looks like a timestamp.** The text carries the meaning, so this passes WCAG 1.4.1. It is still a warning shown at 11 px muted, though. A small icon, or an attention color that passes 4.5:1 on the bubble, would help people notice it. This is a design choice, not a defect.
3. **Composer `max-height: 200px` does not scale with text.** At 200%, the textarea holds about four lines before it scrolls. That is usable and was already true. `12.5rem` would match the `min-height` change.
4. **The contrast check covers only the first user bubble in its resting state.** It does not cover sending or unconfirmed bubbles, or assistant metadata on the surface. My calculations above cover those cases. This affects only how complete the evidence is.

As agreed, I did not raise the 7 px classic-scrollbar offset or the platform differences in "Worked for" formatting again.

## Coverage

- Web captures inspected: desktop, desktop dark latest, phone, phone dark, 320 px top and latest, code focus, and 200% top and latest, with before and after compared where both exist. I inspected tablet, draft, composer focus and copied code only through the browser report, because this delta does not change their layout.
- Contrast figures come from the CSS hex values and match the browser's computed ratios.
- The "Today" versus "Yesterday" timestamps differ between the before and after captures because the fixture's dates are relative to the capture date. This is not a product change.

## Pending native

The second native revision is in the patch: `Palette.messageMetadata`, `.fontDesign(.monospaced)` on code, tool output and agent responses, the amber removal on native, and the copy-code step in the UI test. There are no fresh iPhone or iPad captures because the shared Mac slot is still held. I have not scored the native revision, and native fixes 2 and 3 from review 05, along with the iPad gate, stay open. When captures exist, check that the code columns line up in a monospaced font, that the metadata contrast holds on the bubble in light mode, and the iPad edge alignment listed in review 05.

## Verdict

The web conversation and composer pass the 9/10 bar, and the review 05 web finding is closed. The Conversation screen as a whole stays blocked on fresh native iPhone and iPad captures and a native review.
