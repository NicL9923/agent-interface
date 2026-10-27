# 47: Memory web recheck after review 44 and duck 45

- Reviewer: Claude Opus 5.5, high effort, no subagents. Root OpenAI implemented, so this review is cross-provider.
- Scope: the web Memory delta since review 44, plus the duck 45 fixes and their callers. Native is not scored.
- Code read: `src/components/MemoryPanel.tsx` (all), the Memory block in `src/components/experience.css:102-136`, the compact tab change in `src/styles.css:959-988`, the Memory callers in `src/BotSettings.tsx`, the Memory branch of `.agents/tools/capture-design.js:375-525`, and the new tests in `tests/experience-ui.test.ts`.
- Images: all 35 R7 AFTER images, viewed in labeled collages and zoomed crops, plus all six annotated pairs.
- Not run: tests, typecheck, build, browsers, simulators and locks. I relied on `memory-web-tests-v7.log` (75 passed), `memory-typecheck-v7.log` (tsrs, no diagnostics printed) and the R7 receipt.
- Collages, crops and scripts: `reviews/47-collages/`. Pillow ran through `uv` with its cache on the SSD.

## Verdict

**Passes.** There are no must-fixes. Every surface scores 9.0 from its own images and geometry. No score is averaged or projected.

| Surface | Images scored | Score | Gate |
| --- | --- | --- | --- |
| Desktop 1440 and tablet 768 | desktop, tablet, conflict-1440, conflict-draft-focus-1440, dirty-1440 | 9.0 | Pass |
| Phone 390 | phone, phone-long-entry, too-long, disabled, conflict-discard, empty, loading, load-error, saving, saved, the four dialogs, reload-failed, reload-recovered, retried, same-revision-reload | 9.0 | Pass |
| Narrow 320 | narrow, narrow-long-entry, dirty-320, conflict-320, conflict-draft-focus-320 | 9.0 | Pass |
| Dark 390 | dark, dark-long-entry, dark-conflict | 9.0 | Pass |
| 200 percent text | large-text, large-text-long-entry, large-text-actions, large-text-conflict | 9.0 | Pass |

The should-fixes below are real but small. None hides content, blocks a task or misstates state.

## Evidence integrity, verified

- **Source fingerprint:** I reran `source-state.py src/ .agents/tools/capture-design.js .agents/fixtures/memory-design.json .agents/tools/capture-design.py` on the current worktree. It returns `sha256:de0a6dd5…60fe (226 source files)`, which matches the evidence and the receipt. It still excludes `tests/`.
- **Fixture:** `.agents/fixtures/memory-design.json` hashes to `ce694ada…7634`, which matches.
- **Report:** `memory-after-captures-r7/memory-after.json` hashes to `c8703df1…a31a`, which matches `reportSHA256`.
- **Images:** all 35 image hashes in `memory-web-after-evidence.json` match the files.
- **Checks:** the evidence `checks` equal the report's `memoryChecks` exactly.
- **Report contents:** `browserErrors: []`, and none of the 35 geometry entries has `overflow: true`.
- **Receipt:** build exit 0, capture exit 0, cleanup exit 0, `withinDeadline: true`, 47 s of execution.
- **Capture script:** `memory-after-captures-r7/memory-after-capture.js` matches the repo's `capture-design.js` byte for byte, apart from the run-code wrapper and the inlined fixture.
- **Strict checks are not relaxed:**
  - `visibleError` at `capture-design.js:381-399` still requires `box.top >= area.top && box.bottom <= area.bottom` with no tolerance.
  - The focused variant also requires `activeElement === error`.
  - On timeout it saves a `.failed.png` and throws with the bounds.
  - The recorded results:
    - `dark-conflict`: error top 167.4 against a view top of 155.5, so the 12 px scroll margin holds. `focusedError: true`.
    - `large-text-conflict`: 299.5 to 773.5 inside a view of 288 to 833. `focusedError: true`.
    - `discard-lock-reason`: 197.4 to 290.6, fully visible. Focus is on the "Assistant notes" heading, which is the settled behavior.
- **Long entries:** the clipped-without-cue guard is at `capture-design.js:415`. Measured fits:
  - Phone and dark: 173/173.
  - Narrow: 222/222.
  - 200 percent: 420 of 570, with the hint present.
- **BEFORE:** I did not re-hash the 20 BEFORE images. Review 44 verified them, and I only used them through the annotations.

## Review 44 blockers, verified fixed

### M1, read-only look and an off-screen reason: fixed

- **Style:** `experience.css:117` gives read-only fields the `--rail` fill, a dashed border and `resize: none`. The ink color stays the same.
  - Light: the editable fill is `--raised` and the locked fill is `--rail`. With the dashed border, the difference is visible at a glance in conflict-320, conflict-1440, disabled and conflict-discard.
  - Dark: the locked fill is darker than the editable fill, and the dashed border shows clearly in dark-conflict.
  - Text on the locked fill is 12.2:1 in light and 15.0:1 in dark.
- **Placement:** the conflict message now renders under the document heading (`MemoryPanel.tsx:116`). The disabled note is in the same place (`:117`).
  - In conflict-discard at 390, the reason sits at y=197, directly under "Assistant notes" and above the first locked entry.
  - In disabled at 390, "Editing is disabled in this Hermes profile…" sits right under "About this profile".
- **Specificity:** `.memory-panel .memory-heading + .form-error` at (0,3,0) now beats `.memory-panel .form-error` at (0,2,0). Its 16 px bottom margin applies, and the images show a clear gap before "Assistant note 1".

### M2, clipped long notes: fixed

- **How:** `MemoryText` (`MemoryPanel.tsx:24-52`) fits the height to `scrollHeight` on value changes, observes width through a `ResizeObserver` with a window `resize` fallback, and caps the height at `min(32rem, 50dvh)`.
- **Phone, 320 and dark:** the full Garden note shows with no inner scroll.
- **200 percent:** the field caps at 420 px and shows "Scroll within this entry to read more." directly below it (crop in `h-crops.png`). This is the cue review 44 asked for when the content goes past the cap.

### M3, "Me…" at 200 percent: fixed

- **How:** the compact bar wraps (`styles.css:962`), the overflow trigger no longer shrinks (`:968`), and the ellipsis is gone (`:986`).
- **Result:** at 200 percent, "Memory ›" is complete on its own second row, with the active underline.
- **Other names:** "Connections" is the longest overflow label. It will also get its own row, because the trigger never shrinks and the bar wraps. No image shows it.

### Review 44 should-fixes 1 and 2

- **S1:** the loading image shows no Reload button. That's `MemoryPanel.tsx:194`, `memory && !error`.
- **S2:** the dirty helper "Save or discard your edits before forgetting a saved entry." appears while a document has edits and isn't locked (`:118`). It shows in close-confirmation, saving and saved, under "About this profile".

## Duck 45 fixes, verified

- **Scroll margin:** `scroll-margin-top: 12px` is on `.memory-panel .form-error` (`experience.css:128`). Recorded gaps are 12 px in dark-conflict, 11.5 px in large-text-conflict and 42 px in discard.
- **No needless scroll:** the error effect (`:95-102`) focuses with `preventScroll` and scrolls only when the box is within 12 px of either edge of `.settings-content`.
  - The bottom check ignores `scroll-padding-bottom`. That's correct here, because Memory has no `.sticky-actions` footer. That padding exists only for the tabs that do.
- **Diagnostics:** failure runs record the bounds, `focusedError`, the active element and the computed `scrollMarginTop`, and save a `.failed.png`. The success path records the same fields.

## Annotation pointers, verified against R7 geometry

All six after-images point at the R7 renders. Each pointer lands on its target:

| Pair | Pointer | Target from geometry | Result |
| --- | --- | --- | --- |
| Opening, 390 | 1 at y=325 | scope block, about 272 to 410 | On target |
| | 2 at y=425 | the gap where the saved notice used to be | Fine for a claim that something is absent |
| | 3 at y=495 | "Assistant note 1" label, about 485 to 503 | On the label. Review 44's S3 is fixed. |
| Conflict, 320 | 1 at y=185.8 | error box at 167.8 to 328.2 | Inside |
| | 2 at y=391.2 | first locked field at 373.2 | Inside |
| Discard, 390 | 1 at y=217.4 | error box at 197.4 to 290.6 | Inside |
| Load error, 390 | 1 at y=580 | "Try loading again" at about 554 to 598 | Inside |
| Long entry, 320 | 1 at y=370.8 | Garden field at 335.8 to 559.8 | Inside |
| 200 percent | 2 at (290, 254) | the "Memory ›" trigger | On target. The badge covers the final "y" of "Memory", which is the word the claim is about. Nudge it right by about 30 px. |

Every claim is true in its image. On the long-entry pair:

- The BEFORE is the dirty-320 state, with entry 4 present and Save enabled.
- The AFTER is the clean narrow-long-entry state.
- The note says only "The same Garden note", which is accurate. It doesn't claim the draft state is the same.
- The label also changed between the two, from "Memory 3" to "Assistant note 3". That's a real improvement, but the annotation doesn't mention it.

## Should-fix

None of these blocks the gate.

### S1. The scroll hint is announced twice

- **Where:** `MemoryText` renders the hint `<span>` inside the parent `<label>` (`MemoryPanel.tsx:51`, `:121-124`).
- **Effect:** the label's text becomes the textarea's accessible name, so the name becomes "Assistant note 3 Scroll within this entry to read more.". `aria-describedby` then repeats the hint.
- **Basis:** this is inferred from the DOM structure and the label naming rules. I did not check it with VoiceOver or in an accessibility tree.
- **Fix:** render the hint as a sibling after `</label>`, or wrap the label text in an element and point `aria-labelledby` at it.

### S2. A scrolled conflict loses its document heading

- **Where:** the error effect and `scroll-margin-top: 12px`.
- **Evidence:** in dark-conflict, conflict-320 and conflict-1440, the error lands 12 px under the tabs and "Assistant notes" sits above the fold. The copy ("Hermes memory changed since you opened it…") doesn't name the document. The person has to infer it from the "Assistant note N" labels.
- **Fix:** scroll the heading row into view when heading and error together fit in the scroller, and fall back to the error otherwise, which is what 200 percent needs. Or name the document in the conflict copy.

### S3. Reload and Discard land headings almost flush with the tab rule

- **Where:** `reload()` and `restoreHeading()` use `scrollIntoView({ block: "start" })`, and the headings have no `scroll-margin-top`.
- **Evidence:** reload-failed, reload-recovered and same-revision-reload put "What Hermes remembers" about 3 to 4 px under the tab rule. Conflict-discard puts "Assistant notes" about 8 px under it. Nothing is clipped, but the result looks cramped compared with the 26 px resting padding.
- **Fix:** add `scroll-margin-top: 12px` to `.memory-intro h2` and `.memory-heading h3`, matching the error.

### S4. The disabled Forget can be a screen away from its reason

- **Evidence:** in dirty-320 and dirty-1440, the person has scrolled to the action row. The disabled Forget buttons on notes 2 and 3 are visible, but the helper sits under the document heading, out of view.
- **Fix:** add `aria-describedby` from each disabled Forget to the helper's id, which fixes it for screen readers. The current visual placement is acceptable.

### S5. Field borders have low contrast across the app

This is a shared-token baseline issue, not a Memory regression.

- **Measured:** `--line` against the surface is 1.29:1 in light and 1.69:1 in dark. The editable fill against the surface is 1.04:1 in light. WCAG 1.4.11 asks for 3:1 when a boundary is what identifies a field.
- **Why it doesn't block:** Memory fields are still clear in every image. Labels, size and position identify them, and the read-only treatment adds a fill change.
- **Fix:** raise the input border token once for every settings form.

### Nits

- **200 percent:** the close × and the "+" in "Add memory" keep their pixel size while the text doubles. This is shared icon sizing.
- **200 percent:** the wrapped tab bar leaves "Memory ›" alone on a second row. It's acceptable, though it uses about 70 px of an 844 px viewport.
- **Close-confirmation, 390:** the shared discard banner sits about 8 px above "What Hermes remembers". This is BotSettings chrome, not Memory.
- **Unit coverage:** no unit test covers the initial-load Reload hiding, the dirty helper, or the error rendering before the first entry. Each is a cheap DOM assertion. Autosize and the hint depend on real layout, so the capture is the right check for them, and it has one.

## Limits of this review

- **Synthetic Hermes:** every state comes from `.agents/fixtures/memory-design.json` and stubbed API responses, not live Hermes storage, limits or timing.
- **No assistive-technology or clipboard checks:** I ran no VoiceOver or other screen reader and no system clipboard readback. Selection checks prove the conflicted text is focusable and selectable (0 to 87), not that Copy works. S1 is inferred from the DOM.
- **Native is not scored:** native R6 was active during this review. I started no browsers, tests, builds, simulators or locks.
- **Untested resize paths:** I didn't exercise the `ResizeObserver` and window `resize` paths beyond what the 35 static captures cover. No capture changes width or text size after mount.
- **Gaps in the 200 percent captures:** no dialog, forget confirmation or load error was captured at 200 percent. Dark has no dialog or disabled capture.
- **Test and typecheck results come from logs:** both are as reported for v7, and the fingerprint excludes `tests/`.
