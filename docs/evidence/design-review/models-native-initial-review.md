# 37 Models native visual gate (Opus 5.5 High, independent of the OpenAI implementer)

`R=/Volumes/DevSSD/scratch/wildbots-design-review`. Worktree `t3-d1b42c2a`.

I made no app edits. I ran no build, test, simulator, browser or lock, and started no child agents. I used offline scripts only: Pillow through `uv` with its cache on the SSD, and `source-state.py`. I did not re-review web, which was accepted at 9.0.

## Verdict

**Not ready to advance.** Composer passes on both devices. Skills passes on both devices. Tools scores 8.5 on both devices because of one verified must-fix. It is pre-existing and takes one line to fix.

| Screen | iPhone | iPad | Blocker |
| --- | --- | --- | --- |
| Composer: model picker, reasoning, speed, confirmation | **9.0** | **9.0** | None |
| Tools | **8.5** | **8.5** | M1, a stale load-error banner after a successful retry |
| Skills | **9.0** | **9.0** | None in the captured states. The same code path as M1 applies; see M1 |

I scored each screen on its own frames. No score is an average or a projection.

## Must-fix (verified)

**M1. After a successful "Retry loading tools", the load-error banner stays on screen.**

- Visual evidence: `models-errors-tools-retried.png` on both devices (collages `ios-6-tools.png` and `ipad-6-tools.png`, third panel). The tools list loaded and Save tools is enabled. The banner above them still says "Can't reach the app. Your draft is kept. We'll reconnect automatically." The screen contradicts itself, and it tells the user to wait for something that has already happened.
- Source: `ios/AgentInterface/BotSettingsView.swift:618` is `Button("Retry loading \(kind.rawValue)") { Task { await loadTab() } }`. The success path of `loadTab()` (`:886-919`) never clears `error`. Compare `Retry settings` at `:199`, which runs `self.error = nil` first. Web clears it too: `use-catalog-draft.ts:58` calls `reportNow.current("")` on retry.
- It is pre-existing; the before frames show the same thing. The gate still requires it, because this state is one of the 26 reviewed states.
- Fix: `Button("Retry loading \(kind.rawValue)") { error = nil; Task { await loadTab() } }`. If the retry fails again, `loadTab` sets the error again. The Skills Retry uses the same `capabilities(kind)` builder, so this one line fixes both screens.
- Make the test able to catch it. In `testModelsDesignReview`, after `try capture(name + "-tools-retried")`, assert `XCTAssertFalse(app.staticTexts[original["capabilityLoadError"] as! String].exists)`. This assertion can fail. The banner is pinned above the `Form` (`:96`), so it is not a virtualized cell.
- Re-check scope: only `AGENT_INTERFACE_DESIGN_VARIANT=models-errors` on iPhone and iPad. That variant replaces `models-errors-catalog`, `-retried`, `-tools` and `-tools-retried`, and nothing else changes. No other state needs a rerun.

## Should-fix (not blocking, ranked)

1. **The gap above the unavailable-model reason is too loose** (`ModelPickerView.swift:113-118`). The button label has `minHeight: 44` and centers the name. The caption then starts about 14 pt below the name. The provider subtitle in Favorites sits 4 pt below its name. A tighter version: give the VStack `spacing: 0` and move the caption up with `.padding(.top, -6)`. Or wrap the caption so it follows the row's text column. Purely cosmetic.
2. **Empty Skills shows copy that doesn't apply** (`ios/ipad models-empty-skills`). With nothing reported, the footer still says "Required skills stay enabled. Save to apply your changes." The enabled Save skills button would save an empty set. When `items.isEmpty`, hide the footer sentence about required skills, or disable Save.
3. **Unsupported Tools shows "Save to apply your changes." above a disabled Save** (`models-unavailable-tools`). 36 recorded this as matching web. It still reads oddly. Leave it unless web changes too.
4. **VoiceOver association.** The reasons now live outside the disabled controls. VoiceOver reads "weekly-plan, switch, on, dimmed", and only the next swipe reads "Required by Hermes". That is acceptable, but it hasn't been heard on a device. Check it during the VoiceOver pass that has not been done yet. Don't use `.combine`, because the caption test counts the static text (`ScreenshotTourTests.swift`, `count == 1`).
5. **Pre-existing, out of scope.** The Provider row shows the raw id `custom:house` while the list shows "Household provider". With a dismiss button, a one-line `ErrorBanner` leaves an empty lower band (`models-loaded-skills-save-error`). The generic network-error copy talks about a "draft" inside model and tools screens. The fixture uses web's string, and the real native one is `APIClient.swift:181`.

## Per-state critique (all 26 per device)

Frames come from the final composite in `models-native-final-evidence.json`. I re-hashed all 52 images and every hash matches. The 12 caption images come from `models-native-caption-captures/after`. The other 40 come from `models-native-after-captures/after`.

### Composer (iPhone 9.0, iPad 9.0)

- **loaded-composer / dark-composer.** The hierarchy is clear. A muted "This conversation" header sits over the Reasoning menu, the Speed segments and the dependency footnote. Search now has a muted placeholder and icon, plus a real 44 pt refresh button. Dark theme keeps the green accents and readable muted text. The dark segmented selection is low key but clearly visible.
- **large-text-composer (AX3).** Speed switches to a scalable menu ("Normal ⌃⌄"). That fixes the clipped fixed-size segments. The shared-assistant note wraps cleanly.
- **inference-error / inference-saved.** The error appears inline inside the section, with "Retry reasoning and speed". Reasoning goes back to High instead of showing the value that failed. Fast is selected after the save. This is good recovery behavior.
- **confirmation.** This is the biggest improvement over the before frame, which was a bare system popover with no keep option. Now there is a titled sheet with the full Hermes warning. "Use this model" has the outline style and "Keep current model" is the prominent, safe default. iPad presents the same sheet over the fitted composer sheet.
- **loaded-search (fresh).** The disabled `field-planner` name reads as unavailable. "Reconnect in Hermes to use this model" is now at full muted contrast; I measured 4.91:1 against the 2.0:1 before. The provider warning explains the state above it. The star stays usable, which is intended (`starDisabled`). See should-fix 1 for spacing.
- **no-results.** The message is clear and the selection stays visible.
- **large-text-catalog.** The long model id wraps by hyphen, and the star stays aligned. The glass bar ghosts "planner" under Close. That is the system scroll-edge effect, not an app defect.
- **favorite-error / favorite-saved.** The error sits under search, and the star stays unfilled. After the save, quick-reply moves into Favorites.
- **settings-regression.** This is an intended shared change, not a pixel match. It gets the same "Search models" placeholder, muted headers and footnote type as the composer. The layout and back navigation are intact.
- **errors-catalog / errors-retried / empty-catalog / missing-catalog.** Refresh hides while Retry is offered. The empty and missing copy tells the user what to do next. In missing-catalog the check mark correctly disappears from Favorites because the saved model is retired.
- **iPad layout.** The fitted form sheet is compact (about 450×515 pt), so most states need scrolling below Favorites. It is consistent with the accepted settings sheet and was settled in 36. I did not count it against the score.

### Tools (iPhone 8.5, iPad 8.5)

- **loaded-tools.** Readable descriptions, a clean switch column, and a footer above a full-width prominent Save. Strong.
- **errors-tools.** The pinned banner, Retry in the list and the disabled Save are all correct.
- **errors-tools-retried.** Fails because of **M1**.
- **unavailable-tools.** The reason is clear and Save is disabled; see should-fix 3.
- With M1 fixed and the frame recaptured, I expect both devices to reach 9.0. That is a prediction, not a score, and it needs the re-check frame.

### Skills (iPhone 9.0, iPad 9.0)

- **loaded-skills (fresh).** "Required by Hermes" appears once, below the disabled switch, at 4.99:1. The generic "Hermes profile skill" descriptions are gone, which removes the noise from the before frame.
- **skills-save-error (fresh).** The banner is visible. The packing-list draft stays on, which proves the draft is retained.
- **skills-saved (fresh).** The "Saved" notice and button label confirm the save. The test reads it back after reopening.
- **dark-skills (fresh).** The caption measures 6.44:1. The disabled-on switch reads as locked.
- **large-text-skills (fresh, AX3).** The tab bar collapses to a Skills menu. The caption wraps cleanly at 4.99:1.
- **empty-skills.** The message is clear; see should-fix 2.

## Source delta review (only what 36 did not settle)

The snapshot `37-caption-source` matches the worktree byte for byte for all three files. `source-state.py ios …` reproduces `8a91e0c2…` over 242 files.

- **Caption outside the disabled Button/Toggle.** The result-builder `let controls` / `let control` with `if/else` is valid. Each `ForEach` iteration still yields one row. The disabled modifiers stay on the control only, so the caption is no longer dimmed. I measured all 8 regions myself (`37-scripts/contrast.py`) and got the root's values exactly: 4.91, 4.99, 6.44 and 4.99, the same on both devices. I also checked that the crops cover only caption text.
- **Refresh at a real 44 pt.** The 44×44 label frame, `.borderless` and `contentShape` are in place, and the row has `minHeight: 44`. The caption test asserts the XCUI frame is at least 44 in both dimensions. That check can fail, because a missing button reports a zero frame.
- **AX3 Speed menu.** `!dynamicTypeSize.isAccessibilitySize` sends accessibility sizes to `.menu`. The test asserts that no segmented control exists and that the identifier is present. The frames agree.
- **Stage-aware Keep and Accept.** The after stage uses the `confirmationKeep` and `confirmationAccept` identifiers, an exact `label ==` predicate for the full warning, the "Keep current model" label, and a hittable wait before capture. Keep dismisses. A re-tap followed by accept produces `Model: quick-reply`, and the Fast and favorite settings read back. The coordinate fallbacks run only in the before stage. Not added: 36's D2, a revealed check that no banner appears after Keep. The B5 source change makes that low risk, so I'm not raising it.
- **Reveal helper extraction.** I compared the removed `reveal` body with the new `revealModels` body mechanically after stripping indentation. They are identical. The old local `reveal` now forwards to the helper.
- **Caption-only reuse.** Reuse is justified. The delta touches only unavailable-model rows, which appear only in search, and required capability rows, which appear only in Skills. The 6 fresh images per device cover every state that renders either one. M1 is a concrete reason to rerun `models-errors` only. It is not a reason to rerun the whole suite.

## Not verified

Physical devices, VoiceOver, hardware keyboard, the iOS 17 fallback and iPad compact width. AX5 was not captured; the largest is AX3. There is no network-level "Keep sends nothing" proof, only source and UI state. Test success was not used as design evidence. Every score above comes from the frames.

## Artifacts

- `reviews/37-collages/{ios,ipad}-{1-composer,2-inference,3-catalog,4-favorites,5-catalog-states,6-tools,7-skills,8-skills-variants}.png`: 16 collages covering all 26 states per device, built from the final composite paths.
- `reviews/37-scripts/contrast.py`: independent contrast check against `models-native-caption-contrast.json`.
