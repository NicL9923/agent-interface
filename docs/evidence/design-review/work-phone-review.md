# 66 Work W1 iPhone final recheck

- Reviewer: Claude Opus 5.5, high effort, independent Anthropic reviewer. No children. The implementers were OpenAI GPT-6.1 Terra and root Sol.
- Scope: closing iPhone W1 after 63 and 65. That covers the two fresh R5 frames `goal-loading` and `goal-replace`, the source delta since 65, the reuse of the R5 phone presenter run under the R6 test-only change, and the 7 phone annotations. iPad scores, web, W2, W3 and Learning are out of scope.
- Not done: no app, test, tool, docs or ledger edits. No build, test, simulator, browser, service, heavy lock or probe. I read files, hashed images, sampled pixels and made crops. Collages are in `66-collages/`.
- Device limits: iOS 27 simulator, iPhone 17, AX3 only. I make no VoiceOver, physical-device, hardware-keyboard, iOS 17, AX5 or iPad compact claims.

## Verdict

**iPhone W1 closes.** Both fresh frames score 9 with no obvious issue. The 20 unchanged W1 frames keep their 63 scores of 9. Nothing needs to rerun on the phone.

- `goal-loading`: 9. "Loading Work…" measures 4.99, up from 3.44.
- `goal-replace`: 9. The nested `AssistantConfirmationSheet` matches the Clear sheet. Its pairs measure 20.65, 5.69, 6.35 and 5.91.
- The R5 phone presenter run carries forward to the current source. The only change since R5 is in a test file, and that change cannot alter what a passing run proved.
- iPad W1 stays open. The failed R5 iPad presenter run earns no credit.

One correction to the brief: the source moved during this review. `AutomationFlowTests.swift` changed at 19:22:29 CDT, so the current fingerprint is **`b3bb3d95…`**, not `48d294ec…`. The R6 proof file was rewritten to match. This verdict binds to `b3bb3d95…`. Any further source change voids it until a new proof exists.

## Evidence binding

| Check | Result |
| --- | --- |
| Current fingerprint | `source-state.py ios/ validate-ios.sh patch-xctestrun.py with-native-admission.py` returns `b3bb3d95…` (243 files). My own hasher agrees. This matches `work-goal-fix-r6-source-proof.json` and `work-native-after-goal-fix-r6-source.txt`. |
| Chain, in memory | Swap in the R5 flow snapshot and I get `1281a16f…`. Swap in all three R4 snapshots and I get `e455d33b…`. All three `work-review65-*` snapshots give `748198b0…`. All three `work-review63-*` snapshots give `76954fa9…`. Each link matches its proof file. |
| R5 to current | Only `AutomationFlowTests.swift` differs. `AutomationViews.swift` and `ScreenshotTourTests.swift` are byte-identical to the R5 render. Swapping either R4 file alone gives a different fingerprint, so the R4 to R5 step changed all three files. |
| Image hashes | I re-hashed all 23 PNGs in `work-native-after-iphone-final-evidence.json` and all 23 match. That is 22 W1 frames plus 1 unscored Learning frame. The 20 unchanged frames carry the r2 fingerprint `76954fa9…` that 63 reviewed. The 2 fresh frames carry `1281a16f…`. |
| Fresh runs | `.private/ios-test-20261028T001029Z-41126.txt` (loading) and `…001119Z-41788.txt` (replace): inputs `1281a16f…`, ChatUX-I1 iPhone 17 on iOS 27.0, 1 passed, 0 failed, 0 skipped, exit 0. The PNG mtimes are 19:11:14 and 19:12:07, inside those runs. |
| Presenter run | `.private/ios-test-20261028T000542Z-39018.txt`: inputs `1281a16f…`, only `testGoalPresentersStayOverSettings`, 1 passed, 0 failed, 0 skipped, exit 0. The log prints `GOAL_PRESENTATION_CYCLE 1/2/3 PASSED` and "Executed 1 test, with 0 failures" in 248 s. |
| Batch receipt | `work-native-after-goal-fix-r5-heavy-release.json`: 4 runs. The 3 phone runs exited 0 and the iPad presenter exited 65. Execution including cleanup took 671 s within the 20-minute bound. The lock probe reads free and both owned simulators are shut down. |
| iPad failure | `ipad-work-goal-fix-r5-ipad-presenter.log` shows 2 failures at `:126` "Keeping the goal preserves it". Each was followed by a "CYCLE N PASSED" line, which is why R6 adds `continueAfterFailure = false`. The phone run had 0 failures, so its three PASSED lines are real. |
| Annotations | All 7 PNG hashes match `work-phone-annotated-evidence.json`. The loading and replace "after" inputs are the two fresh R5 frames. |

## Source delta since 65

Every app change since 65 is listed here. All of it is in `AutomationViews.swift`.

1. **65 M1, `:255`.** The label is now `ProgressView { Text(…).foregroundStyle(Palette.muted) }`. The non-Work branch and the Learning branch at `:242` are untouched. The pixels confirm what 65 predicted: the inner style wins, and the label renders as `#697268`.
2. **R5, `:566`.** `.accessibilityLabel("Objective").accessibilityIdentifier("automation.goal.objective")` on the objective `TextField`. This has no pixel effect. The label matches the visible section header "Objective" (`:572`), so the accessible name contains the visible label. Side effect, unverified: VoiceOver now announces "Objective" instead of the placeholder question. Whether the empty field still exposes the placeholder as a hint is a VoiceOver question, and this review cannot settle it.
3. **The Replace sheet (`:584-594`) is unchanged since 65.** That covers `onDismiss` calling `save()` only when `pendingReplacement` is set, and Accept, Keep and swipe all leaving the flag in its safe state. 65 approved it. It is now rendered and tested.

Test-only changes:

- **65 R1 (`ScreenshotTourTests.swift:782-786`).** The after stage waits for `enabled == true` on Refresh before tapping. This is exactly what 65 asked for.
- **65 R2 (`AutomationFlowTests.swift:108`).** `guard remainsPresented(editor, …)` after Keep editing, as asked. `remainsPresented` calls `XCTFail` before it returns false, so the early `return` cannot pass silently.
- **R5 (`AutomationFlowTests.swift:97`, `ScreenshotTourTests.swift:731`).** The objective query now uses the identifier, because a filled field exposes no `placeholderValue`. In the tour, the after `goal-set-form` capture at `:730` runs before the query, so the reused r2 set-form frame is unaffected. The before stage keeps the placeholder query.
- **R6 (`AutomationFlowTests.swift:66, 127-130`).** `continueAfterFailure = false`. After Clear Keep, the test runs `reveal(resume, in: form, downward: true)` and then `waitForExistence(timeout: 5)` in place of an immediate `.exists`. The fresh-read title check that follows is unchanged, and it is the assertion that would catch a Keep that actually cleared the goal.

No changed caller reaches settled 63 or 65 code beyond what is listed above.

## Reuse of the R5 phone presenter run under R6

**Approved for `b3bb3d95…`, on narrow grounds.**

- The app is unchanged, and the run passed with 0 failures, so `continueAfterFailure` never came into play.
- In the passing run, `Resume goal` existed right after Keep. The log shows one existence check at `t = 65.24s` and the test continued. `waitForExistence` returns at once in that state.
- `reveal` returns before any gesture when the element `canTap`. The phone log contains **zero** swipe events across all 3 cycles, so the form never scrolled. `reveal(clear)` found Clear tappable in place, and Resume sits above Clear in that unscrolled form. On the phone, then, the R6 reveal performs no gesture and the execution path is the same as R5's.
- So the R6 assertions are equal to or weaker than the R5 assertions at the changed line, and neither adds a step. A run that passed at R5 proves the same contract at R6.
- The reuse covers the 3 cycles: Cancel, Keep editing with the draft kept, confirmed Replace with reconciliation, Clear Keep, a fresh read, and Clear accept.

This reuse does not extend to iPad. The iPad log has 3 swipes, and the R6 change is precisely what the iPad needs to prove in its rerun.

## Scores for the two fresh frames, each judged alone

| Frame | Score | Note |
| --- | --- | --- |
| `goal-loading` | 9 | "Loading Work…" in body type at `#697268` on white, 4.99. It sits under the caption-size "Managed by Hermes" in the same ink, so the status reads as content, not chrome. Disabled Refresh at 1.84 is exempt and reads as disabled. The spinner is `#558F7E`, 3.74, which passes 3:1 for non-text. Carried optional: the spinner is centered over the label inside a leading card (65). |
| `goal-replace` | 9 | The system popover is gone. The sheet structure matches `goal-clear` exactly: grabber, black title, muted message, outlined danger action, filled Keep default. The editor behind it is dimmed but stays legible as context. The message repeats the inline warning on purpose, because the confirmation has to stand on its own. Nothing is clipped, and the detent leaves the same bottom margin as Clear. See `66-collages/a-replace-before-after-vs-clear.png`. |

### Contrast, my own samples on the R5 pixels

My sampler draws its own boxes, independent of root's fractions. Background is the most common pixel. Ink is the highest-contrast color with at least 8 pixels.

| Pair | Ink on fill | Ratio | Root |
| --- | --- | --- | --- |
| Loading Work… | `#697268` on `#FFFFFF` | **4.99** | 4.99 |
| Managed by Hermes (loading) | `#697268` on `#FFFFFF` | 4.99 | n/a |
| Spinner, non-text | `#558F7E` on `#FFFFFF` | 3.74 | n/a |
| Refresh status, disabled | `#BFBFBF` on `#FFFFFF` | 1.84, exempt | n/a |
| Sheet title | `#000000` on `#FFFDF7` | 20.65 | n/a |
| Sheet message | `#5F685E` on `#FFFDF7` | **5.69** | 5.69 |
| Replace goal, danger | `#A33C32` on `#FFFDF7` | **6.35** | 6.35 |
| Keep editing | `#FFFDF7` on `#246F59` | **5.91** | 5.91 |
| Replace outline | `#D9DED2` on `#FFFDF7` | 1.35 | n/a |
| Dimmed editor warning, behind scrim | `#8F352C` on `#E0E0E0` | 5.86 | n/a |
| Dimmed editor Cancel, behind scrim | `#20624E` on `#D2D1CC` | 4.71 | n/a |

The 1.35 outline is not a 1.4.11 failure. The danger label alone identifies the button, and the Clear sheet that 63 scored 9 uses the same treatment. The dimmed editor is inert behind the modal, but it still passes.

## iPhone W1 gate

| Set | Frames | Score | Source |
| --- | --- | --- | --- |
| Retained from 63 | 20 | 9 each | r2 `76954fa9…`, reuse approved by 65, reconstruction verified above |
| Fresh R5 | 2 | 9 each | `1281a16f…`, app-identical to current `b3bb3d95…` |
| Unscored | `learning-smoke` | n/a | out of scope |

All 22 iPhone W1 frames score at least 9. **iPhone W1 is closed** at `b3bb3d95…`. That rests on the presenter reuse above, plus the fresh interrupted and rejected tests and the task smoke, which 65 already carried forward.

## Nonblocking

1. **The AX title pointer is still on the lettering.** `work-phone-annotated-evidence.json` says the 63 correction "moved [the marker] off the lettering". In `work-w1-phone-ax-title.png`, though, the after dot sits on the "w" of "New" and the arrow crosses "at". The caption fix did land. The before marker also overlaps the "S" of "Start". In `work-w1-phone-loading.png`, both arrowheads touch the first glyph, the "R" and the "L". See `66-collages/d-annotation-markers.png`. Fix the specs only, then re-render the annotations with no simulator:
   - In `ax-title.json` after, put the dot in the gap between Cancel and the title, e.g. fraction ≈ `[0.335, 0.115]`, offset `[-30, -30]`.
   - In `loading.json`, change both fractions from x 0.08 to about 0.07.
2. **Spinner off-axis.** This is the optional item from 65. `HStack { ProgressView(); Text(…) }` would fix it. It is not a gate item.
3. **Record the current fingerprint.** `work-native-after-iphone-final-evidence.json` still says "independent final phone gate pending" and names only `1281a16f…` as the render source. The ledger entry should cite `b3bb3d95…` as the closing source and point to `work-goal-fix-r6-source-proof.json`.
4. **Carried, unchanged:** the duplicate receipt text, the W2 header split at 3.37 against 4.70, the app-wide placeholder at 1.72, and the "Start a new resume attempt" wrap at AX3.

## Rerun

**iPhone: none.** If any file under the fingerprint inputs changes again, a source proof that reconstructs `b3bb3d95…` is the minimum. If the change touches app code on a reused path, rerun the affected frames.

**iPad (out of scope, for queue planning only):** R6 must earn its own pass. That means the presenter test for 3 cycles at `b3bb3d95…`, plus the 7 pending frames. One watch item for that run: `reveal(resume, downward: true)` swipes the settings form down. If the form is already at the top, a swipe-down gesture could start dragging the settings sheet. On iPad, Resume should come into view before the form reaches the top, so this is unlikely. If the run fails there, check for that first.

## Files in `66-collages/`

- `a-replace-before-after-vs-clear.png`: the r4 popover, the R5 sheet and the r2 Clear sheet, at a common height of 1300 px.
- `b-loading-r2-left-r5-right-unscaled.png`: unscaled status-card crops at 3.44 and 4.99.
- `c-replace-sheet-unscaled.png`: the unscaled bottom half of the R5 Replace sheet.
- `d-annotation-markers.png`: the marker overlaps in nonblocking 1.
- Scripts are in `/Volumes/DevSSD/scratch/rev66/` (`sample.py`, `collage.py`), outside the artifact tree. Each takes the artifact root as its only argument. Run them with `uv run --no-project --with pillow python -I`.
