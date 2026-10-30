# 67 Work W1 iPad final recheck

- Reviewer: Claude Opus 5.5, high effort, independent Anthropic reviewer. No children. The implementers were OpenAI GPT-6.1 Terra and root Sol.
- Scope: closing iPad W1. That covers the 7 new R6 frames, carrying the 15 unchanged r3 frames that 65 scored 9, the R6 iPad presenter run, and the 5 iPad annotations. Phone, web, W2, W3 and Learning are out of scope and not rescored. App source settled in 66 is not reviewed again.
- Not done: no app, test, tool, docs or ledger edits. No build, test, simulator, browser, service, heavy lock or probe. I read files and logs, hashed images, sampled pixels and made crops. Collages are in `67-collages/`.
- Device limits: iOS 27 simulator, iPad Pro 11-inch (M5), regular width, AX3 only. I make no VoiceOver, physical-device, hardware-keyboard, iOS 17, AX5 or iPad compact claims.

## Verdict

**iPad W1 closes.** All 7 new frames score 9 on their own, with no obvious issue. The 15 unchanged r3 frames keep their 65 scores of 9. The R6 presenter run passes all 3 cycles with 0 failures at the current source.

With web closed in 64 and iPhone closed in 66, **every W1 surface is now closed at 9**, bound to `b3bb3d95…`.

- Must-fix: none.
- Rerun: none.

## Evidence binding

| Check | Result |
| --- | --- |
| Current fingerprint | `source-state.py ios/ .agents/tools/validate-ios.sh .agents/tools/patch-xctestrun.py .agents/tools/with-native-admission.py` returns `b3bb3d95…` (243 files). It matches the receipt, all 5 run summaries and `work-goal-fix-r6-source-proof.json`. |
| R5 link | My own in-memory hasher swaps `work-goal-fix-r5-AutomationFlowTests.swift` into the current tree and gets `1281a16f…` (243 files). The diff contains only the R6 test delta: `continueAfterFailure = false` at `:66`, and `reveal(resume, in: form, downward: true)` plus `waitForExistence(timeout: 5)` at `:127-130`. 66 verified the rest of the chain back to `76954fa9…`. |
| Image hashes | I re-hashed all 22 PNGs in `work-native-after-ipad-final-evidence.json`. All 22 match. Every mtime matches the recorded value and falls inside its run's start and finish time. |
| Run binding | The 15 carried frames come from 11 r3 segments at `76954fa9…`, each 1 passed, 0 failed, 0 skipped, the same set 65 hashed. The 7 new frames come from 4 R6 segments at `b3bb3d95…`: loading 1, replace 1, rejected 1, uncertain AX3 4. Each summary in `.private/ios-test-20261028T0035…0038*.txt` shows iPad Pro 11-inch (M5), iOS 27.0, 1 passed, 0 failed, 0 skipped, exit 0. |
| Presenter run | `.private/ios-test-20261028T003107Z-49720.txt`: inputs `b3bb3d95…`, only `testGoalPresentersStayOverSettings`, 1 passed, 0 failed, 0 skipped, exit 0. The log prints `GOAL_PRESENTATION_CYCLE 1/2/3 PASSED` and "Executed 1 test, with 0 failures" in 257 s. Because `continueAfterFailure` is now false, any failed assertion would stop the test. A PASSED line can no longer follow a failure, unlike R5. |
| Batch receipt | `work-native-after-goal-fix-r6-heavy-release.json`: 5 runs, all exit 0. Execution including cleanup took 593 s within the 14-minute bound. Queue time was effectively zero. The lock probe reads free, there are no owned xcodebuild processes, and both owned simulators are shut down. |
| Root contrast | I sampled my own boxes and got root's four values exactly: loading 4.99, message 5.69, Replace 6.35, Keep editing 5.91. |
| Annotations | All 5 PNG hashes match `work-ipad-annotated-evidence.json`. Each "before" input appears exactly once in `work-native-before-evidence.json`, which has 20 iPad and 20 iPhone before images. The three old "after" inputs are r3 frames. The loading and replace "after" inputs are the new R6 frames. |

### The R6 iPad presenter fix, checked against the log

- After Clear then Keep, cycle 1 swipes the `automation.work` collection twice and cycles 2 and 3 swipe once. Then `Resume goal` passes `waitForExistence` within about 1 s.
- 66 asked whether a downward swipe at the top of the form could drag the settings sheet. It did not. The next step, `settingsMore` to Learning and back for the fresh read, finds its elements in every cycle, and the fresh-read title assertion passes. A dismissed sheet would fail there.
- The R5 diagnosis holds. The goal was always kept, and only the off-screen `Resume goal` check failed. R6 makes that check reveal the button first, and does not weaken what it checks. The fresh-read title assertion still catches a Keep that clears the goal.

The iPad presenter contract now holds across all 3 cycles: Cancel, Keep editing with the draft kept, confirmed Replace with reconciliation, Clear then Keep with a fresh read, and Clear accept.

## Scores for the 7 new frames, each judged alone

| Frame | Score | Note |
| --- | --- | --- |
| `goal-loading` | 9 | "Loading Work…" is in body type at `#697268` on white, 4.99, up from 3.44 in r3. It matches the "Managed by Hermes" ink above it. Disabled Refresh at 1.84 is exempt and clearly reads as disabled. The spinner passes 3:1. 65 M1 is resolved. The carried optional item is still the centered spinner over a leading label. |
| `goal-replace` | 9 | The r3 popover is gone, and with it the misplaced arrow and the spill over the composer. The nested sheet stays inside the editor's bounds and matches the iPad `goal-clear` frame: grabber, black title, muted message, outlined danger action and a filled Keep editing default. The editor behind is dimmed but still readable, and nothing is clipped. 65's 2.73 and 3.16 pairs are now 6.35 and 5.69. |
| `goal-rejected` | 9 | First iPad render. The callout has a danger icon at 6.46, a black title and a black message, with a hanging indent, the same structure as interrupted and uncertain. Resume is the single primary action. The bottom of the Resume button lands at the sheet's lower edge. That is where the scrollable form happens to sit in this capture, the same normal sheet scrolling 65 accepted on `goal-loaded`, and the whole button is visible. |
| `goal-uncertain-large-text-callout` | 9 | At AX3, the tab row collapses to the Work menu, and the badge, turns line, paused reason and callout all wrap cleanly. The half-clipped objective line under the sticky header is the known scroll artifact. 65 accepted it on `goal-interrupted`. |
| `goal-uncertain-large-text` | 9 | The frame that failed in r3. It now shows the "Resume not confirmed" heading, the complete message and "Check resume status" as the secondary button at 13.75. The log shows the reveal found the heading inside the visible band. The cut-off primary button at the bottom is normal scrolling. The callout frame shows the rest of the content. |
| `goal-uncertain-large-text-new-attempt-review` | 9 | "Review the conversation first" is the muted section header at 4.70, the same pair as the r3 headers. Body text is black on white. Cancel is 5.76. Rows wrap without truncation. |
| `goal-uncertain-large-text-new-attempt-review-bottom` | 9 | The first toggle is on, the second is off, and Start new attempt is disabled at 1.55, which is exempt and reads as disabled. The on-track green measures 6.01. The off track measures 1.72, which is the stock system switch, as on the phone frame 63 scored 9. Ghost text from the scroll-edge blur shows faintly above the title row. The title still measures about 21:1 and Cancel is untouched. The phone shows the same effect. See `67-collages/b-review-bottom-scroll-edge-ipad-vs-phone.png`. |

### Contrast, my own samples on the R6 pixels

Background is the most common pixel in my box. Ink is the highest-contrast color with at least 8 pixels. The boxes are my own and do not use root's fractions. The script is `/Volumes/DevSSD/scratch/rev67/sample.py`.

| Pair | Frame | Ink on fill | Ratio |
| --- | --- | --- | --- |
| Loading Work… | loading | `#697268` on `#FFFFFF` | **4.99** |
| Managed by Hermes | loading | `#697268` on `#FFFFFF` | 4.99 |
| Spinner, non-text | loading | `#458472` on `#FFFFFF` | 4.38 |
| Refresh status, disabled | loading | `#BFBFBF` on `#FFFFFF` | 1.84, exempt |
| Sheet title | replace | `#000000` on `#FFFDF7` | 20.65 |
| Sheet message | replace | `#5F685E` on `#FFFDF7` | **5.69** |
| Replace goal, danger | replace | `#A33C32` on `#FFFDF7` | **6.35** |
| Keep editing | replace | `#FFFDF7` on `#246F59` | **5.91** |
| Editor body behind scrim | replace | `#000000` on `#E0E0E0` | 15.91 |
| Refresh status | rejected | `#246F59` on `#FFFFFF` | 6.01 |
| Callout title and message | rejected | `#000000` on `#FFFFFF` | 21.00 |
| Danger icon | rejected | `#A33C32` on `#FFFFFF` | 6.46 |
| Paused reason | rejected | `#697268` on `#FFFFFF` | 4.99 |
| Resume goal | rejected | `#FFFDF7` on `#246F59` | 5.91 |
| AX3 turns and paused reason | callout | `#697268` on `#FFFFFF` | 4.99 |
| AX3 Work menu | callout | `#246F59` on `#F3F4F2` | 5.45 |
| AX3 callout title, attention icon | callout | `#000000`, `#9B6733` on `#FFFFFF` | 21.00, 4.79 |
| AX3 Check resume status | uncertain AX | `#000000` on `#D1D1D1` | 13.75 |
| AX3 Review header | review | `#697268` on `#FAF8F2` | 4.70 |
| AX3 Cancel | review | `#246F59` on `#FCFAF5` | 5.76 |
| AX3 body and toggle labels | review, bottom | `#000000` on `#FFFFFF` | 21.00 |
| AX3 toggle on, off | bottom | `#246F59` / `#C5C5C7` on `#FFFFFF` | 6.01 / 1.72, system control |
| AX3 Start new attempt, disabled | bottom | `#BDBDBF` on `#E9E9EB` | 1.55, exempt |
| AX3 title over scroll edge | bottom | `#000000` on `#FFFFFA` | 20.94 |

## Carrying the 15 unchanged r3 frames

**Approved.** These are `goal-loaded`, `goal-dark`, `goal-load-error`, `goal-sections-unsupported`, `goal-empty`, `goal-done`, `goal-set-form`, `goal-clear`, `goal-interrupted`, `goal-interrupted-reviewed`, `goal-uncertain`, `goal-uncertain-new-attempt-review`, `goal-large-text`, `goal-large-text-bottom` and `goal-large-text-clear`.

- Their hashes still match what 65 scored at 9.
- 65 approved their reuse at `76954fa9…`. 66 verified the chain to `b3bb3d95…`, and I re-verified the last link.
- The only app changes since r3 are the loading label, the Replace sheet and the objective field's accessibility label and identifier. None of them renders in these 15 frames. `goal-set-form` shows the objective field, but an accessibility label and identifier have no pixel effect.
- The tour's test-only changes leave these frames unaffected, for the reasons 65 gave, which still hold.

## iPad W1 gate

| Set | Frames | Score | Source |
| --- | --- | --- | --- |
| Carried r3 | 15 | 9 each | `76954fa9…`, reuse verified |
| New R6 | 7 | 9 each | `b3bb3d95…`, current |
| Presenter | 3 cycles | Passed, 0 failures | `b3bb3d95…`, current |

All 22 iPad W1 frames score at least 9, and the presenter contract passes on iPad. **iPad W1 is closed** at `b3bb3d95…`. Any later change to a fingerprint input voids this until a new source proof exists.

## Annotations

All 5 are accurate and pass.

- **Clear.** 65 nonblocking 1 is fixed. The before badge sits outside the popover's top-left corner with the arrow at its edge, and the after marker points at Keep goal's left edge. Neither covers text.
- **Loading.** Both arrowheads stop about 10 px short of the first glyph and do not touch it. That is better than the phone version 66 flagged. See `67-collages/c-ipad-loading-annotation-markers.png`.
- **Replace.** The before marker sits on the popover's left edge, outside the message. The after marker points at Keep editing's left edge.
- **Hierarchy and objective** are unchanged since 65 approved them.

## Nonblocking

1. **Evidence pointer.** `work-native-after-ipad-final-evidence.json` names `work-review63-applied-source-proof.json` as `sourceProof`, and its status still says "independent final gate pending". The ledger entry should cite `b3bb3d95…` as the closing source, `work-goal-fix-r6-source-proof.json` and this review. This is the same issue as 66 nonblocking 3.
2. **Carried, unchanged:**
   - The off-axis loading spinner.
   - The indented separator under the load-error banner.
   - The compact "Try loading again" capsule.
   - The duplicate receipt text in uncertain and rejected, which is a 63 copy decision.
   - The W2 header split at 3.37 against 4.70.
   - The app-wide placeholder at 1.72.
   - The stock off-switch track at 1.72.
3. **Remaining limits.** These results cover only the iOS 27 simulator on one iPad model, in regular width and at AX3. VoiceOver order and announcements, including whether the objective field still exposes its placeholder as a hint, are untested. So are hardware-keyboard focus, iPad compact width and Split View, AX4 and AX5, iOS 17, and physical hardware.

## Rerun

**None.** If a fingerprint input changes, the minimum is a source proof that reconstructs `b3bb3d95…`. If the change touches app code on a rendered path, rerun the affected frames on both devices.

## Files in `67-collages/`

- `0-r6-ipad-new-frames-a.png`: loading, replace and rejected, labeled with their real file stems, at a common height of 1300 px.
- `0-r6-ipad-new-frames-b-ax3.png`: the 4 AX3 uncertain frames, labeled, at 1300 px.
- `a-ax-sheets-unscaled-crop.png`: unscaled sheet crops of the 4 AX3 frames.
- `b-review-bottom-scroll-edge-ipad-vs-phone.png`: the scroll-edge band on iPad R6 next to the phone r2 frame.
- `c-ipad-loading-annotation-markers.png`: the loading marker placement.
- The scripts are in `/Volumes/DevSSD/scratch/rev67/`: `verify.py`, `recon.py`, `sample.py`, `collage.py` and the crop helpers. Each takes the artifact root, or the repo root for `recon.py`, as its argument. Run them with `uv run --no-project --with pillow python -I`.
