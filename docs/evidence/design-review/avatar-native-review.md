# 30 Avatar native recheck

Reviewer: Claude Opus 5.5, high effort. OpenAI implemented every app and test edit. Read-only: no builds, simulators, browsers, locks, subagents or product edits. Web stays settled at 9.0 from review 28. The 12 frames outside this delta stay settled from review 29.

## Verdict

| Surface | Score | Gate |
| --- | --- | --- |
| iPhone 17, light, dark, AX3 | 9.0 | Passes, no blocker |
| iPad Pro 11, light, dark, AX3 | 9.0 | Passes, no blocker |

**The native Avatar gate is closed. The next screen is authorized.** N9, N10 and N11 are fixed in source and in pixels on both devices. One new non-blocking source nit is listed as N12.

## Evidence I checked myself

- The worktree `ios/AgentInterface/BotSettingsView.swift` hashes to `fb48bc1c…7e83`, which matches the saved `30-source` copy and `30-source-manifest.json`. `30-native-delta.patch` touches only that file, in three places: the menu label, the Generate label and the new `EnabledPrimaryMenuLabel` modifier.
- I reran the native command from `avatar-source-commands.json`. It returned `sha256:8a4bc2f2…e354a (242 source files)`. Both receipts contain that fingerprint.
- Receipts: Phone `.private/ios-test-20261027T022259Z-24963.txt` on iPhone 17, iOS 27.0. iPad `.private/ios-test-20261027T022806Z-26399.txt` on iPad Pro 11-inch (M5). Each ran only `testAvatarDesignReview`, exited 0, and reported 1 passed, 0 failed and 0 skipped.
- All 38 screenshots in `avatar-native-n9-evidence.json` match their SHA-256 and mtime, and each mtime falls inside its run window. The Phone window is 1793067794 to 1793068084, and the iPad window is 1793068089 to 1793068399. The source file mtime is 1793067720, before both windows.
- I scored only from raw PNGs in `avatar-n9-captures/after/{ios,ipad}`. I made my own iPad sheet crops at x 240 to 1430 and y 530 to 1890, and did not use the root collages. The sampling and collage scripts are the review 29 ones in `reviews/29-tools/`.

## Disabled propagation, from source

- `compactAvatarPreview` is mounted via `.safeAreaInset(edge: .top)` at `BotSettingsView.swift:119`. The `.disabled(busy || (bot != nil && !detailLoaded))` on line 121 sits outside that inset, so it covers both the busy and load-error states.
- The menu's own `.disabled(avatar.mode == .portrait && (avatar.src ?? "").isEmpty)` on line 385 covers the empty-portrait, busy-portrait and unavailable states.
- `EnabledPrimaryMenuLabel` on line 382 reads `@Environment(\.isEnabled)` inside the label, which is beneath both modifiers. The forced style is gone from the Menu itself.

## Prior findings, against fresh pixels

| Item | Result |
| --- | --- |
| **N9, disabled menu at full contrast** | **Fixed on both devices.** The label is now `#C5C3C1` on `#FFFDF7`, 1.73:1, in `portrait-empty`, `portrait-busy`, `portrait-unavailable` and `load-error`. In review 29 it was `#000000`, 20.65:1. The disabled "Upload portrait" sibling in `portrait-busy` samples `#BFBFBF`, 1.84:1, so the menu dims the same way as the other disabled controls. Disabled controls are exempt from WCAG 1.4.3, and the chevron dims along with the text. A person choosing Portrait now sees an inactive dropdown, and the busy and load-error screens no longer contradict themselves. |
| **N10, Generate separator mid-row** | **Fixed.** In Phone `portrait-unavailable`, both separators around the Generate row start at x=96px, or 32pt, the same inset as their siblings. The label "Generate portrait" now aligns with "Describe a portrait". The iPad separators start at x=318px on both rows. |
| **N11, AX3 ragged wrap** | **Fixed on Phone.** At AX3, "Preview:" and "Ready" both start at x=344px. iPad fits "Preview: Ready" on one line at AX3, so it never wraps there. In `large-text-portrait-focused` the disabled two-line label is also flush left. |

## Changed enabled color, judged from pixels

The enabled label is no longer black. It now uses the green accent tint.

| Frame | Label | Background | Ratio |
| --- | --- | --- | --- |
| Phone `loaded-geo-top` | `#246F59` | `#FFFDF7` | 5.91:1 |
| Phone `dark-geo-top` | `#8BD2B2` | `#222C25` | 8.22:1 |
| iPad `loaded-geo-top` | `#246F59` | `#FFFDF7` | 5.91:1 |
| iPad `dark-geo-top` | `#8BD2B2` | `#1B211E` | 9.32:1 |

All four clear AA for text. I accept the green on hierarchy, and I'd call it a small improvement:

- **Affordance.** Tinted text with a chevron is the standard iOS pull-down idiom. It now matches the other tappable text in the sheet: Close, the selected tab and "Upload portrait". The old black label read like static text in a box.
- **Hierarchy holds.** Save remains the only filled control. The menu is tinted text on a neutral raised fill, so it can't compete with Save. "Preview only" stays muted beneath it.
- **The states now separate clearly.** Enabled is green, and disabled is grey. That's a clearer signal than the black or grey split the review 29 fix proposed.
- **Spot check.** I looked at the other 12 Phone frames once, in `phone-other12-spot.png`. The green carries through correctly, including "Needs your help" in `mascot-seasonal` and "Working" in `save-error`. `large-text-portrait-focused` shows the disabled grey, as it should for an empty portrait. Nothing else moved.

## N12, non-blocking source nit: the modifier's name doesn't match its pixels

`EnabledPrimaryMenuLabel` and its doc comment say the enabled label is forced to `.primary`. The captures show the accent tint instead. The likely cause is that `.primary` is a `HierarchicalShapeStyle`, which resolves against the current foreground style. Inside a Menu label, that style is already the tint. The old Menu-level `.foregroundStyle(.primary)` replaced the tint before the label was built, which is why the label used to be black. If that's right, the enabled branch does nothing, and the next reader will expect black and get green.

This doesn't block the gate, because the pixels are good. Next time someone edits this view for another reason, pick one option and include a capture:
- If green is intended, as I recommend, delete the modifier, or rename it and fix the comment to say it keeps native tint and dimming.
- If black is wanted, use `Color.primary` in the enabled branch. I would not do this.

## Scores

### iPhone: 9.0

I looked at all seven delta frames in full (`phone-delta.png`), the menu-bar crops (`phone-menu-crops.png`), the Generate crop (`phone-crops/unavailable-generate.png`) and the 12-frame spot check. N9, N10 and N11 are resolved. The new enabled tint reads well in light and dark, and the hierarchy is intact. No new defect.

### iPad: 9.0

I looked at all seven sheet crops (`ipad-delta.png`, `ipad-crops/`) and the load-error menu crop (`ipad-crops/menu-load-error.png`). The disabled grey, the enabled green, the dark contrast, the leading Generate label and the AX3 single-line label all render correctly. No new defect.

## Limits, unchanged

- Large text was tested at AX3, not AX5.
- The Phone focused capture has no software keyboard, so iPhone keyboard crowding (D6) stays unverified. The iPad focused capture shows a software keyboard.
- No physical device, VoiceOver or live Hermes generation claims.
- No runtime or resource changes. The tests are unchanged. I reran nothing on web, and no broad tests.

## Artifacts

`reviews/30-collages/`: `phone-delta.png`, `phone-menu-crops.png`, `phone-other12-spot.png`, `phone-crops/`, `ipad-delta.png`, `ipad-full-loaded.png`, `ipad-crops/`.
