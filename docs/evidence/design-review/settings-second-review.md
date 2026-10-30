# 21 assistant creation and settings recheck (Opus 5.5 High, read-only)

Implementer: OpenAI. Reviewer: Anthropic Claude Opus 5.5, High. Baseline: accepted commit 6fc7384. Prior review: `20-settings-review.md`.

**Gate decision: not authorized to advance.** Web passes on every row. Native creation and confirmations pass on both devices. Native Details scores 8.6 on iPhone and iPad because the load-error state shows the same error twice (N4). This is a small fix with a one-variant recapture.

## Scores

Actual scores from the final frames. No expected scores, no averaging.

| Area | Web desktop | Web phone | iPhone | iPad |
| --- | --- | --- | --- | --- |
| Creation wizard | 9.1, unchanged | 9.1, unchanged | **9.2** | **9.1** |
| Details | **9.1** | **9.1**, W1 closed | **8.6**, blocked by N4 | **8.6**, blocked by N4 |
| Confirmations (four types) | 9.2, settled | 9.2, settled | **9.2** | **9.0** |

Native Details would score about 9.1 on both devices without N4. Normal, dark, AX3, save error, saved, unsupported and model edit all read well.

## What I verified

- **Delta.** `21-settings-delta.patch` reverse-applies cleanly to the worktree (`git apply -R --check`). It touches only `BotSettingsView.swift`, `DebugFixtures.swift`, `ScreenshotTourTests.swift`, `src/BotSettings.tsx` and `src/styles.css`.
- **Web fingerprint.** `source-state.py src .agents/tools/capture-design.js .agents/tools/capture-design.py .agents/fixtures/settings-design.json` reproduces `29f2ab92…0cf9` (224 files).
- **Native fingerprint.** `source-state.py ios/ .agents/tools/validate-ios.sh .agents/tools/patch-xctestrun.py .agents/tools/with-native-admission.py` uses the exact inputs from `validate-ios.sh:98`. It reproduces `3dd5c0a5…8b68d` (242 files). Both `.private` receipts carry that fingerprint, `exit status: 0`, `result: Passed`, 1 passed, 0 failed and 0 skipped. The logs show `TEST EXECUTE SUCCEEDED`, with 319 s on iPhone and 365 s on iPad.
- **Evidence.** `settings-native-evidence.json` lists 37 screenshots per device, both bound to the same fingerprint. `after/ios` and `after/ipad` each hold exactly 37 `settings*.png`.
- **Contrast.** I wrote my own sampler (`21-tools/contrast.py`): the region's mode color is the fill, and the highest-contrast color with at least 0.3% coverage is the text. It reproduces all 16 claimed pairs exactly on both devices: light 20.65, 5.69, 6.35 and 5.91; dark 14.43, 6.67, 8.04 and 9.32. All pass 4.5:1.
- **Annotations.** I spot-checked four of the 28 rendered comparisons: iPad delete, iPhone model, iPad Next and web phone load. Each pointer lands on its subject and each claim matches the frame. On the web-phone before image, marker 1 covers "Ra" in the title. That is cosmetic.

## Source review of the delta

- **N1 closed.** The settings fixture now handles `DELETE /api/bots/<id>`. The branch comes before the GET branch, is limited to `screen == "settings"`, inserts into `deletedSettingsBotIds` and clears overrides. `bots` filters on that set. `performConfirmation` (`BotSettingsView.swift:663-670`) runs delete, refresh and close in that order. The positive control proves the same fixture and the same `bot.ranch` query can see a real deletion, so the swipe-cancel check can now fail. If a swipe deleted the assistant, the sheet would also close itself and the next `Close` tap would fail.
- **Keep paths.** Delete-Keep and discard-Keep have strong downstream checks: Ranch is still listed, the form stays open and the edited name survives. Personal-Keep in the error flow is also covered downstream, because the discard prompt only appears while the form is still dirty. The `XCTAssertFalse(…"Assistant saved."…exists)` checks taken right after a Keep tap are instantaneous. They would likely miss a save that finishes asynchronously. That matters only for `settings-personal-reconfirmed`, which has no other downstream check. Nonblocking.
- **N2 closed by source.** The sheet now branches on `horizontalSizeClass == .compact`. The iPad frames show the confirmation docked to the bottom of the parent settings form sheet, with a grabber and a content-height fit. That suggests the confirmation's environment reports compact inside the iPad form sheet, so the detents branch runs. This is an inference from pixels. Either way, the observed fit is correct.
- **N3 closed.** Step 1 Next is now a full-width `.accentProminent` with a 44 pt minimum and clear row insets. It matches Create on both devices, in light, dark and AX3. Its disabled state uses the system bordered-prominent disabled look, the same as Create. No frame shows disabled Next at the bottom of step 1.
- **Delete label.** The prompt now says "Yes, delete", so the duplicate `Delete assistant` match is gone.
- **W1 closed.** The loader now uses `.settings-content` padding with a flex column, a 16 px gap and `align-items: flex-start`. `BotSettings.tsx:149` also queries `.settings-content` to reset scroll. The loader also matching that query is harmless.

## Web W1 frames

`after/web-settings-edit-load-error.png` and `-desktop.png` show gutters of 21 and 27 px. Retry is 128 px wide and about 43 to 44 px tall, measured from the pixels. Nothing overflows, and `retryLoadsDetails` is true. The message wraps cleanly on phone. The space between the title and the message is a little generous because two paddings stack, which is acceptable. Desktop and phone Details now each score 9.1. Everything else on web is reused from review 20 and settled.

## Native frames inspected

All nine prompt and success frames on each device (`21-collages/native-{ios,ipad}-prompts-{a,b}.png`), plus creation (`native-*-create.png`), Details (`native-*-details-{a,b}.png`) and load-error before and after (`native-load-error-ba.png`).

**Confirmations.** Every prompt uses one opaque raised sheet. The semibold title comes first, then the consequence, then an outlined danger or accent accept, then a filled Keep. Delete and discard read in red. The model accept reads in accent. Each prompt type keeps the same structure. The model warning sits in the sheet and no banner repeats it behind (`model-confirmation`, both devices). `model-confirmed` shows "Assistant saved." and the Saved button state. `personal-reconfirmed` sits over the earlier "Changes saved for both household members." notice. That notice belongs to the prior save and is not a duplicate.
- **iPhone.** The detent fits the content. The space below Keep is about 74 pt including the home indicator, slightly generous. At AX3, the title, all four lines of body text, Yes, delete and Keep assistant fit with Keep fully visible. Dark mode reads well.
- **iPad.** The sheet fits its content at normal size and at AX3. Keep is fully visible and the sheet is neither collapsed nor empty at full height. Deduction: about 8 pt of the parent settings sheet peeks below the confirmation. In `large-text-delete-confirmation` and `personal-reconfirmed`, that strip clips the parent's red "Delete assistant" mid-glyph (`21-collages/ipad-sheet-bottoms.png`). It is standard stacked-sheet behavior and it is small, but it looks unfinished. That keeps iPad at 9.0.

**Creation.** Step 1 now ends in a filled primary that matches step 2, so the wizard's hierarchy is consistent. At AX3 the label wraps to two centered lines inside the capsule. The preview chips, caption and style picker are unchanged from review 20 and fine. iPad wraps the same flow in its fitted form.

## Must-fix

**N4. The native load-error state shows the error twice** (iPhone and iPad, `after/*/settings-error-load-error.png`). This is unchanged from the 6fc baseline (`before/*/settings-error-load-error.png`). It counts now because this is native's first scored pass.
- **Cause.** When `!detailLoaded` and `error` is set, `BotSettingsView.swift:187` renders a non-dismissable `ErrorBanner(message: error)` and a bare "Retry settings" button. `tabContent` at `:92-94` renders a second, dismissable `ErrorBanner` with the same text. The first banner is also full-bleed because it has no `.padding(.horizontal)`, and Retry looks like a plain centered link with no button shape.
- **Fix.** It is two small edits in `BotSettingsView.swift`:
  1. In `tabContent`, skip the banner while the detail load has failed: `if let error, detailLoaded { ErrorBanner(…) }`. Creation has its own banner at `:123`, so this does not affect it.
  2. At `:187`, render one padded group:
     ```swift
     if let error {
       VStack(alignment: .leading, spacing: 12) {
         ErrorBanner(message: error)
         Button("Retry settings") { Task { await loadTab() } }.buttonStyle(.bordered).frame(minHeight: 44)
       }.padding(.horizontal).padding(.top, 8)
     }
     ```
  - Optional: dim the stale, disabled bootstrap form underneath, for example `.opacity(detailLoaded ? 1 : 0.6)`. It currently looks editable.
- **Test.** In `ScreenshotTourTests.swift` near `:580`, before `capture(name + "-load-error")`, add `XCTAssertEqual(app.staticTexts.matching(NSPredicate(format: "label == %@", "Assistant settings could not be loaded. Try again.")).count, 1)`. Use the fixture's exact error string.
- **Minimal recapture.** Rerun the `settings-error` variant on iPhone and iPad if the driver can select one variant. Otherwise rerun the existing settings flow on both devices. Run `design-capture-evidence.py --count 37` again, then review `settings-error-load-error`, plus `settings-save-error` and `settings-saved` as a check that nothing regressed. I need no other frames.

## Nonblocking

1. **iPad stacked-sheet peek** (above). If you want 9.2+, one option is a bottom spacer in the parent form so its last row never sits in the peek strip. A simpler option is to accept it as system chrome.
2. **Instant negative notice checks** after Keep, discussed above. For `settings-personal-reconfirmed`, wait briefly or assert the form stays dirty, for example by checking that Save is still enabled.
3. **The iPad settings form sheet is small** on an 11-inch iPad, about 580 × 530 pt, so most of the form needs scrolling. This is app-wide sheet sizing and outside this gate. I note it for the later whole-app pass.
4. Review 20's open web nonblocking items 1, 3, 4, 5 and 6 stay open and unchanged. Item 3, the model emphasis split between platforms, still applies: web fills Confirm, native fills Keep.

## Collages and crops (`reviews/21-collages`)

- `w1-load-error-ba.png`, `w1-phone-after-crop.png`
- `native-ios-prompts-a.png`, `native-ios-prompts-b.png`, `native-ipad-prompts-a.png`, `native-ipad-prompts-b.png`
- `ipad-crop-large-text-delete-confirmation.png`, `ipad-crop-personal-reconfirmed.png`, `ipad-crop-delete-confirmation.png`, `ipad-sheet-bottoms.png`
- `native-ios-create.png`, `native-ipad-create.png`
- `native-ios-details-a.png`, `native-ios-details-b.png`, `native-ipad-details-a.png`, `native-ipad-details-b.png`, `native-load-error-ba.png` (N4)
- `annotation-spotcheck.png`
- Tools: `reviews/21-tools/collage.py` and `contrast.py`

## Limits

- I ran no build, browser, simulator, xcodebuild or lock, and I edited no app code. I reran no jsdom or unit tests. The web results come from `settings-tests-v9.log`, `settings-build-v7.log` and the recorded Playwright reports.
- The source fingerprints, receipts, contrast samples and frames were checked by me. Test behavior comes from reading the source and the recorded pass, not from a run of my own.
- Enlarged text is AX3, not AX5. Still unverified: a physical device, VoiceOver escape and focus order, hardware keyboard Esc and Return, the iOS 17 fallback, iPad compact multitasking widths and the disabled state of step 1 Next.
- I did not use the rejected alert attempt or the partial iPad batch in `settings-alert-attempt`.
