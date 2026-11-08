# Settings and navigation screen review, round 2

- Reviewer: Claude Opus 5.5 (Anthropic), independent of the OpenAI Sol implementation.
- Effort: High was requested. This session cannot observe how its internal effort setting maps to that level. This note does not assume it ran below High.
- Code state: `33454c2923009a85abfe3d15e730d301afbaaeb3` on `nic/full-app-design-review`. The review covers the diff since `11703c787998c5698141833af6273afb61fe0283`, the code that calls it, and the code it calls.
- Prior findings: `docs/evidence/design-review/settings-navigation-screen-review.md`, round 1, scored 8.
- Captures: `/Volumes/DevSSD/scratch/wildbots-design-review/settings-screen-r2/`. Web frames are 1440x1000 and 390x844. I read every raw frame that changed this round and the `find-comparison.png` annotation. The native Settings front is still `settings-screen-r1/native-Preferences.png`, and its code did not change. All coordinates are pixels in the named raw image.
- Review crops, made with `sips` from copies: `/Volumes/DevSSD/scratch/wildbots-design-review/settings-screen-r2-review/`. The originals are unchanged.
- Tags: **Pixel** means seen in a capture and checked in source. **Code** means source only, in a state nobody captured or ran.

## Score

**8.5 / 10. Not passing. The bar is 9.**

The round 1 problems that a person would hit first are fixed, and the captures show it. Find now lands on the highlighted word. Section delete asks first and puts focus on the safe choice. A valid rename survives Back. Section rows explain pinned members, and phone reorder targets are 44px. The score stops at 8.5 because the new rename guard adds one real failure. With an invalid name, a second Escape closes the Settings sheet without telling the app, and Settings then won't open again until something else replaces the panel. The guard also gives the person no way to drop a bad edit. Both have small fixes, and a few low-severity copy and parity items remain.

## Round 1 findings, checked

| R1 | Status | Evidence |
| --- | --- | --- |
| 1. Find match not shown | Fixed | Pixel. `settings-find-chat-1440.png` shows "5 of 5" with "gate" highlighted at (598-632, 210-232). At 390 the highlight is at (86-119, 203-224). After Older match, `settings-find-older-1440.png` shows "4 of 5" and the table header "Gate" highlighted at (541-573, 210-228). At 390 it is at (33-65, 203-220). `src/app/use-conversation.ts:315-317` scrolls to the first range in the message and falls back to the message top. |
| 2. One-click delete | Fixed | Pixel. `settings-delete-1440.png` shows "Delete Weekend plans?" at (520-920, 420-580), with Keep section first. The test at `tests/preferences-dialog-ui.test.ts:90-100` asserts that cancel saves nothing. |
| 3. Rename lost on Back | Fixed for valid names | Pixel and test. See findings 1 and 2 for invalid names. |
| 4. Pinned counts | Mostly fixed | Pixel. `settings-sections-1440.png` (549-718, 543) reads "1 assistant in section · 2 pinned". See finding 4 for what remains. |
| 5. Ctrl+F on Mac | Fixed | Code and test. `src/app/Conversation.tsx:112` uses `matchCombo`, and `tests/transcript-ui.test.ts:502-516` can fail on the old check. |
| 6. Section limit on web | Fixed | Code and test. `PreferencesDialog.tsx:237` swaps Add for the native wording at 30. |
| 7. Square rename card | Fixed | Pixel. The rename card at (499-941, 160-217) in `settings-rename-error-1440.png` is rounded. It uses 20px, while other groups use 18px. That difference is too small to see. |
| 8. Blue native clear button | Fixed | Pixel. Neither Find frame shows it. |
| 9. Copy drift | Partly fixed | "Follow device" and "Not following any assistants" now match. See finding 5. |
| 10. Palette reach and icons | Deferred to #206, icons unchanged | See finding 5. |
| 11. 36px reorder on touch | Fixed | Pixel. `settings-sections-390.png` (265-355, 355-480). Crop: `sections-pinned-390.png`. |
| 12. Native rules | Partly fixed | Code only. Rename now validates, and the Quick Switcher lists Settings. See finding 6. |

## Prioritized findings

### 1. A second Escape with an invalid name closes Settings, and Settings won't reopen. Severity: medium. Code only, Chromium.

- The state starts in `settings-rename-error-1440.png`: the field at (511-828, 163-212) holds the duplicate "Around the house", and the error is at (515-925, 225-270).
- Typing in the field counts as user activation. The first Escape fires a cancelable `cancel`. `PreferencesDialog.tsx:76-80` prevents it, `go` asks `beforeLeave`, and the page stays open with the error. That cancel uses up the activation. Under the HTML close-watcher rules, Chromium fires the next Escape's `cancel` as not cancelable and closes the native dialog anyway.
- The `close` event reaches `close()` at `PreferencesDialog.tsx:59`. `beforeLeave` still returns false, so `onClose` never runs. The `<dialog>` is closed, but `panel` in `src/App.tsx:297` is still `preferences`. `openPreferences` at `App.tsx:135` sets the same panel kind again. `Dialog`'s effect at `src/components/ui/dialog.tsx:55-68` only depends on `[element, open]`, so it never calls `showModal()` again. The account button and the palette's Settings entry then do nothing until some other action clears the panel or the page reloads.
- The codebase already handles this case. `src/BotSettings.tsx:308-316` calls `showModal()` again after a noncancelable close, and `dialog.tsx:76` leaves a comment for guarded editors about it. The new guard doesn't follow that pattern.
- The tests at `tests/preferences-dialog-ui.test.ts:102-120` only send a cancelable `cancel`, so they can't catch this.
- Smallest fix: never skip the parent `onClose` once the native dialog has closed. On `close`, save a valid name and then call `onClose`. Drop an invalid draft, since the person has already seen the error once and pressed Escape again. This also fixes finding 2. If you'd rather keep the page open, reopen it with `showModal()` the way BotSettings does. Add one test that sends a non-cancelable `cancel` and then `close` with an invalid name, and asserts that `onClose` ran or the dialog is open.

### 2. Web has no way to drop an invalid name. Severity: low to medium. Pixel and code.

- `settings-rename-error-1440.png` and `-390.png`: once the name is a duplicate, Back at (493-537, 101-145) and Escape both refuse to leave. The only control is Rename at (835-925, 169-207), and it fails too. To get out, the person has to retype a name they never wanted.
- The footnote at (515-796, 288) says "The name saves with Rename or when you go back." Right after a failed Back, that line contradicts what just happened.
- Native handles the same input better. `ios/AgentInterface/HomeSectionsView.swift:137-145` keeps the old name, says "The previous name is still saved.", and lets the person leave.
- Smallest fix: when `changed` is true, show a quiet "Cancel" next to Rename that resets the field to `section.name`. Alternatively, use native's rule and let Back leave with the old name kept, as long as the error has already been shown once. Pick one rule and use it on both platforms.

### 3. Find jumps to a new matching reply while the person is reading. Severity: low. Code only.

- Until the person steps through matches, the current match is always the newest one: `FindBar.tsx:56-57` with `selected` set to null. The effect at `FindBar.tsx:58-60` runs whenever `current.messageId` changes. If a streaming reply starts to contain the search text, "5 of 5" becomes "6 of 6" and the transcript scrolls away from the match the person was reading. The fixture's assistant is mid-reply, "Working", in `settings-find-chat-1440.png` (528-765, 482).
- The branch just fixed reading position elsewhere (`0a6fc93`), so this is the same kind of bug.
- Smallest fix: after the first reveal, pin the match with `setSelected(current.messageId)`. New arrivals then change the count, for example to "5 of 6", without moving the view.

### 4. The pinned count still has three rough edges. Severity: low. Pixel and code.

- At 390 the summary breaks between the number and its noun: "· 2" and then "pinned" on the next line, at (73-232, 455-483) in `settings-sections-390.png`. Crop: `sections-pinned-390.png`. Put a non-breaking space between the number and "pinned", or keep "· 2 pinned" in one `white-space: nowrap` span.
- When every member is pinned, web shows "0 assistants in section · 2 pinned" from `PreferencesDialog.tsx:218`, through `assistants(0)` at `:25`. Native shows "No assistants in section · 2 pinned" from `HomeSummary.assistants` at `HomeSectionsView.swift:35`. Use the native wording on web.
- The section page still doesn't say a member is pinned. Ranch hand and Garden planner are pinned, yet they show only "In Around the house" at (557-668, 384) and (557-668, 500) in `settings-rename-error-1440.png`, and at (81-192, 254) in `settings-section-390.png`. Both platforms build this note the same way: `PreferencesDialog.tsx` BotChoice detail and `HomeSectionsView.swift:150`. Add ", pinned on home" for pinned members on both.

### 5. Some copy and icons still differ. Severity: low. Pixel and code.

- The delete footnote and the new confirmation both say "Its assistants stay on home, in the main list." See `PreferencesDialog.tsx:305-306` and `settings-delete-1440.png` (543-812, 485). Home's heading for that list is "MORE ASSISTANTS", at (26-147, 441) in `settings-find-chat-1440.png`. Native's "Its assistants move back to More assistants on home." at `HomeSectionsView.swift:159` names what the person will see. Use it on web in both places.
- Under "Not following any assistants", the detail "All their activity, not only shared tasks" has nothing for "their" to refer to. See (549-752, 305-325) in `settings-sections-1440.png` and `PreferencesDialog.tsx:137-138`. Use "Get every update from chosen assistants", or hide the detail when the count is zero.
- Following is still titled "Following" on web and "Follow all activity" on native, at `HomeSectionsView.swift:57`.
- The palette still uses `sliders` for Keyboard shortcuts, at `CommandPalette.tsx:70`, while Settings uses `keyboard`. It also uses the calendar `today` icon for Light at `:73`. These are one-word changes, separate from the deferred #206 work.

### 6. Native editing gaps remain. Severity: low. Code only, nothing native ran.

- The native rename error isn't announced. `HomeSectionsView.swift:145` adds `.updatesFrequently`, which doesn't make VoiceOver speak. The rest of the app posts `AccessibilityNotification.Announcement`, for example at `ReplyActions.swift:30`. Announce when the error first appears, not on every keystroke.
- Native validates on every keystroke at `HomeSectionsView.swift:137-142`. The duplicate error flashes while someone types past a matching prefix, for example on the way to "Around the house 2". This isn't wrong, but it is noisy. Showing the error only after a pause or on submit would be calmer.
- Native Add still accepts a duplicate name. `add()` at `HomeSectionsView.swift:103-107` calls `addingSection` at `PreferencesEditing.swift:50-55`, which only rejects blank names. Two "Kids" headings on home are still possible on iPhone. Web blocks this.
- iPad still has no ⌘, for Settings in `KeyboardCommands.swift`. The new Quick Switcher entry covers most of that need.
- The Quick Switcher to Settings handoff is sound in source. `RootView.swift:209` sets `quickSwitcherOpen = false`, `:216` records the request, and the sheet's `onDismiss` at `:50-52` presents Preferences after the switcher is gone. No native run or test execution backs this. The updated `ShellFeatureTests` case at `ios/AgentInterfaceTests/ShellFeatureTests.swift:282-285` has not run.

### 7. The rename error state looks heavier than other errors in the sheet. Severity: nit. Pixel.

- `settings-rename-error-1440.png`: the field shows a green focus ring around a red invalid border at (511-828, 163-212), and the error sits in its own bordered box at (515-925, 225-270). The add-section error in the same sheet is plain red footnote text at `PreferencesDialog.tsx:252-253`. Crop: `rename-error-1440.png`.
- Smallest fix: use the plain footnote error style for the rename error too. While the field is invalid, let the focus ring take the danger color.

## What works

- Find does its main job at both widths. The current match sits in the band below the floating bar, about 70 to 110px from the top of the transcript, and the bar doesn't cover it. Older match also reveals a match inside a table. The shared `find-ranges.ts` means the scroll target and the highlight use the same ranges, so they can't drift apart. Server hits that aren't loaded yet still open at the message top, then move to the text once loaded.
- The delete confirmation is right. It has `alertdialog` semantics, focus starts on Keep section, the destructive action is styled red, the title names the section, and cancel saves nothing. The native confirmation dialog already did the same.
- Leaving with a valid name saves through the existing queue. Delete bypasses the guard on purpose, at `PreferencesDialog.tsx:90`, so a deleted section never saves its draft name. Account changes still close the panel at `App.tsx:56` and `:125`, which discards the draft for the old account, as it should. Global shortcuts still stand down while a dialog is open, at `shortcuts.ts:78`, so the palette can't unmount Settings around a draft.
- The section limit, the 44px touch targets and the hidden decorative avatar in `BotChoice` at `PreferencesDialog.tsx:193` are small and correct.
- Native rename now refuses blank, too-long and duplicate names, and leaves the saved name alone. The new pinned summary uses the same rule as web.

## Coverage gaps, not graded as defects

- Web captures cover Advanced on and off, follow and unfollow, create and rename, adding Homework helper, reorder, cancelled delete, the duplicate-name error on Back, a valid name saved through Back and then reopened, confirmed delete, the palette, help, Find on the newest match, Older match, and Escape. Light mode, normal text size, and desktop Chromium only.
- Nobody captured or ran: a second Escape on the invalid-name page (finding 1), Find while a matching reply arrives (finding 3), the 30-section state, quiet hours menus, sign out, failed-save recovery, dark mode, 200% zoom, a screen reader, or real-device iOS Safari.
- Native: only the unchanged Settings front from round 1. No native subpage, rename error, Quick Switcher, or gesture was seen or run. The native unit tests were edited but not executed. The parent's queued native compile and capture is not part of this review, and I make no claim about its result.
- Fixture differences between native and web, such as account names, release dates and the Start page value, are fixture data, not parity bugs.

## Next small fixes, in order

1. Make the Settings `close` handler always finish a native close. Save a valid name or drop an invalid one, then call `onClose`, and add the non-cancelable cancel test (findings 1 and 2).
2. Add a visible way to drop an invalid web rename, or adopt native's leave-and-keep-old-name rule on both platforms (finding 2).
3. Pin the revealed Find match so arriving replies don't move the view (finding 3).
4. Apply the pinned-count, copy and icon fixes as one pass (findings 4, 5 and 7).
5. Announce the native rename error, and run native Add through the duplicate check (finding 6).
