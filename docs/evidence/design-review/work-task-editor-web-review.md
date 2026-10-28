# 98. Work W2b task editors: web recheck and native keyboard source check

Reviewer: Anthropic Claude Opus 5.5, high effort. Independent of the OpenAI implementers, GPT-6.1 Sol and GPT-6.1 Terra.
Method: source reading, saved images, offline Pillow checks, plus two cheap offline test runs: vitest on `tests/automation-ui.test.ts` and unittest on `tests/test_bind_work_editor_web.py`. I ran no builds, browsers, simulators, locks or probes, and edited no app, tool, test, fixture or ledger files. Files written: this review and `98-collages/` (`make.py`, `measure.py`, four phone collages and `native-actual.diff`).

## Decisions

- **Web gate (scope A): passes.** All 16 R5 frames score 9. MF1 and MF2 are fixed and N1 is applied. One small must-fix is in the new binder's test, not in the app or the evidence. See A-MF1.
- **Native source (scope B): ready for one fresh bounded canary.** There is no compile blocker I can find. The prepared phone R4 batch is consistent with the plan. The iPad batch is consistent too. Whether the toolbar renders is a runtime question, and the canary answers it. Two cheap hardening options are below, and neither blocks.
- **Native visual gate: not scored.** It was out of scope.

## Ledger facts I verified

| Item | Result |
| --- | --- |
| `work-w2b-review96-fixes.patch` vs working tree diffed against `work-w2b-review96-before.index` (3 web files) | Identical |
| Web source `source-state.py src capture-design.js capture-design.py work-tasks.json` | `sha256:eb880a85…729b (226)`, which matches R5 |
| Fixture `work-tasks.json` | `e8fee514…e744`, which matches |
| Native source, 4 prefixes | `sha256:087e693a…9cb9 (243)`, which matches the prep and both pin files |
| `work-w2b-native-keyboard-control.patch` vs saved before files | Same hunks. Only the context offsets differ from `diff -u` |
| vitest `automation-ui.test.ts` | 41/41 pass on my run. The red log shows the 2 MF2 cases failing before the fix |
| R5 receipt | build 0, capture 0, released 21:44:47.340189Z, scoped 21:44:47.392827Z, before the deadline, inode 17430620 |
| In-memory rebind of R5 with the current binder (no output written) | All 16 sha256, mtime and dimension values equal v2. Tool sha `3687dfb8…` equals v2 |

## Scope A: web

### A-MF1. The binder tests fail on the default macOS temp dir (`bind-work-editor-web.py:35`)

- `bind` compares `{str(p.resolve()) for p in folder.glob('*.png')}` with the raw `report['paths']` strings.
- On macOS, `tempfile` gives `/var/folders/…`, and `/var` is a symlink to `/private/var`. The resolved glob never equals the unresolved report path.
- Run with the default `TMPDIR`: **3 of 6 tests fail** (`binds_passed_images`, `refuses_an_image_from_an_earlier_run`, `refuses_a_clipped_result`). All fail with "exactly the PNGs". All 6 pass with `TMPDIR` on the SSD. So "six offline tests pass" holds only in the root's environment.
- The R5 evidence is unaffected. Its paths have no symlink, and my rebind matches v2 exactly.
- **Fix:** compare resolved paths on both sides: `{p.resolve() for p in folder.glob('*.png')} != {Path(p).resolve() for p in paths}`. This makes the tool correct for any symlinked capture root, and the tests then pass anywhere. Rerun the 6 tests with the default `TMPDIR`. The binder sha changes, so produce a v3 binding (same raw files) or record that v2 used the prior sha. No recapture is needed.

### MF2 logic, checked against `useAutomation`

The key is `[requestId, reviewVersion, phase]`, which is correct for each path I traced:

| Path | What happens | Result |
| --- | --- | --- |
| A successful card action in the no-match or match phase | `busy` toggles `resend` or `likely`. `changeTask` uses `overview.setData` and never bumps `refreshCount`. The key is unchanged | No refocus. The test covers both phases |
| Refresh pending while unconfirmed | `refresh()` bumps `refreshCount` at the start, and `uncertain` holds until `onData`. Keying unconfirmed on `attempt.refreshCount` keeps the key stable | Focus stays on Refresh. The first new test discriminates: keying on `control.refreshCount` would refocus |
| Refresh completes | `uncertain` clears, then the no-match or match key with the new `refreshCount` | Focuses and announces once |
| Another Refresh in the no-match phase | New `refreshCount` | Re-announces, as intended |
| Resubmit the same `requestId` and get unconfirmed again | The snapshot's `refreshCount` is now higher, so the key is new | Focuses once |
| A background reload or goal action | Only `loading` or `busy` toggles. The phase is null for a moment, then the same key returns | No refocus |
| `attempt` identity changes when `unconfirmed:false` is set | Same key | No refocus |

**N-A1, nonblocking, existed before review 96.** In the no-match phase, a second Refresh that *fails* still bumps `refreshCount`. `uncertain` stays false and `disabled` returns to false, so the effect focuses and announces "No new task with this title is visible." while the panel shows the load error. The old effect did the same, so this is not a regression. The trigger is a network flake during a second review. If you touch it later, gate on `!control.error`, or make `refresh` bump the count only on success.

### MF1

- Both landings quote the title. The `Created.` prefix is kept, and `capture-design.js:766` still matches.
- The focused card notice and the `Task result` live region carry the same string. Tests assert both strings for the match path and the live region for the create path.
- Measured in the frames: the notice text is 5.91:1 in both `create-saved` and `create-uncertain-closed`.
- Straight quotes match house style.

### N1 scope

`.automation-tasks form.automation-form > label` reaches only the create `<form>` and the edit `<form>`. The block and review subforms are `div.automation-form`. Triggers live outside `.automation-tasks`, and the goal form has its own rule. The W1 and W2a CSS are untouched.

Measured rhythm: label text to control is about 10 px, and control bottom to the next label is about 22 px on the phone and about 24 px on desktop. That matches the goal form. Grouping stays clear at about 2:1.

### Annotations (N3)

- The `edit-desktop` AFTER arrow 2 tip is at (445,662), on Save's left edge at its center height. The BEFORE arrow 2 lands on the old Save at its center height.
- The `create-phone` and `create-recovery` tips land on the row's checkbox edge, the Create task top and the callout's left rule.
- All 7 captions match their frames.

### Scores, every frame rescored at full resolution

Contrast was sampled from pixels. Muted status is 4.70 in light and 7.57 in dark. Labels in dark are 14.15. Callout and body text are 13.36. Notices are 5.91. Primary buttons are about 46 px tall, and checkbox rows are 44 px or more.

| # | Frame | Score | Basis |
| --- | --- | --- | --- |
| 1 | create-desktop | 9 | Tighter fields, optional labels, aligned rows with status. The heading clears the tab rule |
| 2 | create-dark | 9 | Same layout. Checkbox outlines are visible and the status is legible |
| 3 | create-phone-top | 9 | About 70 px less height before the list. Long rows wrap under the title |
| 4 | create-phone-bottom | 9 | Bounded list end, help text and primary Create task together |
| 5 | create-narrow | 9 | At 320 px, the instructions and long rows wrap cleanly and fields fit |
| 6 | create-large-text-top | 9 | At 200%, the heading, labels and fields hold. The single-line input scrolls its text |
| 7 | create-large-text-bottom | 9 | Help text, Create task and a wrapped Cancel are all reachable |
| 8 | create-saved | 9 | **Fixed.** `Created. "Plan the winter supplies" stays blocked…` names the task on screen and in the announcement |
| 9 | create-uncertain-form | 9 | The callout sits directly above the disabled actions and explains them |
| 10 | create-uncertain-alert | 9 | Unchanged W1 alert in context |
| 11 | create-refreshed-form | 9 | Match callout, the list with the match filtered out, and a single primary Close |
| 12 | create-uncertain-closed | 9 | **Fixed.** `"Plan the winter supplies" appeared on the board…` |
| 13 | edit-desktop | 9 | Edit task heading, primary Save task, tighter rhythm, clear break before Dependencies |
| 14 | edit-phone | 9 | Same at 390 px |
| 15 | edit-large-text | 9 | Primary Save task, wrapped Cancel, then Dependencies |
| 16 | edit-saved | 9 | "Saved in Hermes." under Edit task. The summary shows Ready and Unassigned |

16 of 16 frames score 9. No averaging and no projection. R4 is superseded.

## Scope B: native keyboard control, source and prep only

### Evidence check

The R3 hierarchy shows `automation.taskTitle … Keyboard Focused` and `Keyboard {{0,590},{402,226}}` after the drag. The failure PNG shows the keyboard still up. The log at `:1660` has "Form drag must dismiss the keyboard…". The release came at 21:53:41.629756Z. **This runtime result disproves hypothesis H1 from my review 97.** On this OS, the Form drag did not dismiss the keyboard. With that evidence in hand, my review 97 advice to keep product changes out of this gate no longer holds. An explicit Hide keyboard control is now a justified product fix, not just parity with the composer.

### Source review of `HermesTaskEditor`

- **Compile:** I see no blocker.
  - `private enum Field: Hashable` with `@FocusState var focusedField: Field?` and `.focused($focusedField, equals:)` is standard.
  - `ToolbarItemGroup(placement: .keyboard)` takes a ViewBuilder, so `if` and `Spacer()` are legal.
  - `Palette.muted` exists, the deployment target is 17.0, and nothing new crosses an actor boundary under Swift 6 strict concurrency.
  - This is a parse-level reading, not a compile.
- **Accuracy note:** this is the **first `.keyboard` toolbar in the app**. The composer's `hideKeyboard` is an inline button, not a keyboard toolbar. Matching the composer's look, label and 44 pt frame is correct. The rendering path has no in-app precedent, which is why the canary matters.
- **B-N1, runtime risk, unverified, cheap mitigation.** The `if focusedField != nil` wrapper is redundant, because a keyboard toolbar shows only while a field in this view has the keyboard, and only Title and Instructions are text inputs. It also adds a dependency on SwiftUI updating `FocusState` before it builds the keyboard accessory. A conditional keyboard toolbar that starts empty has been reported to miss the first focus on some iOS releases. I could not verify that for this OS. Dropping the `if` removes the question at no cost. If you keep it, the canary's `waitForExistence` will show whether it matters.
- **Accessibility:**
  - "Hide keyboard" is the label and `automation.taskEditor.hideKeyboard` is the ID, with a 44×44 frame.
  - The icon is muted, so check its contrast against the keyboard bar in the new keyboard frames, in light and dark. Non-text needs 3:1.
  - At AX3, `.font(.body)` makes the symbol larger, but the 44 pt frame stays fixed. This is the same trade as the composer. Inspect it in `task-create-large-text-keyboard`.
- **Lifetime:**
  - No new state outlives the sheet.
  - Hiding the keyboard while `busy` is harmless, because the button is not under `fields.disabled`.
  - Cancel or Create with the keyboard up dismisses as before.
  - Payload, controls and announcements are unchanged.

### UI test changes

- `hideEditorKeyboard` asserts that the button exists, is hittable and measures at least 44 pt. After the tap, it asserts that the keyboard disappears, the editor stays and the title is unchanged. This is the right contract. It does not use Return, private state or blind coordinates.
- **B-N2, nonblocking.** `button.isHittable` is checked once, right after `waitForExistence`. With first-failure-abort, a toolbar still animating in would cost the run. Use the existing `waitUntilHittable()` in place of the bare `isHittable`. Both current call sites follow seconds of typing or a capture, so the risk is low.
- The `fill(full:)` path now hides the keyboard before the picker. Before, the picker press dismissed it as a side effect, so this is deterministic now.
- The strict no-keyboard guards remain in `revealRange` and `editorLayoutCapture`.
- `task-create-large-text-keyboard` is captured on purpose with the keyboard up and goes through no range check. That is correct for showing the control.
- The dark capture keeps the keyboard up, and the new accessory bar sits about 44 pt higher. The title ends near y 394, well clear of it.
- iPad note: if the simulator runs with a hardware keyboard, the "keyboard" frame shows no keyboard, while the hide test still passes. Check the pad frame before calling it a keyboard-visible state.

### Prepared batches, checked and not invoked

**Phone, `.private/work-native-w2b-after-phone-r4-batch.py`:**

| Check | Result |
| --- | --- |
| Source pin | `work-native-w2b-after-phone-r4-source.txt` matches the current source |
| Fixture pin | `work-w2a-after-fixture-sha256.txt` = `e8fee514…`. Same value; only the filename says w2a |
| Device | Own iPhone `FA657F96` only. Shutdown is verified at cleanup |
| Lock | Inode asserted before a single `LOCK_NB` attempt. Exits on hold. Unlocks only after confirming no owned child is live |
| Budget | 1080 s work, 120 s cleanup, 240 s start floor before each variant, `-jobs 2`, 300 s per test |
| Order | Regressions first, then the risky large-text variant, then the other four. Aborts on first failure |
| Strict checks | XCTest summary `Passed`, exact pass count (2 or 1), 0 failed, 0 skipped, a completion marker, and an exact set of PNG names per variant |
| Frames | 0+4+3+1+2+3 = **13**, matching the prep |
| Selectors | `testTaskCreationStaysBlockedUntilExplicitStart` and `testTaskEditRefusalRefreshesRunningState`. Both type into or save the editor, so they are the right affected tests. They do not assert the toolbar, and they don't need to |
| Verifier | `phone-after-b-r4` maps to stem `work-native-w2b-after-phone-r4`, and that choice exists |
| Clean slate | No reservation, launch, log or capture folder exists for r4 yet |
| Time | R1 took about 7 minutes for build plus 38 tests and about 1.5 to 1.8 minutes per variant. The estimate for R4 is about 4 to 5 minutes of build and regressions plus 5 variants at about 2 minutes, roughly 15 minutes, under the 18-minute cutoff. A slow build could trip the 240 s floor on the last variant and exit 124 with the remaining variants recorded. That is acceptable |

**iPad, `.private/work-native-w2b-after-pad-r1-batch.py`:** same source pin, its own device `A068DC6D`, unreserved. It runs 5 variants for 4+2+1+1+1 = **9** frames. The `expected_tests = 38` branch is dead code because there is no regressions variant. Totals: phone 13 + pad 9 + web 16 = 38.

### Native recommendation

The source is ready for one fresh bounded phone canary, after separate peer coordination for the lock. Before launching, optionally apply B-N1 (drop the `if`) and B-N2 (`waitUntilHittable`). Both change the source digest, so update both pin files. If the toolbar does not appear, stop at that failure. Do not fall back to drags or Return.

## Limits

- The fixture is synthetic, and 200% is a root font size, not browser zoom.
- No VoiceOver, physical device or hardware-keyboard checks were possible.
- Native findings come from source and are uncompiled. The SwiftUI keyboard-toolbar risk in B-N1 is not verified on this OS.
- Contrast is accurate to about 0.1.


Root follow-up: the binder now resolves both sets of paths and rejects duplicate canonical paths. Seven tests pass with the default macOS temp folder, including an explicit directory-alias case. The v3 evidence binding preserves the identical R5 captures, report and runtime receipt. The original reviewer report remains unchanged in the private review archive.

Native Scope B above was source and preparation only. Its two optional reliability recommendations were applied directly, producing native source 9a33d969. Native rendering and visual acceptance remain separate from this web acceptance.
