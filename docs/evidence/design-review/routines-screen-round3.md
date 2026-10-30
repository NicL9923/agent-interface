# Routines: whole-screen review, round 3 and final

Reviewer: Claude Opus 5.5, Anthropic. Effort High was requested. The session
does not show its configured effort as a named tier, so I can't confirm it.
OpenAI GPT-6.1 Sol implemented the work. This is round 3 of at most 3.

Scope: the product diff from `3b86a51` to `1c263ac` and its callers, plus the
round 3 captures in
`/Volumes/DevSSD/scratch/wildbots-design-review/routines-screen-r3/`. The
score covers the Routines tab and its results dialog as one screen. Web
coordinates are CSS pixels. Native coordinates are full-resolution pixels in
`native-Routines.png`, which is 1206x2622.

## Score: 9.1 / 10, passing

Round 2 scored 8.6. The routine's instructions now render at the size they
deserve, Paused has its own look on both clients, and the editor returns focus
to the card it came from. Each round 2 finding is fixed in the captures or in
code with a test. The remaining issues are small, and none of them blocks the
screen.

## Round 2 findings

| # | Round 2 issue | Status |
| --- | --- | --- |
| 1 | Instructions at 13 px | Fixed. `routine-card-1440.png` y 664-682 shows "Summarize overnight sensor alerts and the weather." larger than the 14 px Schedule and Status rows. `p.routine-prompt` beats the old `.routine-card p` rule, which still supplies `pre-wrap` and `overflow-wrap` |
| 2 | Green preview footnote | Fixed. `routine-preview-390.png` y 690-720 and `routine-paused-1440.png` y 895-910 render it muted |
| 3 | Active and Paused look the same | Fixed. Web: outlined pill with a rail fill and semibold text, `routine-paused-1440.png` x 538-602, y 602-627. Native: outlined capsule, `native-Routines.png` y about 1650-1710, with a normal row height. Shape and weight carry the state, not color |
| 4 | Cancel edit drops focus | Fixed in code. `focusRoutine` in `src/BotSettings.tsx:684-688` runs on Cancel and after a successful save. Edit buttons have no `disabled`, so the save path can focus during `busy`. Tests cover both paths |
| 5 | Refresh and Save output sizes | Fixed. `routine-results-1440.png` and `routine-results-390.png` show matching button text. At 390 the two buttons stack cleanly |
| 6 | Trial note names a missing control | Fixed. Both clients switch to "Check the saved run's status..." while a run is pending. Check run status now has `aria-describedby`. See issue 2 below for a leftover case |
| 7 | Native recipe title tint | Accepted. The dead `.foregroundStyle(.primary)` is gone, so the code now matches the green title |
| 8 | Proportional schedule input | Fixed. `routine-editor-1440.png` y 527-567 and `routine-recipe-390.png` y 490-530 use the mono face |

The DST-like jump is gone from the preview captures. They now use UTC, and the
run times stay at 6:00 AM.

## Remaining issues, most important first

1. **Observed, native: the instructions are smaller than the row labels.**
   `native-Routines.png` y about 1810-1860: "Inspect the pasture." uses
   `.footnote`, which renders smaller than "Schedule" and "Status" in the rows
   above it. That's the native form of the web bug fixed in round 2. It's
   less severe here because the text is dark and inside a grouped list.
   *Fix:* `BotSettingsView.swift:688`, change `.font(.footnote)` to
   `.font(.subheadline)` or the body font. Keep `lineLimit(6)`.

2. **Code-only: Retry the same request points to a note that doesn't cover
   it.** `RoutineEnhancements.tsx:76-80`. After a 404, `missing` shows Retry
   next to Check run status, and `canStart` stays false. Retry's
   `aria-describedby` then reads "Checking does not run it again." Retry
   does run the routine, so a screen reader user hears the opposite of what
   the button does. Native `ExperienceViews.swift:632-635` has the same text
   gap when `retrySameRun` is set. Not captured.
   *Fix:* Add a third note when `missing` is true, for example "Hermes has no
   record of this run. Retry sends the same request once." Or drop
   `aria-describedby` from Retry.

3. **Observed, low: the recipient fieldset is loose and small.**
   `routine-editor-1440.png` y 746-912: Nicolas and Jordan sit about 62 px
   apart at about 13 px, with about 40 px of empty space below Jordan. The
   Enabled label at y 694 is also 13 px, while Name, Instructions and
   Schedule labels are 14 px. This predates the round and still reads fine.
   It's the least finished part of the editor.
   *Fix:* Bring checkbox row spacing to about 44 px of touch height without
   extra margins, and match the 14 px label size.

4. **Code-only, low: Save focus depends on the card staying mounted across
   `reload()`.** `src/BotSettings.tsx:795` focuses Edit before `action` calls
   `reload()`. Keyed cards keep their nodes, so this works today. If the list
   ever shows a loading state that unmounts cards during reload, focus falls
   back to the body. The new test would catch that only if its mock reload
   unmounted cards, and it doesn't. Leave this as a note. No change needed
   now.

## What works

- Card hierarchy: name, labeled metadata, readable instructions, trial and
  inspection actions, a muted note, a divider, then Pause, Edit and Delete.
  Delete is still the only red control.
- The Paused pill gets attention without alarm, and Active stays plain.
  Paused, the state that surprises people, is now the visible one.
- Keyboard flow: recipe or Edit opens the editor with Name focused, and
  Cancel or Save returns focus to the originating Edit button.
- Both clients keep the trial copy aligned with the visible control.
- The results dialog fits at 390 px. Its controls are now the same size, and
  its title names the routine.

## Coverage limits

- The native capture ends at the trial note. Native editor, results, Pause,
  Edit and Delete were not seen.
- I did not review VoiceOver, dark mode, large text or a live routine run.
  All web data is synthetic.
- Issues 2 and 4 come from source only.
