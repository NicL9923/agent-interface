# 20 assistant creation and settings review (Opus 5.5 High, read-only)

Implementer: OpenAI. Reviewer: Anthropic Claude Opus 5.5, High. Baseline: accepted commit 6fc7384.

**Gate decision: not authorized to advance.** Web Details has one must-fix. Native has no final evidence and one test-design must-fix. The next screen stays blocked until a native final review scores iPhone and iPad from fresh captures.

## Scope

In scope: the two-step creation wizard, the Details settings section, the personal, model, delete and discard confirmations, and the shared preview controls and captions this wizard changed (`src/components/avatar-editor.css`, native `AvatarStage` and `AvatarTiles`).

Out of scope: the separate Avatar editor and the other settings tab bodies. They have later gates.

## What I verified

- **Snapshot.** `20-reviewed-source` matches the worktree byte for byte for all 13 files in `20-source-manifest.json`.
- **Web fingerprint.** The `src/` tree plus `.agents/tools/capture-design.js`, `.agents/tools/capture-design.py` and `.agents/fixtures/settings-design.json` (224 files) reproduces b6a31dc0…4001 exactly.
- **Captured source.** I removed `personal = personal && !submitted.shared;` in memory and swapped the two `onError` branches back. The result reproduces the captured fingerprint a393ec654…2481 exactly. Reverting either edit alone does not. So the captured client differs from the current one by exactly those two edits.
- **Web report.** `settings-v3-after.json` has 63 paths and 63 geometry rows, all with `overflow: false`. All 12 confirmation bounds fit their viewports. The tallest, personal at 200%, spans y 140 to 704 in an 844 px viewport. All 12 put focus on the safe action. There are 32 keyboard focus rows and none is obscured. `settings-before-expanded.json` has 63 paths, 0 modal prompts and focus left on the form, which confirms the before state.
- **Logs.** `settings-tests-v8.log` shows 45 of 45 passing, started 17:37:49. `settings-build-v6.log` shows a successful build at 17:37:50. Both run after the last web source write at 17:37:27, so I did not rerun jsdom.
- **Native shot count.** The `after` stage source yields 7 + 7 + 8 + 7 + 2 + 6 = 37 images per device, which matches the claim.
- **Native frames.** The archived alert-attempt `BotSettingsView.swift` differs from the current file only in the confirmation code, `tabBar.disabled(busy)` and the consent guard. I looked at the prior iPhone creation and edit frames only to catch defects early. **I gave no native score.**

## Web rerender for the stale-consent guard and error ordering

**No rerender is needed for these two edits.**

- The capture driver never clicks "Make it personal". It presses Keep editing or Escape. So `personalConfirmed` stays false in every captured frame, and the guard cannot change a pixel.
- The server's `private_confirmation_required` error carries no `confirmRequired` (`src/server/bot-routes.ts:133`). The model 409 carries no private code. Reordering the branches changes no outcome for either error.

A focused rerender is still needed for the load-error fix below.

## Web scores

| Area | Desktop | Phone |
| --- | --- | --- |
| Creation wizard | **9.1** | **9.1** |
| Details and confirmations | **9.1** on captured states. The load-error must-fix applies here too but has no desktop capture. | **8.8**, blocked by W1 |

The confirmations alone would score 9.2 on both, judged on hierarchy, safe focus, the warning inside the dialog, 200% wrapping and dark contrast. I sampled the dark model body at about 7.4:1 and the light body at about 4.7:1.

### Must-fix

**W1. The settings load and error state has no padding.** `src/BotSettings.tsx:299-304` renders the loading `<p>` and the Retry button directly in `.settings-dialog`, which has `padding: 0` (`src/styles.css:904`). In `after/web-settings-edit-load-error.png`, "Assistant settings could not be loaded. Try again." touches both dialog edges, and Retry is a full-bleed bar. This existed before the change (same in `before/`), but it is one of this screen's captured states. It also fails the 9 bar.
- **Fix.** Wrap both elements in a padded container that matches `.settings-content` gutters, and give Retry the normal button width.
- **Evidence.** Rerender `edit-load-error` at 390 and add 1440.

### Nonblocking

1. **The Shared checkbox label is smaller than its own helper text.** `.checkbox-label` is 0.8125rem (`src/styles.css:896`). The new settings helper text is 0.875rem (`:1033`). The new 44 px row height also pushes the helper text away from the checkbox, so it floats between the checkbox and the MCP label. This shows in `create-role-bottom-*`, `edit-bottom-*` and the 320 frames. Raise the label to at least 0.875rem inside `.settings-dialog`, and tighten the helper's top margin.
2. **The discard prompt is still inline.** It appears as a mint note at the top with short buttons, while the other three prompts are modals. Review 18 kept it inline on purpose. Note it as a parity gap: native now uses one sheet for all four prompts.
3. **Model confirmation emphasis differs between platforms.** Web fills "Confirm this model" and outlines Keep editing. Native fills Keep and outlines Confirm. Pick one rule.
4. **The close icon does not scale at 200%.** It stays at icon size while the heading doubles. Placeholders also truncate at 320 and 200%. Both predate this change.
5. **The keyboard focus check is narrow.** `capture-design.js:303-308` only tests overlap with the sticky footer. It never checks the header or the viewport, and it runs only on edit, never on either creation step.
6. **The web personal-then-model chain has no jsdom test.** The code is correct. The second `saveBot(true)` reads `personalConfirmed` as true from the earlier render and sends both `confirmPrivate` and `confirmModel`. A one-case test would lock that in.
7. **Description is now a two-row textarea.** Enter inserts a newline instead of submitting. That matches native's vertical `TextField`, so I accept it.

Settled and not reopened: safe focus, the `stopPropagation` on cancel and close, the fallback focus, `Button type="button"`, the warning carried inside the dialog, `alertdialog` labelling, the sticky Save, the separated danger zone, and the saved name used in the heading and prompts.

## Native source findings (unbuilt fingerprint 29f713df…268a)

Correct by source:
- One `sheet(item:)` holds all four prompts, and the action runs in `onDismiss`. That removes the race when the personal prompt is followed by the model prompt.
- A swipe, Escape or Keep leaves `acceptedConfirmation` nil.
- The model warning lives in `.model(warning:)` with `error = nil`. The private code is checked first.
- `tabBar.disabled(busy)` closes the case where switching tabs cleared the warning.
- The guard `!form.shared && (personal ?? personalConfirmed)` is correct. The `settings-personal-reconfirmed` step would fail without it, so that test can fail.
- Only Keep has `.keyboardShortcut(.cancelAction)`. There is no `.defaultAction` anywhere (the only shortcut is at line 1127).
- The explicit `presentationBackground(Palette.raised)` and `interactiveDismissDisabled(false)` on the child are in place.
- The iPad branch uses `.frame(idealHeight:)`, which covers the fitted-ScrollView risk from review 19.

### Must-fix before the next batch

**N1. The swipe-cancel "no write" assertion cannot fail.**
- In `DebugFixtures.swift`, nothing handles `DELETE /api/bots/<id>`. The request falls through with a 200 and the bot stays in the fixture. `AppStore` only clears `deletedBotId`.
- So `XCTAssertTrue(app.buttons["bot.ranch"].exists, "Cancellation keeps the assistant")` passes even if the swipe ran a delete.
- `XCTAssertTrue(form.exists)` runs right after the prompt disappears, and the delete runs asynchronously after `onDismiss`. That check races too.
- The Keep paths (personal, delete, discard) make no write assertion at all.
- **Fix.** Have the settings fixture apply DELETE, for example by filtering a deleted-id set out of `bots`, or count writes. Then assert `bot.ranch` is still listed after the bootstrap refresh. Also assert that no "Assistant saved." or "Changes saved…" notice appears after each Keep.

### Should-fix before the batch (source is unbuilt, so they cost nothing to include)

**N2. Sizing branches on `UIDevice.current.userInterfaceIdiom == .phone`** (`BotSettingsView.swift:1141`). An iPad in a compact-width window (Split View, Slide Over, a narrow Stage Manager window) gets `.form` sizing and no detents. Branch on `horizontalSizeClass` instead, or apply the detents everywhere: regular width ignores them. The planned evidence will not cover this.

**N3. The step 1 primary action looks like a link row.** "Next: role and model" (`:132`) is a plain list-row text button. Step 2's "Create assistant" is a full-width `.accentProminent`, and web uses a filled primary on both steps. The prior frames show this hierarchy break inside the wizard. Match step 2.

### Nonblocking

1. **The delete prompt's accept label repeats the trigger.** Both say "Delete assistant", so `app.buttons["Delete assistant"]` matches two elements while the prompt is open. Web says "Yes, delete". Align the two.
2. **The tests mix label and identifier lookups.** They still look up some buttons by label (`"Discard changes"`, `"Make it personal"`, `"Confirm this model"`) next to the new identifiers. Review 19 asked for identifiers. If a label lookup breaks, the run fails loudly, so this is low risk.
3. **Title focus may fire too early.** `onAppear { titleFocused = true }` can run before VoiceOver attaches. The sheet's default focus covers it. Unverified without VoiceOver.

## Native evidence I need for the final review

Each item applies to both iPhone and iPad unless marked.

1. **Fresh run receipts.** Use the post-N1 source, then a diff review of N1 to N3 against 29f713df. Each receipt needs exit status 0, `Passed`, 0 failed and 0 skipped. `design-capture-evidence.py … --count 37` must pass for each device, with every image inside its run window.
2. **Confirmation frames.** These are the core of the score:
   - `settings-delete-confirmation`, `settings-dark-delete-confirmation` and `settings-large-text-delete-confirmation`
   - `settings-model-personal-confirmation`, `settings-model-confirmation` and `settings-personal-reconfirmed`
   - `settings-personal-confirmation` and `settings-discard-confirmation`
   - `settings-model-confirmed`, which must show "Assistant saved."
3. **Contrast measured from the PNGs,** not taken from palette claims. Measure the title, the message, the accept text on the raised surface and the Keep text on the accent fill, in light and dark. Every text pair needs at least 4.5:1.
4. **iPhone sheet fit.** The detent matches the content: Keep is not clipped and the sheet is not mostly empty. At AX-XL, the test's reveal-then-tap must prove Keep is reachable.
5. **iPad sheet fit.** The fitted form sheet must neither collapse nor stand full height and empty, at L and at AX-XL.
6. **No duplicate warning.** No error banner may duplicate the model warning behind the sheet.
7. **Falsifiable cancellation** after N1. Swipe and Keep must leave the assistant and the notices unchanged.
8. **Fresh annotations.** Regenerate the native annotations from the final captures, including the confirmation sheets. The existing 16 omit the rejected alerts and were built from partial captures, so they do not count.
9. **Unverified list in the ledger:** physical device, VoiceOver (escape action and focus order), hardware keyboard Esc and Return, the iOS 17 fallback (plain sheet, uncaptured), and iPad compact multitasking widths.

Do not score native from `reviews/settings-alert-attempt`, from the old alerts or from expected appearance. The iPad batch that hit the cutoff (return 124) is not accepted.

## Collages and crops (`reviews/20-collages`)

- `create-phone-before.png`, `create-phone-after.png`, `crop-sticky-pair.png`
- `edit-phone-before-after.png`, `confirm-before.png`, `confirm-phone-after.png`, `crop-model-dark.png`
- `large-text-after.png`, `create-large-narrow-after.png`
- `desktop-create-after.png`, `desktop-edit-ba.png`, `desktop-edit-bottom-confirm.png`
- `states-after.png`, `states2-after.png`, `load-error-ba.png` (W1)
- `native-prior-iphone-noncritical.png`, `crop-native-prior-avatar-tab-*.png`: prior frames, used for early defects only, not scored

## Limits

- I ran no live server, no browser and no VoiceOver. The web Escape and keyboard results come from the recorded Playwright report, not from runs of my own.
- I ran no native build, simulator or lock. I edited no app code.
- I sampled contrast from screenshot pixels, so the ratios are approximate.
