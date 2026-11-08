# 64. Work W1 web clear confirmation recheck

- Reviewer: Claude Opus 5.5, high effort, independent Anthropic reviewer. No children. Implementers: OpenAI GPT-6.1 Terra and Sol.
- Scope: only the review 62 must-fix. That covers the one CSS `margin-bottom` reset, the fresh 390px Clear frame, the updated annotated Clear comparison, the corrected phone marker, and the refreshed `work-web-after-dark-forms.png`. Native, iPad, W2, W3 and Learning are out of scope.
- Not done: no app, tool, docs or ledger edits. No tests, build, browser, simulator, service, heavy lock or probe. The only writes are this file and two crops in `64-collages/`.

## Verdict

**Passed. The full web W1 gate can close.** The Forms score rises from 8.5 to 9 on the actual R4 render. Every other web W1 surface keeps its 9 from review 62, because none of its 28 frames can be affected by this change. W1 as a whole still waits on the native gates, which are outside this review.

## Provenance, recomputed

- **Current source.** `source-state.py src/ .agents/tools/capture-design.js .agents/tools/capture-design.py .agents/fixtures/work-design.json` prints `0ec286bc…118c27 (226 source files)`. That matches the R4 source file, the reservation, the release receipt, `work-web-clear-r4-evidence.json` and `currentSource` in the combined evidence.
- **Review 62 source.** I swapped the three snapshots (`work-review62-automation.css`, `work-web-after-r2-capture-design.js`, `work-web-after-r2-capture-design.py`) into the same file walk and got `e56ec5ec…b646a (226)`. That matches review 62 and the source on all 28 reused frames. So the whole delta is in those three files.
- **TSX and tests.** `AutomationPanel.tsx` is `6d662cd2…` and `automation-ui.test.ts` is `c0d9cb06…`, unchanged from `work-web-current-source-proof.json`. The 26 tests and the typecheck from review 62 still apply.
- **Fixture.** `6d0f1062…`, unchanged.
- **CSS diff.** One added line, `automation.css:53`: `.automation-goal .automation-confirm > .actions { margin-bottom: 0; }`. That is exactly the line review 62 asked for.
- **Driver diff.**
  - JS: the new `workCase` option is validated, and it is only allowed with `work`/`after`. The `clear-confirmation` branch returns early.
  - The `all` path is unchanged. Its own clear capture is still at `capture-design.js:562`.
  - PY: adds `--work-case` (default `all`) and rejects a scoped case outside `work`/`after`.
- **R4 run.** Both build and capture exited 0. The run took 6.04s with 0s queued, finished inside the deadline, and the lock was verified free afterwards. Port 3044 was closed.
  - The report hash `277e77ef…` matches.
  - The PNG hash `45627659…` and mtime `1793144197.8638` match.
  - The report shows 1 screenshot, `overflow: false`, 0 `workSubmissions` and 0 `browserErrors`. `workChecks` records `clear-confirmation-focus` with Keep goal focused and 0 writes.
- **Focus check order.** The driver checks `keep === document.activeElement` *before* `subjectShot`, and the comment says why. Running it before the helper's deliberate blur is correct. The test at `automation-ui.test.ts:148-155` covers the same focus path in the DOM.
- **R3 exclusion.** R3 ran on a different source (`dbad1c29…`, the old driver) and failed with "Keep goal did not receive focus". No evidence file references `work-after-clear-captures-r3`. The R3 and R4 build logs differ only in build time, so the app bundle was the same and only the driver changed.
- **Combined evidence.** All 29 frames match their recorded `sha256` and `mtime`. 28 frames carry `e56ec5ec…` and the Clear frame carries `0ec286bc…`. The R2 `reportSHA256` matches. No geometry entry overflows.
- **Annotations.** All 7 annotated PNGs match `work-web-annotated-evidence.json`.
  - The after column of `work-w1-web-clear.png` matches the R4 raw frame pixel for pixel in the card region. The only differences are 12 pixels from the marker leader, against 1,082 when compared with R2.
  - The after column of the phone comparison matches the R2 phone frame exactly.

### Reuse ruling

The new selector can only match an `.actions` element that is a direct child of an `.automation-confirm` inside `.automation-goal`. In `AutomationPanel.tsx`, only the Clear card has one (`:151`):

| Card | Line | Last child |
| --- | --- | --- |
| Interrupted callout | `:128` | A checkbox label |
| Uncertain new-attempt card | `:129-131` | A bare button |
| Replace confirmation | `:158` | A checkbox label. The form's `.actions` row at `:159` is outside the confirm card |
| Trigger delete confirm | `:254` | Outside `.automation-goal` |

The driver's `all` path is unchanged. So reusing the 28 R2 frames and their review 62 ratings is valid. This is the scoped reuse approval that the reuse proof was waiting for.

## Measurements, fresh R4 Clear frame

Pixel row scan at x 34-356 with `62-collages/tools/rows.py`:

| | R2, review 62 | R4 |
| --- | --- | --- |
| Top border to first text ink | 17px | 17px |
| Button bottom to bottom border | 31px | 13px |
| Card subject height in the report | 160.39px | 142.39px |

The 18px difference is exactly the removed `margin-bottom`. The R4 bottom gap is now in line with the uncertain card's roughly 14px measured in review 62. The text sits 1px lower than the line box because of half-leading, so the visible padding is now balanced. The Task board and everything below it moved up by the same 18px. No other row changed.

## Visual review

`64-collages/clear-r2-left-r4-right.png` shows R2 on the left and R4 on the right at 2x.

- **Clear card (R4).** The padding is even on all sides. Keep goal comes first in the neutral tone and Clear goal second in danger red. The disabled Resume, Replace and Clear openers above stay muted while the card is open. The section rule and Task board sit at normal section spacing. The destructive confirmation now reads as compact as the rest of the goal family.
- **Annotated Clear.** The after column is the R4 frame. Marker 1 sits on the card's left edge and covers no text. The caption "Keep goal comes first; tests verify focus enters and returns safely" is true: see the test at `:148-155` and the R4 focus check.
- **Phone marker.** In the after column, marker 2 now sits left of the "Paused" capsule with a clear gap, as shown in `64-collages/phone-marker2-before-top-after-bottom.png`. The review 62 defect is fixed. The before-column leader touches the left edge of "paused". All the text stays readable, so it does not block.
- **Dark-forms collage.** The Clear panel is the R4 render. The scan shows the scaled card at about 187px tall, against about 208px if it were R2, and a balanced bottom gap. The dark, set and replace panels look as they did in review 62.

## Scores, actual renders only

| Surface | Score | Basis |
| --- | --- | --- |
| Forms: set-form, replace-confirmation, replace-narrow, clear-confirmation | **9** | The Clear card is now balanced in the fresh R4 render. The other three frames are unchanged R2 renders and keep their review 62 rating. |
| Desktop, Tablet, Phone, Narrow, Dark, 200% root font, States, Risk states | 9 | Reused from review 62. None of these frames can be affected by the delta. |

No web W1 surface is below 9.

## Non-blocking notes

1. **Stale entries in the combined evidence.**
   - `work-web-after-evidence.json` `geometry` still holds the R2 `goal-clear-confirmation` entry, with subject height 160.39, while its screenshot points to R4.
   - The R4 `clear-confirmation-focus` check is not merged into the top-level `workChecks`. Its count stays at 35.
   - The `clearRecheck` block links the R4 report, so the data can still be traced. Swapping in the R4 geometry entry, or labeling the old one as R2, would make the file consistent with itself.
2. **Gate status strings.** `gate` says "final scoped recheck pending". `independentReuseApproval` in the reuse proof says approval is pending. This review gives that approval. Updating those strings belongs to the ledger owner.
3. **Optional polish from review 62.** These still apply and still do not block: the checkbox-ended cards' bottom gap, Done-state Replace stretching full width on phone, three-period ellipses in the toolbar, the dark Paused capsule fill, and the duplicate "Paused".

## Limits

- **Tests.** The 26 tests and the typecheck were not re-run. They are reused, because TSX and tests are byte-identical to review 62.
- **Keyboard focus.** The focus evidence is the DOM `activeElement` in the test suite and in headless Chromium. It does not prove what VoiceOver says or how a hardware keyboard behaves.
- **200% frames.** They scale only the root font size. No browser zoom claim is made.
- **Physical devices.** No physical device was used.
- **Measurements and scores.** Pixel gaps and heights are measurements. Scores are visual judgment from the actual frames, not projections.
