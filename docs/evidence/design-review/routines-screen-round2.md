# Routines: whole-screen review, round 2

Reviewer: Claude Opus 5.5, Anthropic. Effort High was requested. The session
did not expose its configured effort as a named tier, so I can't confirm the
tier. OpenAI GPT-6.1 Sol implemented the work. Round 2 of at most 3.

Scope: commit `3b86a51`, product lines changed since `ea8483d` and their
callers. The score covers the Routines tab and its results dialog as one
screen. Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/routines-screen-r2/`.
Web coordinates are CSS pixels. Native coordinates are full-resolution pixels
in `native-Routines.png`, which is 1206x2622.

## Score: 8.6 / 10, not yet passing

Round 2 fixed every structural problem from round 1. The card now reads top
to bottom: a name, labeled schedule and status, the instructions, a trial and
inspection row, a muted trial note, a divider, then Pause, Edit and Delete.
Recipes and saved routines have headings. A recipe or Edit click scrolls the
form into view and focuses Name. The editor has one Preview schedule button.
The results dialog names the routine, puts Run before Refresh and gives Save
output room above the output. Native recipe descriptions and the trial note
are legible.

The remaining gap is mostly one cascade bug. The routine's instructions, the
content the user actually wrote, render as the smallest text on the card.
Fixing issue 1 and two small polish items should reach 9.

## Round 1 findings

| # | Round 1 issue | Status |
| --- | --- | --- |
| 1 | Trial warning beside View results, green | Fixed on both clients. Note is muted, names Try once and is linked with `aria-describedby` |
| 2 | Ungrouped card controls | Fixed. Two groups with a divider, 10 px gaps |
| 3 | Unlabeled schedule and status | Fixed with labels. Status has no visual weight, see issue 3 |
| 4 | Unheaded recipes, offscreen form | Fixed. Headings, scroll and Name focus seen in `routine-recipe-*.png` |
| 5 | Duplicate Preview schedule in editor | Fixed. `routine-editor-1440.png` y 587-631 shows one button. The key collision explanation is plausible and a test covers it |
| 6 | Results title, Refresh rank, Save crowding | Fixed. Minor size mismatch remains, see issue 5 |
| 7 | Native washed-out recipe text | Description fixed. Title is still accent green, see issue 7 |

## Remaining issues, most important first

1. **Observed: routine instructions render at 13 px, smaller than every label
   around them.**
   `routines-overview-1440.png` x 446-752, y 714-728: "Summarize overnight
   sensor alerts and the weather." measures about 13 px. The Schedule and
   Status rows above it are 14 px and the trial note below is 14 px.
   `routine-card-390.png` y 398-432 shows the same. The new rule
   `.routine-card > p { font-size: .9375rem }` at `src/components/experience.css:143`
   intends 15 px but loses. `main.tsx` imports `App` before `styles.css`, so
   `experience.css` loads first. `.routine-card p { font-size: 0.8125rem }` at
   `src/styles.css:1093` has the same specificity and wins by order. The
   instructions are the core content of a routine, and they now read as fine
   print.
   *Fix:* Raise specificity, for example `.routine-card > p.routine-prompt`,
   or retire the old `.routine-card p` size in `styles.css`. Keep
   `white-space: pre-wrap` and `overflow-wrap: anywhere` from the old rule.
   The same cascade leaves the preview's "Hermes timezone" line at 13 px,
   which is fine.

2. **Observed: the schedule preview footnote is still accent green.**
   `routine-preview-1440.png` x 463-783, y 864-878, and `routine-preview-390.png`
   y 690-725: "The assistant's Hermes profile controls this timezone." renders
   green and reads like a link. The cause is the round 1 rule
   `.routine-card small { color: var(--accent) }` at `src/styles.css:1098`.
   Status no longer uses `<small>`, so this rule now only affects the footnote.
   *Fix:* Delete the rule or scope it, and let the footnote use `--muted`.

3. **Observed: Active and Paused look the same.**
   Web `routines-overview-1440.png` y 682-697 shows "Active" as plain body
   text. Native `native-Routines.png` y about 1685 shows "Paused" in the same
   muted gray as the schedule value. Labels fixed the meaning. They did not
   fix scanning: with several routines, a paused one is not noticeable at a
   glance, and paused is the state most likely to surprise someone.
   *Fix:* Give Paused a distinct treatment on both clients, such as a muted
   pill or a pause icon next to the text, and keep Active quiet. Don't rely on
   color alone.

4. **Code-only: Cancel edit drops keyboard focus.**
   `src/BotSettings.tsx:871-887`. Edit now moves focus into the form, but
   Cancel edit sets `editing` to null, which unmounts the Cancel button while
   it has focus. Focus falls to the dialog or body, far from the card the user
   came from. Not captured.
   *Fix:* Remember the routine id on Edit and, on Cancel or a successful save,
   scroll that card into view and focus its Edit button.

5. **Observed: Refresh results and Save output use different sizes.**
   `routine-results-1440.png`: Refresh results at x 953-1075, y 443-487 uses
   14 px text, while Save output at x 365-482, y 507-550 uses 16 px. At 390 px,
   `routine-results-390.png` y 365-472, Refresh wraps to its own row and the two
   mismatched buttons stack. The cause is
   `.routine-results-toolbar > button { font-size: .875rem }` at
   `src/components/collaboration.css:77`. Save output looks tinted green in the
   390 capture, likely a focus or hover state from capture, not a defect.
   *Fix:* Use one button size in the dialog. On narrow widths, letting the
   select fill the row and Refresh sit below it is fine once sizes match.

6. **Low: trial note text doesn't match the controls in every state.**
   Code-only. `RoutineEnhancements.tsx:80` and `ExperienceViews.swift:633`
   always render "Try once runs this routine now...". When a receipt is
   pending, Try once is replaced by Check run status, so the note names a
   control that isn't there. Not captured.
   *Fix:* Show the note only when Try once or Retry the same request is
   visible.

7. **Low, native: recipe titles still render in the accent tint.**
   `native-Routines.png` y about 1150: "Morning brief" is green. The
   description below is now muted and readable, which was the real problem.
   The green title does work as a tap cue. However
   `BotSettingsView.swift:670` sets `.foregroundStyle(.primary)`, which the
   button tint overrides, so the code says one thing and the screen shows
   another.
   *Fix:* Either accept the tint and drop `.foregroundStyle(.primary)`, or
   apply `.buttonStyle(.plain)` and add a chevron. I would accept the tint.

8. **Low: the schedule field doesn't match the card's monospaced schedule.**
   `routine-editor-1440.png` y 527-569 shows "0 6 * * *" in the proportional
   UI font with tight spacing. The card at `routines-overview-1440.png`
   y 655-670 uses `--font-mono`. *Fix:* Set the Schedule input to
   `--font-mono`.

## Observations that are not defects

- `routine-preview-*.png` lists 6:00 AM, then 5:00 AM on Nov 1 and Nov 2 for
  `0 6 * * *` in America/Chicago. `runTime` in `RoutineEnhancements.tsx:8-11`
  formats in the Hermes timezone, so the shift comes from fixed synthetic UTC
  instants in the fixture, not the product. A real user would read this as a
  daylight saving bug, so keep it out of future screenshots.
- With the preview open, the trial note moves from about 20 px to about 230 px
  below Try once, `routine-preview-1440.png` y 643-955. The note names Try
  once and is linked by `aria-describedby`, so the meaning survives. Optional:
  render the preview panel after the note.
- `RoutineResults` now loads all routines to look up one name. That's fine
  for household-scale data. The title shows "Routine results" until the
  lookup returns, then changes. Not captured, and minor.
- Native order is Preview schedule, View results, Try once. Web order is
  Try once, Preview schedule, View results. Both read well. Matching them is
  optional.

## What works

- The card hierarchy now matches the actions' risk. Inspection and trial come
  first, management sits behind a divider, and Delete is still the only red
  control.
- The trial note is muted, explicit and programmatically tied to Try once.
- Recipe selection keeps the paused default, `routine-recipe-1440.png`
  y 688-705, and keeps the current user as the only recipient.
- Preview-before-save, the recipient explanation and the advanced fields are
  intact in the editor captures.
- The results dialog fits at 390 px. The output heading and body have clear
  space, and the routine name in the title answers "results of what?"

## Coverage limits

- Native editor, native results, Pause, Edit and Delete rows on native are
  outside `native-Routines.png`, which ends at the trial note.
- No VoiceOver, clipboard, dark mode, large text or live provider execution
  was reviewed. All web data is synthetic.
- Issues 4 and 6 come from source only.
