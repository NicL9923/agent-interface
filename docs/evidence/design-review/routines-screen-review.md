# Routines: whole-screen review, round 1

Reviewer: Claude Opus 5.5, High, Anthropic. OpenAI implemented the work.
Round 1 of at most 3. This review gives one score for the Routines screen and
its results dialog together. It does not grade each capture.

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/routines-screen-r1/`.
Web coordinates are CSS pixels. Native coordinates are full-resolution pixels
in `native-Routines.png`, which is 1206x2622.

## Score: 7.2 / 10, not yet passing

The screen covers everything it needs to. The intro states the recipient rule,
recipes give a quick start, each routine shows its schedule, status and
instructions, and the card offers preview, results, a one-time trial run, pause,
edit and delete. Delete is the only red control. The results dialog fits at
390 px and the output reads well. The score is held down by layout, not missing
features. The trial-run warning sits next to the wrong control. The card's seven
controls have no grouping. Recipes look like saved routines. The results dialog
puts Save output on top of the output title.

## Issues, most important first

1. **The trial-run warning attaches to View results, not Try once.**
   Visible: `routines-overview-1440.png` x 446-955, y 705-770. "Runs now.
   Hermes may move the next run..." starts inline to the right of the View
   results button and wraps under it. Try once comes 30 px lower, at y 790-833.
   `routine-card-390.png` y 467-578 shows the same, and the text is the same
   green as "Active". Native `native-Routines.png` y 2270-2365 puts the caption
   right under the View results row, above Try once. Source:
   `RoutineEnhancements.tsx:72-73` renders the `<small>` straight after the View
   results button, so it flows inline. The `.routine-card small` rule at
   `styles.css:1098` makes it accent green, which overrides `.muted`. Native
   `ExperienceViews.swift:626-627` uses the same order. On a screen where
   trial-run safety matters, the warning reads as a description of View results
   or as a status line.
   *Fix:* Render the hint directly below Try once, or as its description, in
   both clients, and keep the existing wording. On web, make it block-level and
   muted. Scope the green to the status element only, for example
   `.routine-card .routine-status`.

2. **The card's controls have no grouping or rhythm.**
   Visible: `routines-overview-1440.png` x 446-676, y 661-896. Preview schedule
   and View results almost touch, with about 0-2 px between them at y 704-706.
   Try once sits 30 px lower, and Pause, Edit and Delete 20 px below that.
   Every control has the same weight. `routine-card-390.png` y 425-704 repeats
   the stack on phone.
   *Fix:* Keep every control and arrange them in two rows. Row one holds Try
   once with its hint, plus Preview schedule and View results. Row two holds
   Pause, Edit and Delete. Use one gap value, such as the 10 px `.actions` gap.
   The schedule preview and run status keep their places below row one.

3. **The schedule and status lack labels, so the card has weak hierarchy.**
   Visible: `routines-overview-1440.png` y 575-640 shows a bare `0 6 * * *`,
   then a small green "Active", then the instructions, all left-aligned with no
   labels. Native y 1500-1700 shows `0 7 * * *` and a small gray "Paused"
   caption as separate rows, also unlabeled. Source: `BotSettings.tsx:715-717`
   and `BotSettingsView.swift:679-681`. Readers who don't know cron syntax get
   no meaning from the bare expression, and Active vs Paused is the most
   important fact about a routine.
   *Fix:* Show status as a badge beside the routine name, with text plus color.
   Label the schedule row "Schedule". Preview schedule keeps its role of showing
   the actual next runs, and the stored expression stays unchanged.

4. **On web, recipes look like saved routines and fill a form far below.**
   Visible: `routines-overview-1440.png` y 271-492. Three recipe cards with no
   heading sit above the user's routine. The bordered "Morning brief" recipe
   looks much like the "Morning check" routine card at y 514. Native has a
   "Routine recipes" header at y 1015. Source: `BotSettings.tsx:709-711`. A
   recipe click calls `setForm` to fill the New routine form, which starts at
   y 960 at 1440 px and is off screen at 390 px. I did not capture what happens
   after a click.
   *Fix:* Add a "Start from a recipe" heading on web to match native, and a
   "Your routines" heading above the saved cards. Either move the recipes next
   to the New routine form, or scroll the form into view and focus its Name
   field after a recipe click.

5. **The edit form shows two stacked Preview schedule buttons.**
   Visible: `routine-editor-1440.png` x 427-583. A disabled "Preview schedule"
   sits at y 905-947 and an enabled one at y 949-990. Source shows one
   `RoutineSchedulePreview` in the form, at `BotSettings.tsx:818`, and
   `AdvancedRoutineFields.tsx` has no preview button, so I could not trace the
   duplicate. Separately, Edit sends the user to a form below the card, at
   y 550, and the card shows no sign that it is being edited.
   *Fix:* Find and remove the extra button so the form has one Preview
   schedule control next to the Schedule field. When Edit is pressed, scroll
   the form into view.

6. **In the results dialog, Save output collides with the output, and the
   dialog doesn't name the routine.**
   Visible: `routine-results-1440.png` y 540-607. The Save output button ends
   at about y 583, and the "Morning gate check" heading starts about 4 px
   below it. `routine-results-390.png` y 433-500 shows the same. A full-size
   Refresh results button at y 389-432 sits between the description and the Run
   picker, so it outranks the picker. The dialog title is a generic "Routine
   results". Source: `RoutineResults.tsx:30-41`.
   *Fix:* Put Save output in an output header row, right-aligned, above the
   rendered markdown with at least 16 px of space. Move Refresh beside the Run
   label as a smaller secondary button. Title the dialog with the routine name,
   for example "Morning check results", if the caller passes the name.

7. **Native recipe text is washed out.**
   Visible: `native-Routines.png` y 1130-1230. The recipe title renders in the
   button's green tint, and the description "Fixture morning brief from
   connected sources." is pale green on white. By eye the description falls
   below body-text contrast; I did not measure it. Source:
   `BotSettingsView.swift:668-672` sets `.primary` and `.secondary` inside a
   tinted `Button`, and the tint wins.
   *Fix:* Apply `.buttonStyle(.plain)` or `.tint(.primary)` to the recipe rows
   so the title is primary text and the description is standard secondary
   text. Keep a chevron or a "Use" affordance so each row still reads as
   tappable.

## Next round: highest-value fixes

Issues 1 to 3 would move the screen most. Issues 4 to 6 are smaller layout and
spacing fixes. If round 2 fixes 1, 2, 3 and 6 and removes the duplicate button,
I would expect a passing score. Issue 7 is a small native change.

## What works

- The explicit-recipient rule appears in the intro and next to the form's
  recipient list in source, `BotSettings.tsx:851-852`.
- Delete is the only red control, and source requires a confirm step.
- The results dialog fits at 390 px with no clipping, and the output markdown
  is readable at both widths.
- Native follows iOS Form conventions, with each control as a full-width row.

## Coverage limits

- Native editor and native results were not captured. Issues 5 and 6 are
  web-only observations. Native notes for those views come from source.
- The highlighted "Weekly meal plan" recipe in `routines-overview-390.png`,
  y 310-375, looks like a pointer or focus state from capture. I did not treat
  it as a defect.
- The overflowing tab row at 390 px belongs to the settings shell, which
  already passed, and is outside this review.
- No live service, VoiceOver, large text or post-click states were reviewed.
