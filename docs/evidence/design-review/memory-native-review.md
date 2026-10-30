# 50: Native Memory recheck after B1/B2

- Reviewer: Claude Opus 5.5, high effort, no subagents. Root OpenAI implemented the changes, so this review is cross-provider.
- Scope: the product and driver delta since review 48 (`719ce428` to `cf30021c`) and its callers, the candidate set in `memory-native-partial-candidate-evidence.json` (iPhone 26, iPad 23), the 15 proposed reused images, and the seven native annotated comparisons.
- Not run: builds, tests, simulators, browsers, locks or the ledger. I did not open or wait on R11 images. I used Pillow through `uv` only for crops, collages and pixel sampling.
- Artifacts: `reviews/50-collages/`. Scripts: `rebuild-fingerprint.py`, `rebuild-multi.py`, `verify-evidence.py`, `crosscheck.py`, `collage.py`, `collage-crop.py`, `sample-add.py`.

## Verdict

**B1 and B2 are closed on both devices.** The 15-image reuse is sound. Every captured row scores 9. **The full Memory gate stays open.** These three iPad states have no image and no score: `memory-reload-error`, `memory-reload-failed` and `memory-reload-recovered`.

| Row | Images scored | Score |
| --- | --- | --- |
| iPhone normal | loaded, loaded-profile, dirty, close-confirmation, saving, saved, forget-confirmation, loading, empty, disabled, too-long | 9 |
| iPhone dark | dark, dark-profile | 9 |
| iPhone AX (AX3) | large-text, large-text-profile, large-text-leave, conflict-large-text | 9 |
| iPhone recovery | load-error, retried, conflict, paused, reload-confirmation, discard, reload-error, reload-failed, reload-recovered | 9 |
| iPad normal | loaded, loaded-profile, dirty, close-confirmation, saving, saved, forget-confirmation, loading, empty, disabled, too-long | 9 |
| iPad dark | dark, dark-profile | 9 |
| iPad AX (AX3) | large-text, large-text-profile, large-text-leave, conflict-large-text | 9 |
| iPad recovery, captured only | load-error, retried, conflict, paused, reload-confirmation, discard | 9 |
| iPad recovery, missing | reload-error, reload-failed, reload-recovered | **Unscored, open** |

I give no averages and no expected scores. R9's final `reload-error` case returned 124. Its log ends during the `memorySave.memory` reveal, with 2 `kAXErrorServerNotFound` lines and `** BUILD INTERRUPTED **`. Its capture folder `memory-native-pad-after-reload-error-r9-captures/after/ipad/` is empty, and it supplies no image to the candidate.

## Evidence integrity, verified

- **Source fingerprints:** `rebuild-multi.py` reimplements `source-state.py` with the `validate-ios.sh` prefixes.
  - The current worktree gives `cf30021c…bf3fb15`, 242 files.
  - Substituting the three `memory-native-pre49-source/` files gives `719ce428…7b0`. So `ExperienceViews.swift`, `ScreenshotTourTests.swift` and `UITestSupport.swift` are the only changes since review 48. `BotSettingsView.swift`, `DebugFixtures.swift` and the fixture are unchanged.
  - Substituting only `memory-native-r8-ScreenshotTourTests.swift` gives `3341f30c…9dba`. The R8 driver differs from the current one only by the failure-only `tearDown`, which I diffed.
  - The pre49 base plus the R2 or R3 test snapshot gives `9325dff7…cae` and `020784ce…d64`, both with 242 files.
  - The snapshot hashes match both manifests: `2ee24b00…`, `38cda4da…`, `a97119dd…`, `04233ec6…`, `e7e24dff…`.
- **Fixture:** `.agents/fixtures/memory-design.json` hashes to `ce694ada…7634`, which matches the candidate and the R8, R9 and R10 receipts.
- **Candidate images, 49 of 49 pass:** `verify-evidence.py` checks each one.
  - The sha256 matches the file.
  - The mtime equals the recorded value and falls inside its run's `startTime` to `finishTime` window.
  - The result is `Passed`, with 0 failed and 0 skipped at both the run and device level.
  - The `.private` summary shows `exit status: 0` and an `ios inputs` value equal to the image's source fingerprint.
- **Candidate against its sources:** `crosscheck.py` matches all 49 entries to a segment in the R10, R8, R9 or progress evidence by path, sha, mtime, phase, summary, fingerprint and the identical result object. No R8, R9 or R10 image is left unused.
  - R10 has 5 runs, all with return code 0: phone loaded 7, conflict 1, paused 2, reload 3, and iPad loaded 7. That is exactly 20 images. Both owned simulators shut down, there were no cleanup errors, and `withinDeadline` is true.
  - R8 has 2 iPad runs with return code 0: 1 conflict-large-text and 3 large-text images.
  - R9 has 8 iPad runs with return code 0 and 10 images, plus the interrupted 9th run described above.
- **Retries:** no R8, R9 or R10 log contains `DESIGN_MEMORY_REPLACE`. Those logs do capture other stdout prints, such as `DESIGN_MEMORY_CONFLICT` and `DESIGN_MEMORY_LIMIT`, so the absence is real. The second Cmd+A attempt never ran.
- **BEFORE set:** `memory-native-before-evidence.json` has 36 images, 18 per device. All hashes, mtimes, run windows and results check out. `memory-native-before-index.json` points only into that set.

## B1, disabled "Add memory": closed

- **Code** (`ExperienceViews.swift:443` and `:486-489`): one `canAdd = !locked && items.count < 100` drives both `.disabled(!canAdd)` and `.foregroundStyle(canAdd ? Palette.accent : Palette.muted)`. The style sits on the `Label`, so the text and the icon change together.
- **Images, every locked capture:** iPhone `memory-conflict`, `memory-paused`, `memory-reload-error` and `memory-saving`, and iPad `memory-saving`, `memory-conflict` and `memory-paused`. In each one, the icon and the label are both gray. Collages: `b-phone-normal-r10.png`, `c-phone-recovery-r10.png`, `d-phone-reload-r10.png`, `f-pad-normal-r10b.png` and `h1-pad-r9.png`.
- **Sampled ink:**
  - Disabled Add is #697268, `Palette.muted`, at 4.99:1 on white.
  - Enabled Add is #246F59 in both old and new captures, 6.01:1.
- **Should-fix, not blocking (N1):** disabled Add is darker than its disabled siblings.
  - Disabled "Forget…", "Remove new entry", "Discard edits" and "Save memories" all render at #BFBFBF or #BDBDBF.
  - Disabled Add now uses the caption ink, so it is the most visible disabled control in the section.
  - It no longer reads as active, which was the blocker, so I consider B1 closed.
  - Review 48 suggested `Color(uiColor: .tertiaryLabel)`. Batch that with any later Memory product change, because a change here invalidates every Memory capture.

## B2, Forget confirmation: closed

- **Code:** `.sheet(item: $forget, onDismiss:)` presents `AssistantConfirmationSheet` (`ExperienceViews.swift:416-424`).
  - The message quotes `request.document.entries.first { $0.id == request.entryId }?.text`.
  - "Forget" is disabled while `changed` is true, so the saved text is also the visible text.
  - "Forget entry" is the destructive outline button. "Keep entry" is the prominent cancel button, with `.cancelAction` and an escape action.
- **Lifecycle, traced:**
  - Accept sets `pendingForget` and clears `forget`. `onDismiss` then clears `pendingForget` and calls `forgetEntry`. `mutate` sets `busy` and `savingTarget` in the same update.
  - So `savingTarget != nil || pendingForget != nil` stays true from accept through the DELETE (`:390`). The parent's `memorySaving` never drops to false in between.
  - While the sheet animates away, `memorySaving` blocks Close, the tab bar and swipe-dismiss (`BotSettingsView.swift:171`, `:187`, `:198` and `:225`).
  - During the same window, `locked`, the editor `.disabled`, Discard and `requestReload` (`:434`) all include `pendingForget`. A second Forget, an edit or a reload cannot race the queued delete.
  - Keep, swipe-down and escape each clear only `forget`, so `onDismiss` does nothing. Only an explicit accept deletes.
  - Forget needs `!changed`, and the reload confirmation needs `changed`, so the two sheets on the `Form` cannot both be requested.
- **Driver** (`ScreenshotTourTests.swift:746-762`):
  - It asserts that a static text contains the straight-quoted target.
  - It taps `confirmationKeep`, waits for the sheet to disappear, and asserts the first user entry still equals the target.
  - It then confirms, and waits for entry 1 to equal the fixture's former entry 2. That proves the fixture DELETE removed the right entry.
  - These assertions passed in R10 on both devices.
- **Images:** iPhone and iPad `memory-forget-confirmation` show "Forget this entry?", the shared-profile scope line, the quoted "School pickup is 3:15 p.m. on weekdays.", and both actions.
  - On iPad, the nested sheet sits inside the settings form sheet, the same way `memory-close-confirmation` does. The old popover floated about 340 pt off target.
  - The sheet covers the target row, but the quote names it, which settles the "which entry" question.
- **Cosmetic, optional:** "Reload profile memory" (`:384`) is disabled only by `busy`. During the roughly 0.3 s dismissal it looks enabled while `requestReload` ignores taps. Adding `|| pendingForget != nil` would match the guard.

## Driver delta, checked against report 49

- `replace(_:with:)` (`:674-693`) follows report 49's corrected shape.
  - Before Cmd+A it taps once only when the field is unfocused, waits for focus, waits for the keyboard layout and checks focus again.
  - It allows one settled retry, and logs the actual value plus the focus and enabled state.
  - It attaches a screenshot and the hierarchy, then makes a strict `XCTAssertEqual`.
  - The `too-long` call site now uses the same helper (`:815`).
  - The recheck uses the default 10 s timeout, where report 49 proposed 2 s. That is harmless.
- `waitForKeyboardLayout()` is now internal instead of private. Nothing else in `UITestSupport.swift` changed.
- The new `tearDown` attaches a screenshot and hierarchy only when `failureCount > 0` and the app is in the foreground. It cannot change a passing capture.

## Reuse: 15 images approved

The product delta since every reused render is only `ExperienceViews.swift`: the Add color, the Forget sheet and the `pendingForget` guards. With `pendingForget == nil`, every changed `locked` and `.disabled` expression evaluates the same as before. So only frames showing Add, or the Forget presentation, could differ. I opened every reused frame.

| Class | Source | Images | Add on screen | Forget UI | Decision |
| --- | --- | --- | --- | --- | --- |
| iPhone R2 | `9325dff7` | dark, dark-profile, disabled, discard, empty, loading, load-error, retried | Enabled only: dark-profile, disabled, empty | None | Approve |
| iPhone R3 | `020784ce` | too-long | Enabled | None | Approve |
| iPhone R6 | `719ce428` | large-text, large-text-profile, large-text-leave, conflict-large-text | Enabled only: large-text-profile | None | Approve |
| iPad R6 | `719ce428` | dark, dark-profile | Enabled only: dark-profile | None | Approve |

- Enabled Add pixels are identical between the old tint and the new explicit color. Old iPhone `empty` and `too-long`, AX `large-text-profile`, and new R10 `loaded-profile` all read #246F59. Old dark-profile reads #8BD2B2 on iPhone and iPad, which is `Palette.accent` dark. The app tint is `Palette.accent` (`AgentInterfaceApp.swift:12`).
- In `memory-disabled`, the visible green Add belongs to Assistant notes. The fixture's `disabled` mode keeps that document `enabled: true`. The disabled profile document's Add is below the fold on both devices.
- `memory-discard`, iPhone `memory-conflict-large-text` (cropped in `p-phone-ax-conflict-top.png`) and `memory-large-text-leave` show no Add at all.
- The four iPad AX images come from R8 (`3341f30c`). They are not reuse. Their product, fixture and helpers match the current source, and only the failure teardown differs.

## Annotations, verified

- All seven specs point to candidate AFTER images, and the six BEFORE pointers are in the BEFORE index. Each render is newer than its spec and its AFTER image.
- `memory-ios-add-correction` uses the interim R2 `memory-conflict` (`9325dff7`, in the progress evidence) as its left image. The title and the footnote label it as an intermediate revision, not the baseline. Its AFTER claim, "icon and label now share a muted color", matches the sampled #697268.
- `memory-ios-forget` and `memory-ipad-forget` are accurate. The BEFORE popovers carry no entry text and no Keep. The AFTER pointers sit on the quote and on "Keep entry".
- `memory-ios-opening` and `memory-ipad-opening` now use R10 AFTER images, and their claims still hold. The limit and disabled comparisons are unchanged from review 48.
- **Nit (N2):** several numbered dots overlap the first glyph of their target, such as the "F" of the BEFORE popover titles and the opening quote in both AFTER forget images. Everything stays legible. A larger negative x offset would clear it.

## Carried over, not blocking

These items from review 48 are still visible and still do not block:

- Half-width separators under full-width buttons.
- An off-axis spinner in loading and saving.
- The short "Try loading again" pill.
- Tab chips that look enabled during a save.
- System red "Forget…" at 3.57:1.

The iPad AX3 leave sheet leaves a sliver of the underlying "Forget…" visible below it. That comes from the shared `AssistantConfirmationSheet` fitted sizing and is not specific to Memory.

## Still open

- **iPad:** `memory-reload-error`, `memory-reload-failed` and `memory-reload-recovered`. They wait on the R11 rerun of that one case. Once it passes, score them against the `cf30021c` source and this fixture.
- **Unverified:**
  - Synthetic fixtures only, no live Hermes.
  - The native Copy menu on read-only text.
  - VoiceOver, including speech for the quoted Forget message.
  - Physical devices and hardware keyboards.
  - AX5. All AX captures use AX3.
  - The iOS 17 fallback, including the `AssistantConfirmationSheet` branch before iOS 18.
