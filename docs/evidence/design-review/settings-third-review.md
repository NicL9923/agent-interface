# Review 22: settings N4 recheck

Reviewer: Claude Opus 5.5, high effort. Implementer: OpenAI. Read-only scope: the N4 patch, its callers and callees, and the `settings-error` frames.

**Gate decision: fail. Do not advance.** N4's duplicate-banner bug is fixed. The new Retry path has two blocking problems on native Details.

| Row | Web desktop | Web phone | Native iPhone | Native iPad |
| --- | --- | --- | --- | --- |
| Wizard | 9.1, reused | 9.1, reused | 9.2 (creation), reused | 9.1 (creation), reused |
| Details | 9.1, reused | 9.1, reused | **8.8**, blocked by N5 | **8.7**, blocked by N5 and N6 |
| Confirmations | 9.2, reused | 9.2, reused | 9.2, reused | 9.0, reused |

## What I verified

- **Patch.** The diff from `22-before-n4` to the worktree matches `22-settings-n4.patch` line for line. It touches only `BotSettingsView.swift` and `ScreenshotTourTests.swift`.
- **Source.** `source-state.py ios/ validate-ios.sh patch-xctestrun.py with-native-admission.py` returns `cd41240f…585897` over 242 files. That matches `settings-n4-evidence.json` and `settings-native-n4-source-state.json`.
- **Images.** All 14 hashes in `settings-n4-evidence.json` match the files on disk. I did not recheck the 74 composite hashes or the window bindings.
- **N4 fixed.** `settings-error-load-error.png` shows one error on both devices. The banner and Retry share the 16 pt gutters. Retry has a visible button shape.
- **Target size.** The iPhone Retry fill is 127 × 58 pt, measured from the pixels. The iPad fill is about 57 pt tall. Both clear 44 pt.
- **iPhone contrast.** I sampled #246F59 on #D8E5E1 at 4.64:1, which agrees with the implementer's figure.
- **No save regressions.** `settings-save-error` shows one dismissable save error with the edits kept. `settings-saved` shows "Changes saved for both household members." with no error. The `if let error, detailLoaded` guard does not hide save errors, because saves need a loaded detail. Creation keeps its own banner at `:123`.

## Blocking issues

**N5. A stale load error stays visible after a successful Retry** (iPhone and iPad, `settings-n4-captures/after/*/settings-error-edit.png`).
- After Retry, the form loads, but the banner still says "Assistant settings could not be loaded. Try again." It is now dismissable, with an ×. It contradicts the visible state. Web does not do this, because its load-state block unmounts on success.
- **Cause.** The Retry button at `BotSettingsView.swift:190` calls `loadTab()`. `loadTab()` (`:794-829`) never clears `error`. Once `detailLoaded` turns true, `tabContent` at `:92` renders the old error.
- **Not settled.** Review 21's frame `after/ios/settings-error-edit.png` shows the same stale banner, and I missed it. N4 changed this exact Retry path, and the brief asked me to verify Retry, so this counts as new evidence. `22-collages/stale-after-retry.png` shows both frames side by side.
- **Fix.** In the Retry action, set `error = nil` before `await loadTab()`. During the retry the user then sees the existing `ProgressView("Loading assistant settings…")`. On failure, `loadTab`'s catch restores the error.
- **Test.** In the `stage == "after"` branch, once `app.textFields["Name"]` exists after Retry, assert `XCTAssertFalse(app.staticTexts[message].exists)`.

**N6. The iPad Retry label fails AA contrast** (`settings-n4-captures/after/ipad/settings-error-load-error.png`).
- The `.bordered` fill is translucent, so it picks up the darker iPad sheet surface. I sampled #246F59 on #CEDCD6 at **4.25:1**. The label is 17 pt regular, so it needs 4.5:1. It is the only action in this state. The crop is `22-collages/load-error-crops.png`.
- **Fix.** Use `.buttonStyle(.borderedProminent)` with `.tint(Palette.accent)` to match Save changes, or give the button an opaque fill that reaches 4.5:1 on both surfaces. A primary style suits the only recovery action.

## Minimal recapture

Rerun only the `settings-error` variant on iPhone and iPad with strict `--count 7`. Review these three frames on each device: `settings-error-load-error` for the N6 contrast, `settings-error-edit` for N5 with no banner, and `settings-save-error` as a regression check. The composite approach is sound to reuse, provided the new 7 replace the N4 7.

Native Details should reach about 9.1 on both devices with N5 and N6 fixed. That is a projection, not a score.

## Collages

`22-collages/ios-focus.png`, `ipad-focus.png`, `stale-after-retry.png`, `ios-load-error-crop.png`, `ipad-load-error-crop.png`, `load-error-crops.png`

## Not checked

I ran no build, simulator, browser, xcodebuild or lock, and I edited no code. Not verified: a physical device, VoiceOver, a hardware keyboard, the iOS 17 fallback, iPad multitasking or AX5. The nonblocking notes from review 21 are unchanged.
