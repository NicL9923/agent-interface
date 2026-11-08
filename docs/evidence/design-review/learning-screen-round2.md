# Learning screen review, round 2

Scope: changes since round 1 in commit `4b47acf`. That means `LearningPanel` and `SkillDiffPreview` in `src/components/AutomationPanel.tsx`, the Learning rules in `src/components/automation.css`, and the native intro, count and muted-color edits in `ios/AgentInterface/AutomationLearningViews.swift`. Screens accepted earlier, including the settings shell and tab strip, were not reviewed again.

Reviewer: Claude Opus 5.5, configured high effort. Implementation provider: OpenAI.

Evidence: the six web captures and two before/after pairs in `/Volumes/DevSSD/scratch/wildbots-design-review/learning-screen-r2/`, plus source.

## Score: 8.5 / 10, up from 7.0

The web screen now reads cleanly. The policy control sits on one row with its label. Turning approval off asks first, with the safe choice first. The diff is legible and collapses. Installed skills appear on the first screen at both widths. What remains is a stale status line and three small polish items. None blocks the PR.

## Round 1 findings

| # | Finding | Status | Basis |
| --- | --- | --- | --- |
| 1 | Policy checkbox above its label | Closed | `learning-1440.png` y437-458 and `learning-390.png` y394-438 show the box inline. The helper is indented under the label text. |
| 2 | Approval turned off with no confirmation | Closed | `learning-policy-confirm-1440.png` and `-390.png` show the dialog with native wording, "Keep approval required" first, and the box still checked behind it. Focus restoration and immediate re-enabling come from source and the implementer's run, not pixels. |
| 3 | Tiny, untinted diff | Closed | `learning-review-1440.png` y735-865 shows SF Mono at about 13px, muted `---/+++/@@` lines, and a green tint on the `+` line with the `+` kept. No removed line appears in the fixture, so the red style comes from source only. Tint contrast is about 4.8:1 in light theme. |
| 4 | Excess vertical spacing | Closed | At 1440 the "Installed skills" heading is at y775 and "Read skill" is fully visible at y876-918. At 390 the heading is visible at y771. |
| 5 | Pending title too strong, no count, raw origin | Closed on web | "Pending changes (1)" now outranks the 16px/600 item title. The source reads "Source: Background review". Native still shows the raw origin, see issue 4 below. |
| 6 | No collapse or `aria-expanded` | Closed | "Hide change" shows tinted in both review captures. `aria-expanded` and `aria-controls` point at the `pre` in source. |
| 7 | No native intro | Implemented, not visually verified | The source adds the intro line. No new native screenshot exists. |

## Remaining issues, in priority order

### 1. A stale "Saved in Hermes." sits above a change that is not saved

- **Where:** `learning-review-1440.png`, x427-554, y356-375, between "Managed by Hermes" and the policy divider.
- **Observed:** the capture re-enabled the policy before opening the review, and the shared `Status` notice from that save (`AutomationPanel.tsx:51`, `:101`) stays on screen while the user reads an unapproved diff. It is plain 16px text, larger than the muted "Managed by Hermes" line above it. It says nothing about what was saved and pushes the page down about 20px. The same generic text appears after "Reject change", where "saved" is misleading.
- **Fix:** keep it scoped to Learning.
  - Clear `control.notice` when a review or skill read opens.
  - Give `control.change` an optional success message. Use "Approval required for skill changes.", "Changes can be saved without review.", "Change approved." and "Change rejected."
  - Render the notice with `form-notice`, the way Work already does.

### 2. The diff tint covers only the text, not the line

- **Where:** `learning-review-1440.png` x440-706, y834-849. `learning-review-390.png` x44-310, y481-496.
- **Observed:** `.automation-diff-*` spans are inline, so the green reads like a text highlighter that stops at the last character. Long or wrapped lines will look ragged.
- **Fix:** add `display: block` to `.automation-diff-added` and `.automation-diff-removed`. Optionally add `margin: 0 -12px; padding: 0 12px` so the tint runs to the box edge. Check that the trailing `\n` in each span does not add a blank line. If it does, drop the newline for block spans.

### 3. Confirm buttons wrap to two lines at both widths

- **Where:** `learning-policy-confirm-1440.png` x543-897, y510-576. `learning-policy-confirm-390.png` x42-348, y432-498.
- **Observed:** "Keep approval required" and "Allow changes without review" each wrap inside a 9rem flex basis. The red outline button reads correctly, but four short lines look cramped, especially on a 1440 desktop.
- **Fix:** keep the native wording. Pass a Learning-only class to `SettingsConfirmation` that stacks the actions at full width, with `flex-basis: 100%`, so each label fits on one line. Keep the safe choice first. Do not change the shared dialog for other screens.

### 4. Native pending rows still show the raw origin (source only)

- **Where:** `AutomationLearningViews.swift:99`, `Text(item.origin)`.
- **Observed:** web now shows "Source: Background review". Native shows "background review" in lowercase with no label. Populated native rows have never been captured, so this comes from source.
- **Fix:** mirror web. Use `Text("Source: \(item.origin.isEmpty ? "Not reported" : item.origin.prefix(1).uppercased() + item.origin.dropFirst())")`.

### Nit

`learning-review-390.png` leaves about 60px between Approve/Reject (bottom y568) and the next divider (y629). That gap is the action margin, item padding and section padding added together. Trim the bottom margin of `.actions` inside `.automation-learning .automation-item` if it bothers you. It is cosmetic.

## Not issues

- The tinted "Learning" tab in `learning-1440.png` (x662-778, y168-216) is a hover or focus state from the capture. It belongs to the accepted tab strip.
- "Pending changes (0)" next to the empty-state sentence is a little redundant but clear. Leave it.
- No visible focus ring on "Keep approval required" is expected. The dialog opened from a pointer click, so `:focus-visible` does not apply.

## Not visually verified

- **Native, new in this round:** the intro line, "Pending changes (N)" in the section header, and the `Palette.muted` color change. No screenshot shows them, because CoreSimulator needs an admin update on the host. The older `learning-smoke.png` still covers the unchanged native structure and empty lists only.
- **Native intro placement:** the intro is a bare `Text` directly inside `Form` with a clear row background. In an inset grouped form that can render as its own padded row with odd spacing above "Managed by Hermes". Check it in the first native capture. If it looks loose, move it into the first section's `header:`.
- **Native, still open from round 1:** populated pending and installed rows, the review sheet and diff, the policy confirmation, live clipboard behavior, and VoiceOver.
- **Web:** dark theme, a removed diff line, a truncated diff, long diffs, error and non-admin states, and post-decision states were not captured. These are coverage limits, not defects.
