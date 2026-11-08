# 29 Avatar native design gate

Reviewer: Claude Opus 5.5, high effort. OpenAI implemented every app and test edit. Read-only: no builds, simulators, browsers, locks, subagents or product edits. Web is settled at 9.0 by review 28 and is excluded here.

## Verdict

| Surface | Score | Gate |
| --- | --- | --- |
| iPhone 17, light, dark, AX3 | 8.5 | Fails by one must-fix, N9 |
| iPad Pro 11, light, dark, AX3 | 8.5 | Fails by the same must-fix, N9 |

**The native Avatar gate stays open.** One defect blocks it, and it is a one-view fix. Everything else in the fresh evidence holds at 9 on both devices. After N9 is fixed and rerun as described below, I expect to close the gate, but I will score only the new pixels.

## Evidence I checked myself

- The five native files hash the same in the worktree as in `28-source-manifest.json`: `APIClient`, `BotSettingsView`, `DebugFixtures`, `SettingsParityTests` and `ScreenshotTourTests`, plus the avatar fixture.
- I reran `python3 .agents/tools/source-state.py ios .agents/tools/validate-ios.sh .agents/tools/patch-xctestrun.py .agents/tools/with-native-admission.py` from `avatar-source-commands.json`. It returned `sha256:3ce5d226…87f52 (242 source files)`, which matches both receipts.
- Receipts: Phone `.private/ios-test-20261027T015353Z-15208.txt` and iPad `…015909Z-17361.txt`. Both exited 0 with 2 passed, 0 failed and 0 skipped. Each ran `testAvatarDesignReview` and `testLengthLimitsStaySilentUntilNearThenCountThenExplain`.
- All 38 screenshots match the SHA-256 and mtime in `avatar-native-final-evidence.json`. Each mtime falls inside its run window: Phone 20:54:07 to 20:59:04, iPad 20:59:13 to 21:04:31. The last source edit was at 20:50:47.
- Driver logs: Phone `ios-avatar-after.log` needed at most 8 of 12 attempts. That was `avatarStyle` settling at AX3, after travel drags with no frame. iPad `ipad-avatar-after.log` needed at most 5. There were no alternating overshoot runs. `DESIGN_AVATAR_SWATCH` reports 44×44 on both devices. `DESIGN_AVATAR_TUNING` shows 1 to 1.25 on Phone and 1 to 1.2 on iPad.
- I scored only from the raw `avatar-final-captures/after/{ios,ipad}` PNGs. Collages, iPad sheet crops and sampling scripts are in `reviews/29-collages/` and `reviews/29-tools/`. I did not use annotations, older partial captures or older collages.

## Must fix

### N9. The preview-state menu never looks disabled

`BotSettingsView.swift:382`: `}.foregroundStyle(.primary).accessibilityIdentifier("avatarPreviewState")`

The explicit `.primary` style overrides SwiftUI's disabled dimming. The menu's label pixels are pure `#000000` on `#FFFDF7` (20.65:1) whether it is enabled or disabled. I sampled the identical value in `loaded-geo-top`, which is enabled, and in `portrait-empty`, `portrait-busy`, `portrait-unavailable` and `load-error`, which are all disabled. The test's `XCTAssertFalse(avatarPreviewState.isEnabled)` passes, but only the accessibility tree sees the disabled state.

Why this blocks:
- **The first Portrait screen shows an inert control.** On choosing Portrait, a person sees an empty silhouette next to a full-contrast "Preview: Ready ⌄" dropdown. Tapping it does nothing.
- **Busy and load-error states contradict themselves.** In `portrait-busy`, Close, the tabs, Upload and Save all dim, and this menu doesn't. In `load-error`, the Style picker, the tiles and Save dim under "Settings could not be loaded", and this menu still looks live.
- **It appears on both devices** and in four of the 19 states.

The fix follows the existing pattern in `AccentProminentButton` (`RootView.swift:14-19`): apply `.primary` only when enabled.

```swift
private struct PreviewStateMenuLabel: View {
  var text: String
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    let label = HStack { Text(text); Spacer(); Image(systemName: "chevron.down") }
    if enabled { label.foregroundStyle(.primary) } else { label }
  }
}
// in compactAvatarPreview: label: PreviewStateMenuLabel(text: "Preview: \(previewState.label)")
//   .font(.subheadline).padding(.horizontal, 12).frame(minHeight: 44).background(...)
// and remove `.foregroundStyle(.primary)` from the Menu.
```

The outer `.disabled(busy || …)` now wraps the insets, so `isEnabled` reaches this label in the busy and load-error states as well as in the portrait-empty state. No test change is needed. The existing `isEnabled` assertions stay, and the captures prove the visual.

## Fold into the same edit, non-blocking

- **N10. The Generate row's separator starts mid-row.** `BotSettingsView.swift:453` centers the label with `.frame(maxWidth: .infinity)`. The List aligns the separator under it to the text's leading edge, so in `portrait-unavailable` the line starts at about x=138pt instead of 32pt (`phone-unavailable-bottom-crop.png`). The sibling "Upload portrait" is leading-aligned. The fix is `.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)`, which keeps the full-width target. Baseline 627f8f8 had it leading-aligned.
- **N11. The AX3 menu label wraps with a ragged second line.** On Phone at AX3, "Preview:" / "Ready" wraps, and "Ready" starts about 17pt right of "Preview:". Add `.multilineTextAlignment(.leading)` to the label Text. This is cosmetic.

## Prior findings, checked against fresh pixels

| Item | Result |
| --- | --- |
| 27 root cause, inertia overshoot | **Fixed.** No alternation in either log. iPad passed every variant, including dark, AX3, unavailable, seeded and load-error, which had never run before. |
| 27 `top()` Style gap | **Fixed.** Style sits at the same y in `loaded-geo-top`, `mascot-seasonal` and `saved-reopen`. In `generated-unsaved` and `uploaded` it sits lower only because the notice row is above it. `portrait-busy` still clips the Style header, but that shot isn't preceded by `top()`. It's a mid-scroll capture taken to show the footer progress, which is a normal scroll position and not a defect. |
| 27 charcoal swatch edge (S2) | **Fixed.** The dark ring is `#A6B4A7` on the `#2C2C2E` row, about 7.1:1. The charcoal fill `#292929` is nearly identical to the row, so the ring alone defines it, and it reads clearly (`phone-dark-swatches-crop.png`). On iPad the light selected swatch shows a double ring, accent plus muted. That is the same optional nit as web 28. |
| 27 dark capture | Present on both devices. |
| N1 Save outside `.disabled` | **Fixed** in source and pixels. Save is disabled in `load-error`. N9 is the remaining gap in that same state. |
| 25 D5, two prominent buttons | **Resolved.** Save is the single filled primary. Generate is a plain row button. |
| S1 next-step copy | Correct: "Portraits are unavailable. Choose Geometric or Mascot." in the footer, `#697268` on `#FAF8F2`, 4.70:1. |
| Prompt over-limit copy | The parity test asserts "Shorten the text to generate a portrait." I didn't capture the over-limit state natively, and it isn't required. |
| D7 and 27 preview alignment, 6pt | Still present, still minor, not scored down. |
| 25 D6, iPhone keyboard crowding | **Still unverified.** The Phone `avatar-large-text-portrait-focused` shows the prompt focused and Save hidden, with no software keyboard. I made no keyboard claim and gave no keyboard score. |

## Correction to the brief: the iPad focused frame does show a keyboard

`ipad/avatar-large-text-portrait-focused.png` shows a full iPad software keyboard with the QuickType bar. The sheet has shifted up, and the AX3 prompt and all four lines of its text sit above the keyboard. "Generate portrait" is partly visible at the sheet's bottom edge, and Save is hidden. The `portraitPrompt` reveal log shows a 236pt band, which fits that. I saw no defect in it. As instructed, I did not let it raise or lower the iPad score. The ledger should label the iPad shot "software keyboard visible" and the Phone shot "no software keyboard". D6 stays unverified for iPhone only.

## iPhone: 8.5, 9.0 without N9

What I looked at: all 19 shots (`phone-a` to `phone-e`) and the baseline for reference (`phone-before-ref.png`).

- **Layout.** The compact preview bar, 64pt avatar plus menu, replaces a stage of about 340pt. In normal text the editor band holds three tile rows plus labels. At AX3 the band is 396pt, about 45% of the screen. That's the same share web's 200% passed at, and far better than the baseline, where the AX3 stage filled the whole first screen.
- **States.** Every state reads correctly: empty, busy with the spinner in the footer, generated, uploaded, saved and reopened, the error banner, and the load-error retry. The notice text is `#246F59` on white, 6.01:1. The error text is `#A33C32` on `#F9F1F1`, 5.81:1.
- **Contrast.** Captions use `Palette.muted`: "Preview only" is 4.91:1 in light and 7.57:1 in dark, and the portrait footnote is 4.99:1. The primary Save is 5.91:1 in light and 9.32:1 in dark. "Upload portrait" is 6.01:1 in light and 7.94:1 in dark.
- **Accessibility.** At AX3 the Style segmented labels don't scale. That's the system segmented control, the same in the baseline, and outside this delta.
- **The seeded and uploaded portraits are the app icon.** That's a synthetic fixture, and I make no claim about portrait quality.

## iPad: 8.5, 9.0 without N9

What I looked at: all 19 shots, cropped to the sheet (`ipad-a` to `ipad-e`, `ipad-crops/`).

- **Sheet size, judged on the pixels as asked.** The 580×635 form sheet, with the header, preview bar and Save bar pinned, leaves about 300pt for the editor in normal and dark text. That's two rows of seven tiles, or the whole seasonal grid plus the full color row in one view (`choices`). Every control was reachable within five drags. At AX3 the band is about 300pt and holds 1.5 rows of three tiles, plus the three sliders with Reset eyes in `tune-bottom`. It's tight but usable, and it doesn't block. Keeping the accepted settings sheet size was the right call over a cross-tab `.page` change. If the sheet is ever enlarged, do it for all settings tabs at once.
- **States and dark.** Both match the Phone results. The charcoal ring shows clearly, and the unavailable copy and disabled Generate read correctly. N9 and N10 show up here as they do on Phone.

## Minimal rerun after the fix

1. Make one product edit to `BotSettingsView.swift`: N9 is required, and N10 and N11 are optional but cost nothing in the same edit. Leave the tests unchanged.
2. Rerun `testAvatarDesignReview` on Phone, then on iPad, with the same command and admission as these receipts. That's about 5 minutes each. Don't rerun the creation regression, because `creationContent` doesn't use `compactAvatarPreview`.
3. Record the new fingerprint, receipts and SHA/mtime evidence the same way.
4. For review 30, I need only these shots per device: `portrait-empty`, `portrait-busy`, `portrait-unavailable` and `load-error` for the disabled look, `loaded-geo-top` and `dark-geo-top` to confirm the enabled menu didn't change, and `large-text-geo-top` for N11. The rest are settled if the source delta stays limited to `compactAvatarPreview` and the Generate label.
