# Review 23: settings N5 and N6 recheck

Reviewer: Claude Opus 5.5, high effort. Implementer: OpenAI. Read-only scope: the N5/N6 patch to `BotSettingsView.swift` and `ScreenshotTourTests.swift`, their callers and callees, and the fresh `settings-error` frames.

**Gate decision: pass.** N5 and N6 are fixed on both devices. Every creation and settings row is now at 9.0 or higher. The whole creation/settings screen can advance.

| Row | Web desktop | Web phone | Native iPhone | Native iPad |
| --- | --- | --- | --- | --- |
| Wizard | 9.1, reused | 9.1, reused | 9.2 (creation), reused | 9.1 (creation), reused |
| Details | 9.1, reused | 9.1, reused | **9.2**, new | **9.1**, new |
| Confirmations | 9.2, reused | 9.2, reused | 9.2, reused | 9.0, reused |

These are new Details scores from this review's frames, not projections or averages. Review 22 gave 8.8 on iPhone and 8.7 on iPad. N5 and N6 were the only deductions keeping them below 9.

## What I verified

- **Patch.** Diffing `23-before-n56` against the worktree reproduces `23-settings-retry.patch` exactly for both files. No other app file is in the patch.
- **Source.** `source-state.py ios/ .agents/tools/validate-ios.sh .agents/tools/patch-xctestrun.py .agents/tools/with-native-admission.py` returns `a9d2bdfd…8be516` over 242 files. That matches `settings-n56b-evidence.json` and `settings-native-n56b-source-state.json`.
- **Runs.** Both result summaries say Passed, 1 passed, 0 skipped, 0 failed.
- **Fresh images.** All 14 hashes match the files on disk. Each file's mtime matches its record and falls inside its own run's start and finish times.
- **Composite.** `settings-native-composite-evidence.json` has 74 image entries, and all 74 hashes match. 14 of them are N56b frames. I did not recheck the window bindings.

## N5: no stale error after Retry. Fixed.

- **Code.** The Retry action at `BotSettingsView.swift:190` now runs `self.error = nil` before it starts `Task { await loadTab() }`. With `detailLoaded` false and `error` nil, the editor shows `ProgressView("Loading assistant settings…")` from `:197`. On success, `loadTab` (`:794-829`) sets `detailLoaded = true`, and `tabContent` at `:92` has no error to show. On a new failure, the catch at `:828` restores the real message, and Retry comes back. Clearing the error also removes the button right away, so a double tap cannot start two loads.
- **Qualified `self.error`.** The closure sits inside `if let error`, so an unqualified `error = nil` would refer to the local binding. `self.error` writes the `@State`. That is correct.
- **Frames.** `settings-error-edit.png` shows the loaded form with no banner on both devices. The annotated pair `annotated/settings-ipad-retry-success.png` labels it correctly, and so does the iOS pair.
- **Test.** After Retry, the test waits for `Name` to report `isEnabled == true`. The form is disabled while `bot != nil && !detailLoaded` (`:114`), so this waits for exactly the right state. The test then asserts that the load error text is gone, before the capture. The same `staticTexts[message]` query passes the exact-once count on the load-error frame. So the new absence check is not vacuous, and it would have caught N5. The exact-once assert is still there.

## N6: Retry label contrast. Fixed.

- **Code.** Retry uses `.accentProminent` from `RootView.swift:9-23`. That style wraps `.borderedProminent` and sets the label to `Palette.onAccent` while enabled. The fill comes from the app-wide `.tint(Palette.accent)` in `AgentInterfaceApp.swift:12`. This is the same style as Save changes and Create.
- **My measurements.** I located the fill pixels myself and did not use the implementer's regions.

| Device | Fill size | Fill | Label | Ratio | Fill vs. surface |
| --- | --- | --- | --- | --- | --- |
| iPhone | 126.3 × 58.0 pt | #246F59, opaque | #FFFDF7 | 5.91:1 | 6.01:1 on #FFFFFF |
| iPad | 126.0 × 58.0 pt | #246F59, opaque | #FFFDF7 | 5.91:1 | 5.45:1 on #F3F4F2 |

- Both labels pass AA for 17 pt text. The fill is now opaque, so the iPad sheet surface no longer changes the result. Both targets clear 44 pt. The button's left edge lines up with the banner's gutter. As the only recovery action, it now reads as the primary action.
- Crops: `23-collages/retry-button-crops.png`. They agree with the implementer's `23-ios-retry-label-crop.png` and `23-ipad-retry-label-crop.png`.

## Regression check

`settings-save-error.png` on both devices shows one save error that can be dismissed, with the edits kept and Save changes visible. The test still asserts that the edited name survives and that the next save succeeds. The `if let error, detailLoaded` path at `:92` is unchanged.

## Nonblocking notes

- No capture shows the in-flight ProgressView, because the fixture loads too fast. I checked it in the source only.
- No test covers Retry failing a second time. The fixture fails only once. The source path is simple: the catch at `:828` handles it.
- If `store.api` became nil between the failure and Retry, the guard at `:795` would return and leave the spinner up. That needs a sign-out while the sheet is open. It is not worth a branch now.
- Dark mode Retry is not captured in this variant. The same style passes dark mode elsewhere: #1B211E on #8BD2B2.

## Not checked

I ran no build, simulator, browser, xcodebuild or lock. I edited no app code and did not commit. Not verified: a physical device, VoiceOver, a hardware keyboard, the iOS 17 fallback, iPad compact widths, and AX5. Enlarged text was AX3. The window bindings in the 74-entry composite were not rechecked. The nonblocking notes from reviews 21 and 22 are unchanged. The failed `1cba33` attempt and its logs stay unaccepted, and nothing in this review relies on them.

## Collages

`23-collages/ios-focus.png`, `ipad-focus.png`, `retry-button-crops.png`, `ios-retry-button-crop.png`, `ipad-retry-button-crop.png`
