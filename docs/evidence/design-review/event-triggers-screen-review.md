# Work event triggers: whole-screen review, round 1

Reviewer: Claude Opus 5.5, High, Anthropic. The implementation is OpenAI work.
Round 1 of at most 3. This is one score for the screen as a whole. It does not
grade individual frames. The six accepted native W3 large-text frames remain
accepted.

## Score: 7.6 / 10, not yet passing

The screen does its job. The list explains what triggers do, the create form
gives clear field rules, the secret panel says it shows the secret only once,
and the retired-routine state explains itself. It matches the settings design
language on both platforms. Three problems hold the score down: a blocked
remediation path on web, unlabeled secret values on native, and an iPad secret
panel that opens below the fold.

## Issues, most important first

Web coordinates are CSS pixels. Native coordinates are full-resolution image
pixels.

1. **Web: the hint says to edit the trigger, but Edit is disabled.**
   `after-work-trigger-create-1440.png`, region x 427-842, y 305-405. The
   `barn-door-sensor` trigger shows a disabled "Edit trigger" at x 572-683. The
   text below it says "Edit the trigger to choose another routine before
   enabling it." The same state appears in `after-work-trigger-create-390.png`
   at y 150-305. These screenshots do not show why Edit is disabled. It may be
   locked while the new-trigger form is open. As shown, the user cannot follow
   the instruction.
   *Fix:* Keep Edit enabled for a trigger whose routine was removed. If editing
   is intentionally locked while the create form is open, say so in place, for
   example "Finish or cancel the new trigger to edit this one."

2. **Native: the webhook URL and signing secret have no visible labels.**
   `ipad/trigger-secret-landing.png`: the URL row at about y 1530 and the
   "Hidden" row at about y 1740 have no field labels. `ipad/trigger-secret-revealed.png`
   shows the secret row at about y 1395. `ios/trigger-secret-large-text.png`,
   y 760-1300, shows a large monospace block under "Copy URL" without a label.
   `ipad` large text `trigger-secret-large-text.png` shows the same pattern for
   both values. Web labels both fields "Webhook URL" and "Signing secret". On
   native, "Hidden" alone does not say what is hidden. At large text, a user who
   scrolls into the panel sees an unlabeled value.
   *Fix:* Add a visible label to each value row, such as a secondary-style
   "Webhook URL" or "Signing secret" caption, or use `LabeledContent` with a
   stacked layout at accessibility sizes.

3. **iPad: the one-time secret panel opens below the Task board.**
   `ipad/trigger-secret-landing.png`: the sheet spans about y 550-1870 of 2420.
   Task board fills its top third. The secret section header is at about
   y 1210, and "Show secret" is cut off at the bottom edge. "Copy secret" and
   "I've saved it" are below the fold. `trigger-secret-revealed.png` shows
   that the full panel fits once scrolled. On web, the panel is the first thing
   below the tabs.
   *Fix:* Scroll the secret section to the top when it appears, for example
   with `ScrollViewReader.scrollTo(id, anchor: .top)`. Leave the sheet size,
   which belongs to the shared settings shell, unchanged.

4. **Web list: the trigger metadata has an uneven rhythm, and labels look like
   values.** `after-work-trigger-list-1440.png`, x 427-940, y 628-820. The
   "Enabled" badge sits about 4 px above "Events:", but Events, Routine and
   "Webhook URL" are about 41 px apart. "Webhook URL" uses the same 17 px
   regular body style as the data around it, so it reads as data rather than as
   a label. The same pattern appears in `after-work-trigger-list-390.png` at
   y 545-780.
   *Fix:* Give the badge 8 px of space. Group Events, Routine and URL with
   4-8 px gaps. Render "Events", "Routine" and "Webhook URL" in the 13-14 px
   secondary label style used by the create form.

5. **Web secret panel: the heading is smaller than its body text.**
   `web-work-trigger-secret-phone.png`: the heading "Save this signing secret now"
   at y 194 is about 15 px bold. The body lines below it at y 238-390 are about
   17 px. The most important instruction has the smallest text in the panel.
   *Fix:* Match the trigger title style, about 17 px semibold, or make the body
   text 15 px.

6. **Native: field labels and entered values use the same style.**
   `ipad/trigger-create-filled.png`, y 445-500 and 705-760: "Trigger ID" and
   "freezer-door" use the same size, weight and color, as do the Description
   label and its value. At large text, the same issue appears in
   `ios/trigger-create-large-text-top.png` at y 580-760 and in iPad
   `trigger-create-large-text-top.png` at y 528-640. It is hard to tell
   which line is editable. Low severity. The frames remain accepted.
   *Fix:* Show labels in the secondary or subheadline style, and keep values in
   the primary style.

7. **Web/native copy drift in field hints.** Low. Web uses "letters, numbers"
   and "Up to 20", with the placeholder "alert, recovery". Native uses "1 to 80
   ... digits" and the example "issue.created, issue.closed". The existing
   triggers use dotted names such as `freezer.alert`. The web placeholder
   suggests undotted names.
   *Fix:* Use the same rule wording on both platforms. Use a dotted example
   such as `freezer.alert, freezer.recovered` that matches the list.

8. **Shared shell seam: scrolled content shows above the tab divider.** Low and
   outside this screen. `after-work-trigger-create-1440.png`, x 427-690,
   y 200-210: the bottom of "Routine: routine-retired · Not found" shows above
   the header divider and behind the active Work underline. The settings shell
   owns this. Note it there. It does not count against this screen.

## Not issues

- The Details · Avatar · Work › tab strip and its gap on phone are the
  deliberate shared navigation pattern. It matches the iPad native version.
- Neither viewport shows Create or Cancel on the web create form. These are
  scrolling forms, so this is expected framing.
- Native keyboards cover the lower form. This is standard iOS behavior.
- The extra space before "I've saved it" on web separates dismissal from the
  copy actions, which is a good choice.

## Coverage limits

These areas are not observed and are not judged: the phone large-text middle and
the hint and footer under the keyboard, the end of the iPad form, the web Create
and Cancel footer, web copy confirmation, VoiceOver, and system clipboard
behavior. New native captures are blocked by a CoreSimulator version mismatch on
the host. That is not a product defect.

## To pass round 2

Fix issues 1-3. Issues 4-5 are short CSS changes that would likely raise the
score past 9. Issues 6-7 are optional polish. Round 2 needs new frames only for
the changed regions: the web retired-trigger state, the native secret panel, and
the iPad landing position.
