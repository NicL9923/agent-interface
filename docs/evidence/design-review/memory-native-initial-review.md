# 48: Native Memory review, iPhone AFTER set and iPad normal/dark

- Reviewer: Claude Opus 5.5, high effort, no subagents. Root OpenAI implemented, so this review is cross-provider.
- Scope: 26 iPhone AFTER images and 9 iPad AFTER images (loaded, loaded-profile, dirty, close-confirmation, saving, saved, forget-confirmation, dark, dark-profile), compared with the 18 BEFORE images per device. Web is out of scope; review 47 accepted it.
- Code read: `MemoryDrawer`, `MemoryDocument`, `MemoryDraft` and `draftSize` in `ios/AgentInterface/ExperienceViews.swift:281-532`; the Memory dirty and saving guards in `ios/AgentInterface/BotSettingsView.swift` (diff against HEAD); the design Memory transport in `DebugFixtures.swift`; the Memory driver in `ScreenshotTourTests.swift:623-800` and its delta since the R2 and R3 snapshots.
- Not run: builds, tests, simulators, browsers and locks. I only used Pillow through `uv` for crops, collages and contrast sampling.
- Artifacts: `reviews/48-collages/` (collages `a`-`k`, `rebuild-fingerprint.py`, `crops.py`, `contrast.py`).

## Verdict

**Not ready to advance.** Two must-fixes are visible in captured images. Both are small native fixes in `ExperienceViews.swift`. Dark and AX pass on their own images.

| Row | Images scored | Score | Gate |
| --- | --- | --- | --- |
| iPhone normal | loaded, loaded-profile, dirty, close-confirmation, saving, saved, forget-confirmation, loading, empty, disabled, too-long | 8.0 | Fail: B1 (saving), B2 (forget-confirmation) |
| iPhone dark | dark, dark-profile | 9.0 | Pass |
| iPhone AX (AX3) | large-text, large-text-profile, large-text-leave, conflict-large-text | 9.0 | Pass |
| iPhone recovery | load-error, retried, conflict, paused, reload-confirmation, discard, reload-error, reload-failed, reload-recovered | 8.0 | Fail: B1 (conflict, paused, reload-error) |
| iPad normal | loaded, loaded-profile, dirty, close-confirmation, saving, saved, forget-confirmation | 8.0 | Fail: B1 (saving), B2 (forget-confirmation) |
| iPad dark | dark, dark-profile | 9.0 | Pass |

I gave no full iPad gate and no expected scores. These 17 iPad states are **unscored**: large-text, large-text-profile, large-text-leave, conflict-large-text, loading, load-error, retried, conflict, paused, reload-confirmation, discard, disabled, empty, too-long, reload-error, reload-failed and reload-recovered.

**R7 status:** R7 is no longer capturing. `memory-after-r7-reservation.json` records `pad-after-ax-r7` (large-text, conflict-large-text) with return code 65, finished at 18:09:30 UTC. `ipad-memory-pad-after-ax-r7.log` fails at `ScreenshotTourTests.swift:672`, which is the `editFirst` value check after typing at AX3 on iPad. No R7 image is usable, and I used none.

## Evidence integrity, verified

- **Source fingerprint:** running `source-state.py` with the `validate-ios.sh` prefixes (`ios/`, `validate-ios.sh`, `patch-xctestrun.py`, `with-native-admission.py`) on the current worktree returns `sha256:719ce428…b0 (242 source files)`. That matches `memory-native-after-source.txt` and the R6 summaries.
- **Reuse proof, rebuilt independently:** `48-collages/rebuild-fingerprint.py` reimplements the `source-state.py` algorithm and swaps one file.
  - With `memory-native-r2-ScreenshotTourTests.swift` (sha `04233ec6…`) it gives `9325dff7…cae`, the R2 fingerprint.
  - With the R3 snapshot (sha `e7e24dff…`) it gives `020784ce…d64`, the R3 fingerprint.
  - Both runs keep all 242 files. So product code, fixtures and tools match the R2 and R3 renders exactly, and only the driver changed. The claim holds.
- **Driver delta since R3:** five changes, all in the test.
  - A 24-attempt cap for `memoryForm`.
  - The `editFirst` up hint.
  - The retained-draft and read-only assertions at `:740-741`.
  - The navigation-bar band check for the failed-reload error at `:755-757`.
  - The reloaded-value assertion at `:767`.
  - None of them weakens a check.
- **Fixture:** `.agents/fixtures/memory-design.json` hashes to `ce694ada…7634`, matching the R2, R3, R4, R6 and R7 receipts. It is outside the iOS fingerprint, so this hash is the binding.
- **Images:** all 35 hashes in `memory-native-after-progress-evidence.json` match the files. Every file's mtime equals its recorded mtime and falls inside its run's `startTime`-`finishTime` window.
- **Progress file against its sources:**
  - Each of the 13 segments equals its segment in `memory-native-after-r2-evidence.json` (9 segments), `memory-native-after-r6-evidence.json` (3) or `memory-native-phone-after-limit-evidence.json` (1). Screenshots, result, fingerprint and summary path all match.
  - No source segment is left unused.
  - Counts are iPhone 26 and iPad 9.
- **Receipts and summaries:**
  - Every `.private/ios-test-*.txt` summary has `exit status: 0`, an `ios inputs` value equal to its segment fingerprint, and a result JSON identical to the evidence, with `Passed`, 1 passed, 0 failed and 0 skipped.
  - R2: 9 runs with return code 0. `phone-after-too-long-r2` returned 124 and was correctly excluded; R3 supplied the too-long image.
  - R3: `too-long-r3` returned 0. `ax-r3` returned 65 and was excluded.
  - R4 returned 65 and was excluded.
  - R6: 3 runs with return code 0, owned simulators shut down, no cleanup errors, `withinDeadline: true`.
- **Driver prints, R2 and R6:**
  - `DESIGN_MEMORY_CONFLICT` shows the edited "Send weekly plans…" draft for conflict, paused, discard, reload-error and conflict-large-text.
  - `DESIGN_MEMORY_RELOAD` shows the saved "Trash and recycling…" text for conflict, paused, reload-error and conflict-large-text.
  - In R6 these are assertions, and conflict-large-text passed them, including the reload recovery and the `memory.4` external entry.
- **BEFORE:** the paths in `memory-native-before-index.json` match the 18 iPhone and 18 iPad files I used for comparison. I did not re-hash the BEFORE set.

## Must-fix

### B1. Disabled "Add memory" turns black with a green icon

- **Code:** `ios/AgentInterface/ExperienceViews.swift:474-479`.
- **What the images show:** when the button is disabled, its text renders in primary black and its plus icon keeps the accent green. Every other disabled control in the same section is gray: "Forget…", "Save memories", "Discard edits" and "Remove new entry".
  - When disabled, it looks more prominent than when enabled, which is green.
  - It is the one control that misstates the read-only state during a conflict.
- **Images:**
  - iPhone `memory-conflict`, `memory-paused`, `memory-reload-error` and `memory-saving`.
  - iPad `memory-saving`.
  - Side by side in `48-collages/g-add-memory-states.png`.
- **Regression:** BEFORE rendered disabled "Add memory" as gray text (`48-collages/i-before-conflict.png`). The change came with the `Label(...).frame(minHeight: 44).contentShape(Rectangle())` label.
- **Fix:** give the label an explicit state color.
  - Compute `let canAdd = !locked && items.count < 100`.
  - Use it for `.disabled(!canAdd)`.
  - Set `.foregroundStyle(canAdd ? Palette.accent : Color(uiColor: .tertiaryLabel))` on the `Label`, so the text and icon change together.
- **Verify:** reshoot iPhone conflict and saving. Those two show both lock causes.

### B2. The Forget confirmation hides or loses the entry it deletes

- **Code:** `ios/AgentInterface/ExperienceViews.swift:415-417`.
- **Why:** `.confirmationDialog` hangs on the whole `Form`, so iOS 27 anchors its popover to the form, not to the tapped row. The dialog never names the entry.
- **iPhone `memory-forget-confirmation`:** the popover sits on top of "School pickup is 3:15 p.m. on weekdays.", the entry being forgotten. It shows as "School p… …ays."
- **iPad `memory-forget-confirmation`:** the popover floats above the sheet, off the form, about 340 pt above the tapped "Forget…" row.
  - It points at the sheet's top edge.
  - Its glass picks up the blue avatar behind "the profile?" and "Forget entry".
- **Crops:** `48-collages/k-forget-and-saving-crops.png` and `h-forget-dialogs.png`.
- **Not a regression:** this is unchanged from BEFORE.
- **Why it still blocks:** it is the one destructive Memory action, and the user cannot see or confirm which entry it removes. Web replaced the same pattern with an inline confirmation under the entry (`MemoryPanel.tsx:126-131`).
- **Fix:** present the existing `AssistantConfirmationSheet` (`BotSettingsView.swift:1218`), the same component Reload uses at `:418-424`.
  - `isPresented` comes from `forget != nil`.
  - The message quotes the entry text, looked up from `request.document.entries` by `entryId`.
  - The accept label is "Forget entry" with `destructive: true`, and the keep label is "Keep it".
  - This also adds a visible Keep action. Today the popover has none on either device.
- **Verify:** reshoot iPhone and iPad forget-confirmation.

## Should-fix, not blocking

1. **Half-width separators under full-width buttons.** The row separators under "Save memories" (`:480-481`) and "Try loading again" (`:377-379`) start at the centered label's leading edge, so a line begins mid-row.
   - Seen in iPhone `memory-loaded-profile`, `memory-conflict`, `memory-load-error` and `memory-reload-failed`, and iPad `memory-saving`.
   - Fix: add `.alignmentGuide(.listRowSeparatorLeading) { _ in 0 }` to those labels.
2. **Progress rows float the spinner above a leading label.** `ProgressView("…")` at `:373` and `:485` centers the spinner over the label's width, so it sits off-axis.
   - Seen in iPhone `memory-loading` and `memory-saving`, and iPad `memory-saving`.
   - Fix: `HStack(spacing: 8) { ProgressView(); Text(…) }`.
3. **"Try loading again" is a short pill** (`:378`), while "Save memories" fills the row. Add `maxWidth: .infinity` so prominent Memory actions share one shape.
4. **The tab bar is disabled during a save but looks enabled.** In `memory-saving`, "Close" is grayed but the tab chips and the "Memory" menu keep their normal colors. The guard works and the driver asserts it. Only the look is off, and it predates Memory, since it also applies to `busy`.
5. **System red "Forget…" contrast:** 3.57:1 on white and 4.06:1 on the dark card, at 17 pt. It is unchanged from BEFORE and is the platform destructive color across the app, so it is not a Memory blocker. Take it up app-wide if the 4.5:1 floor should apply to native destructive text.

## Verified in the images and code

- **Add focus:**
  - `pendingEntryFocus` scrolls to the new row, centers it and sets focus (`:391-398`).
  - iPhone and iPad `memory-dirty` show the caret in Assistant note 4, with "Remove new entry" under it. The driver asserts keyboard focus.
- **Error visibility:**
  - Load and per-document errors scroll to center and take accessibility focus (`:399-414`).
  - `memory-reload-failed` shows the full banner below the tab bar, now asserted against the navigation band.
  - AX3 `memory-conflict-large-text` shows the whole conflict banner.
- **Safe reload:**
  - Reload with edits opens the destructive sheet (`:418-424`). "Reload and discard edits" is bordered red and "Keep editing" is prominent.
  - `reloadAfterDismiss` locks the document until the load. A failed reload keeps the draft and the conflict, and the driver asserts that.
  - "Try loading again" goes through the same confirmation.
- **Truthful notices:**
  - A notice appears only after a successful write, and its text comes from the server's refresh message (`:530`). The fixture text is "Saved in Hermes. Applies to the next turn. Existing chat history is preserved."
  - The idle "Saved in Hermes" notice from BEFORE is gone.
  - The header line "Changes apply at the next safe turn boundary" matches.
- **Read-only conflicts:**
  - Entries render as selectable `Text` with a label and value (`:449-455`). R6 asserts no `textField` during a conflict.
  - The banner keeps "Your edits are kept…" while there are edits, and switches to "Reload profile memory before editing again." after Discard.
  - The read-only cue is the grayed actions plus the banner, and B1 currently breaks that cue.
- **Discard shot caveat:** `memory-discard` was revealed by the driver after the tap. It proves the retained read-only text, "Trash and recycling…", with grayed "Forget…". It does not prove where the list lands or that the banner stays on screen after Discard. I did not score landing position.
- **Dirty and saving guards** (`BotSettingsView.swift`):
  - Close, swipe-dismiss and the tab bar are blocked while saving.
  - Leaving the tab with edits opens "Leave memory without saving?", seen in AX `memory-large-text-leave`.
  - The memory dirty state feeds the Close confirmation, seen in `memory-close-confirmation` on both devices.
  - `onDisappear` clears both flags.
- **Limit:** `memory-too-long` shows "This document is 7 characters over the limit…" in danger red, Save disabled, and the count in red. The driver asserts that Save is disabled.
- **Disabled:** "Editing is disabled in this Hermes profile. You can still read and copy these notes." sits directly under "About this profile". The entries are read-only text with grayed Forget.
- **Contrast** (sampled at 3x):
  - Muted captions and counts: 4.99:1 light, 6.44:1 dark.
  - Section headers, dark: 7.57:1.
  - Accent, light: 6.01:1. Accent, dark: 7.94:1.
  - Conflict banner text: 5.81:1.
- **AX3:**
  - The tab bar collapses to the "Memory" menu, and the title and Close stay intact.
  - Headings and body text wrap without truncation.
  - The leave sheet's two buttons wrap cleanly.
  - The conflict banner is fully visible.
- **iPad:**
  - The settings form sheet is the app-wide presentation, not specific to Memory.
  - Long entries wrap to the wider fields, and the full feed-store URL reads on two lines.
  - Dark keeps card and section separation.

## Annotations, verified

- **`memory-ios-opening`:**
  - BEFORE description ink is 4.0:1 (#7F7F7F). AFTER is 4.99:1, which supports "faint" against "readable".
  - The BEFORE idle notice "Saved in Hermes. No app memory refresh is pending." exists, and AFTER opens straight to Assistant notes.
  - The pointers land on the description and the notice. The AFTER #2 pointer is on the "Assistant notes" header.
  - Correct.
- **`memory-ios-limit`:**
  - The BEFORE pointer is on the server rejection banner, with Save green above it, which supports "rejects after submission".
  - The AFTER pointer is on "7 characters over the limit", with Save grayed below it.
  - Correct.
- **`memory-ios-disabled`:**
  - "About you" changes to "About this profile". Both pointers are on the headers.
  - The disabled note is 4.0:1 in BEFORE and 4.99:1 in AFTER, and moves from subheadline gray to a footnote under the header.
  - Correct.
- **Rendering:** all three render with legible numbered legends (`48-collages/j-annotations.png`).

## Not tested

The following remain unverified: the native Copy menu on read-only text, VoiceOver speech for the read-only label and value, physical devices, hardware keyboards, AX5 and the iOS 17 fallback. AX captures use AX3. The fixtures are synthetic, including the delimiter and the limits. None of this implies live Hermes acceptance.

## Path to 9

1. Fix B1 and B2.
2. Reshoot iPhone saving, conflict and forget-confirmation, and iPad saving and forget-confirmation. All of these sit on a Memory product change, so the fingerprint changes and new runs are required.
3. Then score the remaining 17 iPad states once R7 is rerun. The current R7 failed at `:672`.
