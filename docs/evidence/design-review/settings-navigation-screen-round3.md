# Settings and navigation screen review, round 3 (final)

- Reviewer: Claude Opus 5.5 (Anthropic), independent of the OpenAI Sol implementation.
- Effort: High was requested. This session cannot see how its internal effort setting maps to that level. This note does not assume it ran below High.
- Code state: `60881595c4f28de908fdfe3c31513f7f2f18ec24` on `nic/full-app-design-review`. The review covers the diff since `33454c2923009a85abfe3d15e730d301afbaaeb3`, plus the code it calls and the code that calls it: `src/App.tsx` panel handling, `src/components/ui/dialog.tsx`, `src/app/use-conversation.ts` `openMessage`, `src/app/transcript-logic.ts` `localMatches`, and `ios/AgentInterface/PreferencesEditing.swift`. Computer DEBUG navigation and capture tools are out of scope.
- Prior rounds: `settings-navigation-screen-review.md` scored 8.0, and `settings-navigation-screen-round2.md` scored 8.5. This is the last round.
- Captures: `/Volumes/DevSSD/scratch/wildbots-design-review/settings-screen-r3/`. Web frames are 1440x1000 and 390x844. The native front is 1206x2622. I read the raw rename error, section, sections, delete, following, palette, filtered palette, Find and Older match frames, the native front, and the `rename-comparison.png` annotation. I did not use `capture-failure.png`. All coordinates are pixels in the named raw image.
- Review crops, made with `sips` from copies: `/Volumes/DevSSD/scratch/wildbots-design-review/settings-screen-r3-review/`. The raw images are unchanged.
- Tags: **Pixel** means seen in a capture and checked in source. **Code** means source only, in a state nobody captured or ran.

## Score

**9.0 / 10. Passes the bar of 9.**

Every round 2 finding is fixed, and the fixes are small and match the existing patterns. The medium-severity failure is gone. A native `close` on the Settings sheet now always clears the app's panel, so Settings can always reopen. A person with an invalid section name has a visible way out. Find no longer jumps when a matching reply arrives. Section summaries count every member and read on one line. What remains is one alignment nit, one stale native error message, one copy difference, and unverified native behavior. None of it blocks a person from finishing a task. No fourth round follows. The remaining items are listed below for whoever touches this code next.

## Round 2 findings, checked

| R2 | Status | Evidence |
| --- | --- | --- |
| 1. Second Escape closed Settings for good | Fixed | Code and test. `PreferencesDialog.tsx:74-78` runs `beforeLeave` for its side effect and then always calls `onClose`, so `panel` in `App.tsx:297` is cleared and `openPreferences` at `App.tsx:135` mounts a fresh dialog. A valid draft saves through the queue. An invalid one is dropped, and the saved name stays. `tests/preferences-dialog-ui.test.ts:136-149` sends a noncancelable `cancel` and then `close` for both a valid and an invalid name. `capture.log` reports `nativeCloseHandled: true` at both widths. As the brief says, this Chromium allowed both Escape cancels (`repeatedEscapeClosed: false`), so the script called `dialog.close()` directly. No capture shows a forced close by Escape. The `close` event from a normal close or an unmount does no harm: `closePanels` at `App.tsx:39-40` does nothing when the panel kind doesn't match, and React detaches the handler on unmount. |
| 2. No way to drop an invalid name | Fixed | Pixel and test. "Keep original name" sits at (791-937, 265-309) in `settings-rename-error-1440.png` and at (217-361, 189-233) in `-390.png`. It is 44px tall and resets the field, clears the error and refocuses the field at `PreferencesDialog.tsx:292`. The footnote now reads "Valid names save with Rename or Back.", which no longer contradicts a failed Back. The test is at `tests/preferences-dialog-ui.test.ts:122-134`. |
| 3. Find jumped to a new matching reply | Fixed | Code and test. `FindBar.tsx:59-61` pins the first revealed match. Local matches carry the needle they were computed for (`:38`, `:52`), so a stale list from the previous query can't pin the wrong message for one render. Typing clears the pin at `:90`. `tests/transcript-ui.test.ts:538-547` expects "3 of 4" after a new match arrives, where the old code showed "4 of 4". `openMessage` is a stable `useCallback` at `use-conversation.ts:461`, so streaming updates don't scroll back to the pinned match. |
| 4. Pinned count rough edges | Fixed | Pixel. `settings-sections-390.png` reads "3 assistants · 2 pinned" on one line at (73-193, 462-478). `settings-sections-1440.png` reads the same at (549-669, 543). "Pinned on home" now appears on section members on web at (557-768, 386) and (557-768, 502) in `settings-rename-error-1440.png`, and at (81-292, 258) in `settings-section-390.png`. The "All pinned" wording is code only, on both platforms (`PreferencesDialog.tsx:221`, `HomeSectionsView.swift:90`). |
| 5. Copy and icon drift | Fixed | Pixel for copy. "Its assistants stay on home, under More assistants." appears in the footnote and the confirmation in `settings-delete-390.png` at (42-292, 386-418). Home's list heading is "MORE ASSISTANTS". The Following row detail is now "Choose whose activity you want to follow" at (549-773, 325) in `settings-sections-1440.png`, and native uses the same text at `PreferencesView.swift:212`. Native's Following title is now "Following" at `HomeSectionsView.swift:57`. The palette's `keyboard` and new `sun` icons are code only: no palette frame scrolls down to Actions or Appearance far enough to show them. |
| 6. Native editing gaps | Mostly fixed, code only | The rename error is announced once when it first appears (`HomeSectionsView.swift:170-171`). Add rejects duplicates and announces it (`:106-110`). ⌘, opens Settings (`KeyboardCommands.swift:32-33`) and, when the Quick Switcher is open, hands off through `onDismiss` (`RootView.swift:204-207`, `:50-51`). It compiles. No native unit test, gesture or VoiceOver run backs any of this. Keystroke validation on rename is unchanged; I accepted that as a calm-enough choice in round 2. |
| 7. Heavy rename error | Fixed | Pixel. The error is now plain red footnote text at (515-823, 231) in `settings-rename-error-1440.png`, and the invalid field's focus ring uses the danger color (`home.css:638`). Crop: `rename-help-1440.png`. |

## Remaining issues, in priority order

### 1. The rename help line starts 12px left of everything else. Severity: nit. Pixel.

- `settings-rename-error-1440.png`: "Valid names save with Rename or Back." starts at x=503. The error above it starts at x=515, and the "Assistants in Weekend plans" heading below starts at x=515. At 390 the help line starts at x=27, while the error and heading start at x=39. `settings-section-390.png` shows the same thing at (27-240, 169). Crops: `rename-help-1440.png`, `rename-help-390.png`.
- Cause: `.settings-footnote` sets a 16px side margin at `home.css:346`. `.section-name-help` uses a 4px margin at `home.css:635`, and `home.css:636` zeroes the footnote's margin inside it.
- Smallest fix: `margin: 4px 16px 12px` on `.section-name-help`. That also pulls "Keep original name" in from x=937 to line up with Rename's right edge at x=925.

### 2. The native Add error stays on screen after the person fixes the name. Severity: low. Code only.

- `HomeSectionsView.swift:106-110` sets `addError` on a duplicate and clears it only on the next Add. If the person edits "Kids" into "Kids 2", the red "A section with that name already exists." stays under the list until they press Add again. Web clears its add error on input.
- Smallest fix: add `.onChange(of: newName) { addError = nil }` to the add row.

### 3. Following explains itself differently on each platform. Severity: low. Code only for native.

- Web's Following page intro reads "Get a notification for every reply and update from these assistants. Shared tasks already notify the people in them." at `PreferencesDialog.tsx:204`, seen at (39-331, 88-128) in `settings-following-390.png`. Native's footer at `HomeSectionsView.swift:55` reads "Shared-task notifications already go to participants. Follow an assistant to receive all their activity." Both are clear. The web text is plainer, so use it on native too.

### 4. Find can lose its place if the pinned message stops matching. Severity: nit. Code only.

- If the pinned message is removed or no longer contains the text, `chosen` at `FindBar.tsx:56` becomes -1. `index` falls back to the newest match, and `selected` still holds the old ID, so the new current match is never pinned. The next arriving match would move the view again. This needs a deleted or edited message during an open Find, which is rare. Re-pinning when `chosen < 0 && selected !== null` would close it.

## What works

- The forced-close fix follows the codebase's rule that a closed native dialog must always tell its parent. It needs no reopen trick, and it keeps the save queue, the account-change discard at `App.tsx:56` and `:125`, and the delete bypass of the name guard.
- The rename page now has a clear path in every state. It has Rename for a valid change, Back that saves a valid name, Keep original name to drop an edit, and an error that says what's wrong. The error, the help text and the action sit together under the field at both widths.
- The section summaries are easier to read than round 2's "0 in section" math. Total membership comes first, then the pinned count, which stays on one line. Members say "Pinned on home" where the person picks them.
- Find's newest match stays put while the assistant is still replying. The fixture's "Working" state in `settings-find-chat-1440.png` (528-745, 482) is the exact case this protects.
- The native Settings front in `native-Preferences.png` is clean and matches web's order and wording: the account card, then Hermes, Computer and Integrations, then Display.

## Coverage gaps, not graded as defects

- Web captures cover Advanced and follow toggles, section create, rename, membership and reorder, cancelled and confirmed delete, the invalid-name error, Keep original name, a valid rename saved through Back, an explicit native close and reopen, the palette, help, Find on the newest match, Older match and Escape. Desktop Chromium only, light mode, default text size.
- Nobody captured: a forced close caused by Escape itself, Find while a matching reply arrives, the "All pinned" summary, the palette's new keyboard and sun icons, the 30-section state, quiet hours menus, sign out, failed-save recovery, dark mode, large text or 200% zoom, a screen reader, or iOS Safari on a real device.
- Native: only the Settings front was captured from a real compiled build. The Following row with its new detail is below the fold in that frame. Native subpages, the rename and add errors, VoiceOver announcements, ⌘,, the Quick Switcher handoff and gestures were not seen or run. Native unit tests did not run on this host.
- Native and web fixture differences, such as account names, release dates and the Start page value, are synthetic data, not parity bugs.
- Palette links to deeper Settings pages remain deferred to #206.
