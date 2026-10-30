# Settings and navigation screen review, round 1

- Reviewer: Claude Opus 5.5 (Anthropic), independent of the OpenAI Sol/Terra implementation.
- Effort: High was requested. This session cannot observe how its internal effort setting maps to that level. This note does not assume it ran below High.
- Code state: `11703c787998c5698141833af6273afb61fe0283` on `nic/full-app-design-review`, PR #207.
- Captures: `/Volumes/DevSSD/scratch/wildbots-design-review/settings-screen-r1/`. Web frames are 1440x1000 and 390x844. `native-Preferences.png` is a 1206x2622 iPhone render of the compiled Settings front. `capture-failure.png` was not used. All coordinates below are pixels in the named source image.
- Review crops, upscaled 2x: `/Volumes/DevSSD/scratch/wildbots-design-review/settings-screen-r1-review/`.
- Scope: the Settings front, display preferences, Following, Home sections editing and order, the command palette, keyboard help, and Find in conversation. Computer, terminal, notifications and device setup, updates, and connection recovery are later areas and are not rated here.

## Score

**8 / 10. Not passing. The bar is 9.**

The area is well built. Settings reads like a phone settings app at both widths, subpages return focus to the row that opened them, and the shortcut table drives the help dialog, palette hints and matcher from one place. The palette is a proper combobox with grouped and ranked results. The save queue keeps optimistic edits ordered and account-scoped. The score stays at 8 for three concrete problems a person will hit this week. Find reports "5 of 5" but no match is visible on screen. Web deletes a section with one click and offers neither a confirmation nor an undo. A typed section rename is silently thrown away on Back.

## Prioritized issues

Each tag marks where a finding comes from. **Pixel** means seen in a capture and checked in source. **Code** means source only, in a state nobody captured.

### 1. Find says it found a match but doesn't show it. Severity: medium to high. Pixel and code.

- `settings-find-chat-1440.png` (849-1267, 100-147): the bar reads "gate" and "5 of 5". The visible transcript from y 90 to 790 has no highlighted text, current or otherwise. `settings-find-chat-390.png` (8-382, 93-139) shows the same: "5 of 5" over an image and attachments, with no highlight in view.
- Source: on a new query, `src/app/FindBar.tsx:65-69` calls `openMessage(newest, false)`. `showFound` at `src/app/use-conversation.ts:312-314` scrolls the message's top edge to 120px below the viewport top. It never looks at where the match sits inside the message. The fixture's newest match is in a long message with a checklist, an itinerary and a calendar card, so the highlighted range lands below the fold.
- Effect: the count says a match is current while the person sees nothing highlighted. This is the main job of Find.
- Smallest fix: let `openMessage` take an optional range or element to reveal. In `FindBar`, after computing `ranges(current.messageId)`, scroll the first range's `getBoundingClientRect()` into the band below the floating bar. Use about 72px from the top so the bar at `src/app/transcript.css:106-121` doesn't cover it. Keep the message-top behavior for unloaded server hits.

### 2. Web deletes a section with one click and no way back. Severity: medium. Pixel and code.

- `settings-section-1440.png` (515-613, 769) and `settings-section-390.png` (39-144, 692): "Delete section" is a plain row. `src/app/PreferencesDialog.tsx:283` commits `removeSection` and navigates back right away.
- Native asks first: `ios/AgentInterface/HomeSectionsView.swift:143-153` shows "Delete Weekend plans?" with a destructive button.
- Home menu moves already offer a toast with Undo through `undoable` at `src/App.tsx:137-141`. Settings bypasses it, so the section's name, order and membership are gone. Membership falls back to the main list correctly, so the logic is right. Recovery is the missing piece.
- Smallest fix: send the delete through the same undo toast, "Deleted Weekend plans" with Undo, restoring the saved section at its index. That keeps one tap and adds recovery. If the toast can't reach the dialog, add a confirm step to match native.

### 3. A typed rename is lost on Back or Escape. Severity: medium. Code, with the idle state seen in pixels.

- `settings-section-1440.png` (499-941, 198-257): the name field shows no Save or Rename control until the text changes. `src/app/PreferencesDialog.tsx:266` adds "Rename" only when `changed`, and the change commits only on submit at `:256-263`.
- If the person edits the name and then taps Back at `:80` or presses Escape at `:72-76`, `SectionPage` unmounts and the edit disappears with no notice. Native saves each keystroke at `ios/AgentInterface/HomeSectionsView.swift:129`, so the same habit works on iPhone and fails on web.
- Smallest fix: commit a valid changed name on blur and before `go({ kind: "main" })`. If the name is invalid, stay on the page and show the existing error. That keeps the duplicate-name check and removes the silent discard.

### 4. Section counts include pinned assistants that home lists elsewhere. Severity: low to medium. Pixel and code.

- `settings-sections-1440.png` (549-611, 542): "Around the house" says "3 assistants". In the same frame, the sidebar heading "AROUND THE HOUSE" at (26-163, 422) holds one row, Kitchen companion at (83-208, 460). Ranch hand and Garden planner are pinned at the top, and `src/app/Sidebar.tsx:46` filters pinned assistants out of sections. `settings-sections-390.png` (73-135, 470) shows the same count.
- Settings counts every member at `src/app/PreferencesDialog.tsx:211`. Native does the same at `ios/AgentInterface/HomeSectionsView.swift:72`.
- The section page also hides this: `settings-section-1440.png` (557-668, 344) labels Ranch hand only as "In Around the house".
- Smallest fix: keep the membership model. Change the copy, for example "3 assistants, 2 pinned" on the row and "In Around the house, pinned on home" on the page. Do the same on native.

### 5. On a Mac, Ctrl+F opens Find and takes over a text-editing key. Severity: low to medium. Code only.

- `src/app/Conversation.tsx:111` opens Find on `metaKey || ctrlKey` on every platform. It skips `matchCombo`, so it misses the platform logic this commit just fixed. In macOS text fields, Ctrl+F moves the cursor forward one character, and people who use those Emacs-style keys lose it in the composer.
- The shortcut table marks Find as `external: true` at `src/app/shortcuts.ts:22`, and the file's header comment says a binding can't drift from what the app says it is. This one has.
- Smallest fix: replace the hand-written check with `matchCombo(event, shortcuts.find)`. Add one test case: on Apple, Ctrl+F does not match Find.

### 6. Web has no section limit, so the 31st section appears and then vanishes. Severity: low to medium. Code only.

- The server caps sections at 30 in `src/server/schemas.ts:70`. Native stops at the limit and explains it at `ios/AgentInterface/HomeSectionsView.swift:81-83`.
- Web `SectionList` at `src/app/PreferencesDialog.tsx:229-236` always commits `addSection`. The optimistic row appears, the PATCH fails, and `usePreferenceEdits` reverts it, with the error going to the app-level handler.
- Smallest fix: make `checkSectionName` or the submit handler return "You have the most sections home can show (30)." when `sections.length >= 30`, using the existing inline error and the native wording.

### 7. The rename card has square corners. Severity: low. Pixel.

- `settings-section-1440.png` (499-941, 198-257) and `settings-section-390.png` (22-367, 78-140): the name field sits on a white band with square corners. Every other group in the sheet has 18px corners. Crops: `section-rename-1440.png` and `section-rename-390.png`.
- Source: the form has both `settings-group` and `settings-row` classes at `src/app/PreferencesDialog.tsx:256`. `.settings-row { border-radius: 0 }` at `src/app/home.css:351-364` comes after `.settings-group` at `:332-337` and wins. `.settings-group.settings-row` at `:455` doesn't restore it.
- Smallest fix: add `border-radius: 18px` to `.settings-group.settings-row`.

### 8. Find shows two close buttons, and one is off-palette blue. Severity: low. Pixel.

- `settings-find-chat-1440.png`: Chromium's search-field clear button at (1101, 124) is blue, next to the bar's own close button at (1245, 124). `settings-find-chat-390.png` shows the same pair at (215, 116) and (360, 116). Crop: `find-bar-1440.png`.
- Source: `type="search"` at `src/app/FindBar.tsx:112`, and no `::-webkit-search-cancel-button` rule near `src/app/transcript.css:122`.
- Smallest fix: hide the native cancel button with `appearance: none` on that pseudo-element. Escape and the bar's close button already cover clearing and closing.

### 9. The same settings use different names across surfaces. Severity: low. Pixel and code.

- Appearance: Settings says "Follow device" at `settings-main-1440.png` (811-905, 485), `src/app/PreferencesDialog.tsx:107`, and native at `native-Preferences.png` (753-1060, 1723). The palette calls the same value "Appearance: System" at `src/app/CommandPalette.tsx:21`.
- Following: web reads "Following 0 assistants" at `settings-sections-1440.png` (549-697, 305). Native says "Not following any assistants" at `ios/AgentInterface/HomeSectionsView.swift:38`. The page is titled "Following" on web at `settings-following-1440.png` (683-757, 259) and "Follow all activity" on native at `HomeSectionsView.swift:57`. Row detail and footers differ too: "All their activity, not only shared tasks" on web at `PreferencesDialog.tsx:134`, and "All of their activity, not just shared tasks" on native at `PreferencesView.swift:205`.
- Section delete footnote: "Its assistants stay on home, in the main list." on web at `PreferencesDialog.tsx:286`, and "Its assistants move back to More assistants on home." on native at `HomeSectionsView.swift:144`. The native line names the heading the person will see, so it's the better one.
- Smallest fix: pick one string per concept and use it on both platforms. My suggestion is "Follow device", "Not following any assistants", and the native delete footnote.

### 10. The palette only reaches the top of Settings. Severity: low. Code only.

- `src/app/CommandPalette.tsx:69` gives Settings the keywords "preferences", "account" and "notifications". Typing "follow", "sections", "quiet hours" or "sign out" falls through to "Search messages for…". `settings-palette-filtered-1440.png` (479-530, 208) shows the one path that works.
- Icons disagree with Settings. Keyboard shortcuts uses `sliders` at `CommandPalette.tsx:70`, while Settings uses `keyboard` at `PreferencesDialog.tsx:122`. "Appearance: Light" uses the `today` calendar icon at `CommandPalette.tsx:73`, which is the same icon as the Today row.
- Smallest fix: add the missing keywords. Or add "Following" and "Home sections" entries that open Settings on those pages, since `PreferencesDialog` already has a `Page` type. Use `keyboard` for shortcuts and a sun-style icon for Light if `Icon` has one.

### 11. Section reorder buttons stay 36px on touch. Severity: low. Pixel and code.

- `settings-sections-390.png` (283-357, 380-470): the up and down buttons are 36px squares split by a divider. Crop: `section-order-1440.png`. `src/app/home.css:473` has no coarse-pointer override. Find has one at `src/app/transcript.css:127`.
- Smallest fix: add `@media (pointer: coarse) { .section-order .icon-button { width: 44px; height: 44px; } }`. The row is 56px on phones, so it fits.

### 12. Native and web disagree on a few editing rules. Severity: low. Code only, native subpages not captured.

- Rename: native accepts blank names, shown as "Untitled section", and duplicate names on every keystroke at `ios/AgentInterface/PreferencesEditing.swift:58-65`. Web rejects both at `src/app/preferences-editing.ts:51-57`. Two sections both called "Kids" make two identical headings on home.
- Sign out: native confirms at `ios/AgentInterface/PreferencesView.swift:99` and `:137`. Web signs out on one click at `src/app/PreferencesDialog.tsx:155`. The cost is low, since signing back in recovers it, but the platforms behave differently.
- Quick Switcher: native ⌘K at `ios/AgentInterface/QuickSwitcher.swift:22-29` lists only assistants and three views. It has no Settings, Find or New assistant actions, and no arrow-key selection, since Return always opens the first row. iPad keyboard users have no ⌘, for Settings in `ios/AgentInterface/KeyboardCommands.swift:26-38`.
- Smallest fix: run native rename through the same duplicate check on submit or when the page closes, keeping live typing. Add a Settings entry to `QuickSwitch.places` and a ⌘, command. The web sign-out confirmation is optional.

## The Mac shortcut fix

- The change at `src/app/shortcuts.ts:28` is correct and minimal. Chromium reports `userAgentData.platform` as "macOS", and the case-sensitive `/Mac/` missed it. With the `i` flag, "macOS", "MacIntel", "iPhone" and "iPad" user agents all match, and "Windows", "Win32", "Linux" and "Android" still don't.
- The six cases in `tests/shell-logic.test.ts:54-70` can fail. The first case fails on the old regex, and that is the regression that caused the bug. `vi.unstubAllGlobals` runs in `finally`, so a failure doesn't leak the stubbed `navigator`. Explicit-platform negatives, such as Ctrl+K rejected on Apple, already exist at `:76-84`.
- What's left: Find at `src/app/Conversation.tsx:111` bypasses this helper. See issue 5.

## What works

- The visual system is consistent at both widths. Rounded groups on a warm surface, muted section headings, accent toggles and checks, and danger-red destructive rows match the rest of the app. At 390, Settings becomes a top-anchored sheet with 56px rows, and long names such as "Trail scout with a long name for wrapping" wrap cleanly in `settings-following-390.png` (81-310, 452-475).
- Page navigation inside Settings is careful. Escape on a subpage goes back instead of closing, at `src/app/PreferencesDialog.tsx:72-76`. Back restores focus to the opening row through `data-opens`, and a new page focuses its title, at `:57-68`.
- Section editing keeps the one-section rule in pure functions at `src/app/preferences-editing.ts`. The page explains moves in place, with "In Around the house" and the footnote in `settings-section-1440.png` (515-849, 711). Add stays enabled and explains an empty or duplicate name inline. Reorder disables the impossible direction at the ends, visible in `settings-sections-1440.png` (855-940, 455-560).
- Saves are optimistic and ordered. `usePreferenceEdits` and `preferenceQueue` apply each edit to the newest queued value, drop saves for a previous account, and revert on failure. Native keeps its unsaved-changes discard confirmation and sign-out confirmation at `ios/AgentInterface/PreferencesView.swift:119-139`. Nothing in this review asks to change those paths.
- The palette is strong. It has combobox and listbox roles with `aria-activedescendant`, IME-safe keys, wraparound arrows, Page Up and Page Down, a live match count for screen readers, pinned ⌘1 and ⌘2 hints, unread and activity details, and a trailing message search. `settings-palette-filtered-1440.png` shows "settings" ranking Settings first, with its group named on the right.
- Keyboard help comes from the same table the listener uses. It shows ⌘ on a Mac after the fix, and its rows wrap cleanly at 390 in `settings-shortcuts-390.png` (39-271, 310-330).
- The native Settings front in `native-Preferences.png` is a clean grouped form. The Display pickers use the standard menu style, the status dot sits on the Hermes icon, and the account card matches web.

## Noted, not graded here

- Notifications and install copy belong to a later area. Web Settings shows "On iPhone, choose Share, then Add to Home Screen…" to a desktop Chromium session at `settings-sections-1440.png` (515-878, 737-756), from `src/app/PreferencesDialog.tsx:158`. That review should handle it.
- Avatar states were accepted in an earlier area. In the palette, Ledger's "needs help" state renders as a lone pink "!" with no visible avatar, and Trail guide stacks a ring, a red badge and an unread dot on a 30px icon. See `settings-palette-1440.png` (437-470, 410-535) and the crop `palette-status-1440.png`. Recheck only if the avatar area reopens.
- The palette's phone bottom sheet has no close control in `settings-palette-390.png`, and on iOS a software keyboard could cover a bottom sheet. The palette only opens from ⌘K, so a hardware keyboard and Escape are always present. I don't count this as a defect.

## Coverage gaps, not graded as defects

- Captured web states: the Settings front, Following after a follow, the section page after adding Homework helper, the sections list after a move up, keyboard help, the unfiltered and filtered palette, and Find right after typing. The agent ran these at both widths against the loopback synthetic API.
- Not captured: the Find state after "Older match" and after Escape. The capture script asserts that Escape closes the bar, but no frame shows the moved or closed state. Also not captured: section delete and its result, the rename error, the duplicate-name error, quiet hours expanded, the Start page and Open by default menus open, Sign out, and failed-save recovery.
- Native: only the Settings front. Following, Home sections, the section page, reorder, the delete confirmation, the Quick Switcher, and every gesture are code-only. No VoiceOver, Dynamic Type or dark mode.
- Web: light mode and normal text size only. No dark mode, 200% zoom, screen reader pass, or real-device iOS Safari.
- Fixture differences accepted as stated: account names, Hermes release dates, and the Start page value differ between native and web.

## Next small fixes, in order

1. Scroll the current Find match into view below the bar (issue 1).
2. Route web section delete through the undo toast, or confirm it like native (issue 2).
3. Commit or keep a pending rename on blur, Back and Escape (issue 3).
4. Count or label pinned members in section rows (issue 4).
5. Route Find through `matchCombo` and add the Ctrl+F test (issue 5).
6. Add the 30-section guard on web (issue 6).
7. Apply the CSS and copy fixes in issues 7-11 as one pass, then align the native rules in issue 12.
