# Learning screen review, round 1

Scope: Assistant settings > Learning ("Skills & learning"), web and native iPhone. Excludes event triggers and the 14 accepted areas, including the settings shell and tab strip.

Reviewer: Claude Opus 5.5, high effort. Implementation provider: OpenAI.

## Score: 7.0 / 10

The structure is right. Policy, pending changes, and installed skills are separated, approve and reject are clearly differentiated, and a truncated diff blocks approval. The score is held down by a broken policy checkbox layout on web, a raw diff that is hard to read, and loose spacing that pushes installed skills below the fold. One policy safeguard also exists on native but not on web.

## Issues, in priority order

### 1. Web policy checkbox sits on its own line above its label

- **Where:** `learning-1440.png` checkbox at x427-447, y428-447, label at y467. `learning-390.png` checkbox at x31-51, y390-410, label at y429.
- **Cause:** the global `label { flex-direction: column; margin-bottom: 18px }` in `src/styles.css:140` overrides `.automation-check` (`src/components/automation.css:17`), which sets `display: flex` but no direction. The Work panel already patches this for its own scopes (`automation.css:44`, `:98`). Learning was missed.
- **Fix:** add `flex-direction: row; margin: 0; min-height: 44px;` to the base `.automation-check` rule, and `margin: 2px 0 0` to its input. This puts the box inline with its label, gives a 44px hit row on phone, and removes 18px of the gap in issue 4.

### 2. Web lets you turn off approval with no confirmation, unlike native

- **Where:** source only. `AutomationPanel.tsx:544` unchecking calls the policy PUT immediately. Native asks first, with "Allow changes without review" and "Hermes can save new skills, edits and deletions without asking for approval." (`AutomationLearningViews.swift:73-74`).
- **Why it matters:** this is the one setting on the screen that removes a safety check. One misclick on web silently lets the assistant rewrite its own skills.
- **Fix:** match native. When the user unchecks, show the existing confirm pattern (`.automation-confirm`) with the native wording and a danger "Allow changes without review" button. Re-enabling approval needs no confirm.

### 3. The diff is hard to read

- **Where:** `learning-review-1440.png` x427-1013, y775-875. `learning-review-390.png` x31-359, y398-498.
- **Observed:** about 11px text in the browser's default monospace, which is Courier on macOS: thin, serif, and low contrast at that size. `--- / +++ / @@` headers get the same weight as the content, and added lines are marked only by a leading `+`.
- **Fix:**
  - In `.automation-code`, set `font-family: ui-monospace, SFMono-Regular, Menlo, monospace` (already used at `styles.css:715`), `font-size: 0.8125rem`, and `line-height: 1.6`.
  - Render the diff per line. Tint `+` lines with `--accent-soft` and `-` lines with a danger tint, and dim `---`, `+++`, and `@@` lines with `--muted`.
  - Keep the `+` and `-` characters so the diff does not depend on color alone.

### 4. Loose, uneven vertical rhythm pushes installed skills off the first screen

- **Where:**
  - `learning-1440.png`: empty bands at y520-579, after the policy helper, and y765-819, after "Review change". "Read skill" is clipped at y963-984.
  - `learning-390.png`: bands at y500-562 and y745-800. The "Installed skills" heading is cut at y830.
- **Cause:** the 18px label margin (issue 1), the 22px section padding, and the 16px item padding with no bottom border on the last child all add up.
- **Fix:** once issue 1 is fixed, set the policy helper `p` to `margin: 4px 0 0 30px`, which aligns it under the label text. Also trim `.automation-section` to `padding: 18px 0` inside `.settings-content`. Aim for installed skills starting above y≈700 at 1440 width.

### 5. Pending change item lacks hierarchy and context

- **Where:** `learning-1440.png` y613-763. `learning-390.png` y596-745.
- **Observed:**
  - The bold item title "Check water before planning feed" (h4, y663) outweighs its section heading "Pending changes" (h3, y613).
  - The origin "background review" (y693) is raw lowercase metadata.
  - Nothing tells the user that this is the one actionable item on the screen.
- **Fix:**
  - Show a count in the heading, for example "Pending changes (1)".
  - Set the item h4 to `font-weight: 600; font-size: 1rem` so it reads below the h3.
  - Present the origin as "From background review" in sentence case.
  - Optionally move the Pending section above Skill write policy when `pending.length > 0`. Pending is the action item, and policy is set once.
- **Data limit:** `PendingSkill` carries no target skill name or create/edit/delete kind (`src/shared/automation.ts:15`). The diff header in this capture reads only `SKILL.md`, so the user cannot see which installed skill changes. If Hermes exposes the target, show "Edits ranch-maintenance" under the title. Do not invent it client-side.

### 6. "Review change" has no collapse and no expanded state

- **Where:** `learning-review-1440.png` button x427-567, y719-763, tinted after the click. Same on `learning-review-390.png` at y342-386.
- **Observed in source:** clicking again just refetches. There is no "Hide change" option and no `aria-expanded`. Reading an installed skill closes the diff as a side effect.
- **Fix:** make it a disclosure. While the diff is open, label it "Hide change" and set `aria-expanded` and `aria-controls` to the `pre`.

### 7. Native: minor

- **Where:** `learning-smoke.png`, displayed at 920x2000. Multiply by 1.31 for the original.
- **Observed:** native is clean. It uses an inset grouped list, a toggle with its helper inside the card, and clear empty states. It has no page heading or intro line. Below the tab picker, the first content is "Managed by Hermes" (y603), so nothing says what this screen is for. Web has "Inspect reusable instructions and review changes the assistant wants to save."
- **Fix:** add that sentence as a header or footer on the first section. This is low priority.

## Not issues

- Approve is primary green and Reject is danger outline. Both are 44px on phone and sit side by side at 390 without wrapping.
- Muted text `#697268` on `#faf8f2` measures about 4.7:1, which passes AA for body text.

## Coverage limits

- **Web:** this round covered one pending item and one installed skill, at 1440x1000 and 390x844, in the light theme only.
- **Not seen on web:** dark theme, truncated diff, read-skill content, error banner, non-admin policy note, after-decision state, unsupported Hermes, and long names or diffs.
- **Native:** the only image is an older capture with empty pending and installed sections. Populated rows, the review sheet, the diff section, and the policy confirm were not seen. Native findings beyond item 7 come from source and are not visual verdicts.
- Issue 2 comes from source. The other web issues were visible in the screenshots and confirmed in source.
