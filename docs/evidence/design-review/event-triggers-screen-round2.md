# Work event triggers: whole-screen review, round 2

Reviewer: Claude Opus 5.5, High, Anthropic. The implementation is OpenAI work
by Sol and Terra. Round 2 of at most 3. This is one score for the whole screen,
reviewed at head `05dca6a`. It rechecks the round 1 findings in
`event-triggers-screen-review.md` (7.6) and the code that changed for them. Areas
that round 1 settled are not reviewed again. The six accepted native large-text
frames remain accepted.

## Score: 9.1 / 10, passing

Round 1 found five issues that mattered. All five are fixed in the frames I
inspected. A retired-routine trigger now explains why Edit is locked and how to
unlock it. Native shows both field labels in the secret panel. On iPhone and
iPad, the secret panel now opens at the top of the Work sheet with its heading
and every action visible. The web list metadata is grouped, and the web secret
heading is now the largest text in the panel. The remaining issues are small
consistency problems. None of them block a user or put the secret at risk.

## Evidence

All files are in `/Volumes/DevSSD/scratch/wildbots-design-review/event-trigger-screen-r2`.
Web coordinates are CSS pixels. Native coordinates are full-resolution image
pixels.

- Web, 1440 and 390 wide: `after-work-trigger-list`, `-create`, `-orphan-edit`
  and `-secret`. The web trigger code has not changed since commit `35c8198`.
  Later edits to `AutomationPanel.tsx` and `automation.css` touch only Learning,
  so I reused these frames.
- Native: `iphone/native-TriggerSecret.png` (1206x2622) and
  `ipad/native-TriggerSecret.png` (1668x2420). A Debug-only synthetic fixture
  creates the trigger through the normal create control and closes the editor
  the normal way. The fixture routine, ID and URL are synthetic, so I did not
  grade them as parity issues.

## Round 1 findings

1. **Web: the hint said to edit the trigger, but Edit was disabled.** Fixed.
   `after-work-trigger-orphan-edit-1440.png`, x 427-990, y 500-525, now reads
   "Finish or cancel the new trigger, then edit this trigger to choose another
   routine." The 390 frame shows the same text at y 615-660. The create form
   says the same thing from the other side, "Finish or cancel this new trigger
   before editing another." See `after-work-trigger-create-1440.png` at y 823.
   Source: `src/components/AutomationPanel.tsx:504` and `:519`.

2. **Native: the webhook URL and signing secret had no visible labels.** Fixed.
   The iPhone frame shows "Webhook URL" at y about 1150 and "Signing secret" at
   y about 1555. The iPad frame shows them at y about 1147 and 1389. Both labels
   are muted subheadline text above their values. Source:
   `ios/AgentInterface/AutomationTriggerViews.swift:107-119`.

3. **iPad: the one-time secret panel opened below Task board.** Fixed. In
   `ipad/native-TriggerSecret.png`, the panel starts right under the tab row at
   y about 820. "Save this signing secret now" is at y about 869. The disabled
   "I've saved it" and "Copy or show the secret first." end at y about 1800,
   inside the sheet, which ends at y about 1870. The iPhone frame shows the same
   order. The heading is at y about 683, the panel ends at y about 2234, and
   "Event triggers" follows below it. The fix moved the heading into the first
   row, which is also the scroll target, at `AutomationTriggerViews.swift:102-105`.
   That avoids the case where a Form section header scrolls out of view.
   `AutomationViews.swift:476` scrolls to that row when the editor closes.

4. **Web list: uneven metadata rhythm, and labels that looked like values.**
   Fixed. `after-work-trigger-list-1440.png`, y 329-545: the badge, Events and
   Routine now have even 8 px gaps. "Webhook URL" at y 458 is 14 px muted text
   directly above the URL. The 390 frame matches at y 340-495. Source:
   `src/components/automation.css:117-119`.

5. **Web secret panel: the heading was smaller than its body.** Fixed.
   `after-work-trigger-secret-1440.png` at y 434 and `-390.png` at y 199 show the
   heading at about 18 px bold, above 16-17 px body text. Source:
   `automation.css:120`.

6. **Native: create-form labels and values share one style.** Still open. Low
   priority. This is source-only, because no new create-form frames exist.
   `Text("Trigger ID")` at `AutomationTriggerViews.swift:281` and
   `Text("Event names")` at `:292` still have no font or color, so they render
   like the entered value.

7. **Web and native copy drift in field hints.** Partly fixed. Low priority.
   This is source-only on the native side. The web placeholder is now dotted,
   `alert.created`. Native still says "1 to 80 ... digits" and uses the example
   `issue.created, issue.closed` at `AutomationTriggerViews.swift:284` and
   `:293-295`. Web says "letters, numbers ... up to 80" and "Up to 20". Both are
   correct. The wording still differs between platforms.

8. **Shared shell: scrolled content shows above the tab divider.** Still
   present, and it does not count against this screen. See
   `after-work-trigger-secret-1440.png`, x 427-575, y 200-212. Part of
   "Events: freezer.door" shows above the divider. The settings shell owns this.

## New issue

9. **Web secret panel: its field labels use body style, unlike the list and
   native.** Low priority. `after-work-trigger-secret-1440.png`: "Webhook URL"
   at x 444-548, y 569 and "Signing secret" at y 678 are 17 px ink text, the same
   size as the instructions above them. The list labels the same field with
   14 px muted text at y 458. Native uses muted subheadline. The "Hidden"
   placeholder at y 708 is 14 px muted, smaller than its label. The 390 frame
   shows the same pattern at y 409, 534 and 564. Source: the labels are plain
   `<p>` elements inside `.automation-secret-field` at
   `AutomationPanel.tsx:525`, and `automation.css:112-113` does not set their
   size or color.
   *Fix:* Give both labels the `automation-trigger-label` style, or add a matching
   rule for `.automation-secret-field > p:first-child`. With the labels muted, the
   heading and the two actions stand out more.

## Not issues

- On iPhone, the URL breaks inside a word, "fixture-eve / nt", at y about
  1218-1262. Web does the same. For a copyable URL, breaking at any character is
  better than inserting a hyphen that could end up in a copied value.
- The disabled "I've saved it" has low contrast on both platforms. WCAG exempts
  disabled controls, and the explanation directly below it says what to do.
- Web shows the explanation above the disabled button, and native shows it
  below. Both keep the explanation next to the button, so either order works.
- Web says "Leaving Work or reloading the page clears it from this screen."
  Native says "Closing Work or leaving the app clears this display." This
  wording matches each platform's real lifetime. It is not copy drift.

## Behavior I checked in the changed code

The round 1 fixes changed only layout and copy. `control.secret.reveal`,
`markCopied`, `clear`, the `.disabled(!control.secret.inspected)` guard,
`.privacySensitive()` and the arrival announcement are unchanged at
`AutomationTriggerViews.swift:120-135`. The scroll happens only when
`control.secret.value != nil` at `AutomationViews.swift:476`. On web, the
`seen` guard, reveal toggle, clipboard feature check and `publish` outcome
copy are unchanged at `AutomationPanel.tsx:525`. The `creating` lock on Edit
is unchanged. Only the hint text depends on it now.

## Coverage limits

These were not observed and are not scored: native gestures, the revealed
secret on current native builds, copy feedback and the system clipboard,
VoiceOver, current native large text, the end of the iPhone large-text hint and
footer, the end of the iPad large-text form, and native create-form pixels after
round 1. The native frames show only the hidden-secret state after the
synthetic create and editor dismissal.

## Before round 3

Round 3 is optional. If it runs, fix issue 9. That is a one-line CSS change. It
can reuse the web secret frames after recapturing only the secret state. Issues
6 and 7 are optional polish. They would need fresh native create-form frames to
score as seen.
