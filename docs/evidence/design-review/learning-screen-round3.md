# Learning screen review, round 3 (final)

Scope: changes since round 2. That means `LearningPanel`, `SkillDiffPreview`, `Status` and `useAutomation.change` in `src/components/AutomationPanel.tsx`, the optional `className` in `src/components/SettingsConfirmation.tsx`, the new Learning rules in `src/components/automation.css`, `hermesSkillSource` in `ios/AgentInterface/AutomationLearningViews.swift`, and the optional `introduction` header in `HermesAutomationStatus` in `ios/AgentInterface/AutomationViews.swift`. DEBUG hooks and capture tooling were excluded. Accepted screens and event triggers were excluded.

Reviewer: Claude Opus 5.5, configured high effort. Implementation provider: OpenAI.

Evidence: the seven web captures, `native-Learning.png` and `confirmation-before-after.png` in `/Volumes/DevSSD/scratch/wildbots-design-review/learning-screen-r3/`, plus source.

## Score: 9.0 / 10, up from 8.5

Learning now works as one product screen on web and native. The page is calm and ordered: purpose, status, policy, pending work, then installed skills. Feedback names the action that just happened and no longer lingers over unrelated content. The diff reads like a diff. The one risky choice, turning off approval, asks first and makes the safe answer the easy one. The native screen matches the web structure in platform idiom. The remaining items are small polish and do not block the PR.

## Round 2 findings

| # | Finding | Status | Basis |
| --- | --- | --- | --- |
| 1 | Stale "Saved in Hermes." over an unsaved change | Closed | `learning-review-1440.png` and `learning-review-390.png` show no notice between "Managed by Hermes" and the policy divider. `read()` calls `clearNotice()` before loading. `learning-rejected-390.png` y224-271 shows "Rejected the skill change." in the shared `form-notice` style. Policy, approve and reject each pass a specific message. Other `change()` callers keep the old default. Only Work and Learning render `Status`, and Work already used `form-notice`, so the class change affects nothing else. |
| 2 | Diff tint covered only the text | Closed | `learning-review-1440.png` x440-1000, y803-844 shows the red and green tints running the full box width. Both colors are now visible. Blank lines keep their height through `min-height: 1.6em`. |
| 3 | Confirm buttons wrapped to two lines | Closed | `learning-policy-confirm-1440.png` x543-897, y494-592 and `-390.png` x42-348, y416-514 show two full-width, single-line actions with "Keep approval required" first. `confirmation-before-after.png` shows the change. The class is scoped to this dialog, and other `SettingsConfirmation` callers keep their layout. |
| 4 | Native rows showed the raw origin | Closed | `native-Learning.png` shows "Source: Agent" under the pending title, at about x95-330, y1975-2010 in the full-size image. The review sheet uses the same helper, which comes from source. |
| R2 note | Native intro might render as a loose Form row | Closed | `native-Learning.png` y640-730 shows the intro as the first section's header, muted, sentence case and sitting right on top of the status card. |
| R2 nit | 60px gap below Approve/Reject at 390 | Not re-measured | `learning-review-390.png` ends at the action row. Cosmetic, and it stays a nit. |

## Remaining issues, in priority order

### 1. Diffs end with an empty tinted-box row

- **Where:** `learning-review-1440.png` x428-1012, y845-877. `learning-review-390.png` x32-358, y706-740.
- **Observed:** the box has about 21px of padding above the first line and about 43px below the last. The extra space is one empty line. Unified diffs from git end with `\n`, so `split("\n")` yields a final empty string, and the new `min-height: 1.6em` now gives it a full row. Nearly every real diff will show this blank line.
- **Fix:** in `SkillDiffPreview`, drop one trailing newline before splitting, for example `(text || "No textual diff.").replace(/\n$/, "").split("\n")`.

### 2. Native policy helper reads as a separate row

- **Where:** `native-Learning.png`, full-size y1310-1670. A list separator at about y1480 divides the toggle from "When enabled, Hermes stages…".
- **Observed:** the separator makes the explanation look like its own setting. iOS Settings usually puts this kind of explanation in the section footer, below the card. Web indents it under the label, which reads as one unit.
- **Fix:** move the helper text into the policy `Section`'s `footer:`. Keep the admin-only note there too if it shows.

### Not issues

- The tinted "Learning" tab in `learning-1440.png` is a hover state on the accepted tab strip.
- Native has no "Skills & learning" heading. The selected "Learning" tab and the intro header do that job, which is normal for an iOS settings sheet.
- The green text on "Rejected the skill change." is correct. The rejection succeeded, and the wording says what happened.

## Coverage

- **Seen in pixels:** web default, review, policy confirmation and post-reject states at 1440 and 390. Native Learning list with populated pending and installed sections, the intro header, the count and "Source: Agent".
- **Not seen:** the native review sheet and diff, the native policy confirmation, clipboard behavior, VoiceOver, web dark theme, truncated and long diffs, and error and non-admin states. These come from source or the implementer's run only. They are coverage limits, not defects.
- Web and native use different synthetic content. Layouts were compared, not strings.
