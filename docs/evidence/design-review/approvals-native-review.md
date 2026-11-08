# 13 Approvals disabled-label recheck

Reviewer: Claude Opus 5.5, high effort. The implementer was OpenAI (GPT-6.1 Sol), so this is a cross-provider review.
Scope: only the R1 correction from review 12 and its shared-style callers. I compared `reviews/12-approvals-input.patch`
with `reviews/13-approvals-input.patch`. Then I compared `13-approvals-input.patch` with the live `git diff HEAD`
against `1933cd6`. The app code matches, and only the ledger differs. I didn't re-review M1, M2, enabled M3, the native
opening math, the web or other screens.
Method: I read source, logs, result summaries and the current PNGs only. I ran no builds, tests, browser or
simulators, and I edited no source. My crops and grids are in `reviews/13-approval-collages/`.

## Verdict

| Surface | Review 12 | Now | Gate |
| --- | --- | --- | --- |
| Web desktop | 9 | **9**, reused | Passes |
| Web phone | 9 | **9**, reused | Passes |
| Native iPhone | 8.5 | **9** | Passes |
| Native iPad | 8.5 | **9** | Passes |

**R1 is closed. Root may proceed to "Failed and interrupted turns."** I found no blocker and no obvious remaining issue
on any of the four layouts within the Approvals scope.

## R1, closed

### Source

`ios/AgentInterface/RootView.swift:8-23` matches the direction from review 12. The `PrimitiveButtonStyle` returns a
private `AccentProminentButton` view. That view reads `@Environment(\.isEnabled)` and applies `Palette.onAccent` only
while the button is enabled. When disabled, it returns the bare `configuration.label`. It keeps the single native
`Button(role:action:)` with `.borderedProminent`. The patch-to-patch diff shows that only this hunk changed in app code.
The other differences are line offsets.

The callers set `.disabled` outside the style. Examples are `ConversationTurnView.swift:162` on the action layout,
`ConversationView.swift:857`, `HomeStates.swift:106` and `:161`, `DeviceNotifications.swift:63`,
`VaultViews.swift:475` and `CollaborationViews.swift:371`. That environment value reaches the style body, and the
captures confirm it on both devices. `rg accentProminent` still finds the same 14 call sites and nothing new.

### Proof I re-ran

I re-ran `reviews/12-tools/sample.py` on every region listed in both sample files. Each one reproduced the recorded value:

| State | iPhone | iPad |
| --- | --- | --- |
| Approved held, light | #C2C2C0 on #E9E8E4, 1.45 | same |
| Declined held, light, disabled Approve | #C2C2C0 on #E9E8E4, 1.45 | same |
| Approved held, dark | #65696A on #3E4442, 1.79 | same |
| Unsupported, light | #C2C2C0 on #E9E8E4, 1.45 | same |
| Questions disabled, dark (`questions-dark-bottom`) | #65696A on #3E4442, 1.79 | same, using the corrected ROI |
| Approve enabled, light | #FFFDF7 on #246F59, 5.91 | same |
| Approve enabled, dark | #1B211E on #8BD2B2, 9.32 | same |
| Send answers enabled, dark | #1B211E on #8BD2B2, 9.32 | same |

I added the declined-held state to the implementer's set. These values match the review 12 baseline system disabled
treatment exactly: 1.45 light and 1.79 dark. They also match the sibling bordered "Decline." The sampler reports the
most extreme pixel, so a region that missed the label could still return a plausible number. So I cropped the same
rows visually to rule that out:

- `13-approval-collages/ios-disabled-grid.png` and `ipad-disabled-grid.png` show the disabled prominent label with the
  same weight and gray as the disabled "Decline" beside it. That holds in light, dark, unsupported and disabled
  Questions. The light "Approved" pill no longer reads as an empty capsule. "Approval sent." and "Decline sent." stay
  at full muted contrast under the actions.
- `13-approval-collages/enabled-grid.png` shows enabled Approve unchanged: off-white on green in light, ink on mint in
  dark, on both devices. `ios-questions-dark-enabled` and `ipad-questions-dark-enabled` show the enabled Send answers
  in ink on mint.

### Run evidence

- iPhone: `.private/ios-test-20261026T143204Z-66530.txt` shows exit 0, 2 of 2 passed (`testApprovalsDesignReview`,
  `testQuestionsDesignReview`) on iPhone 17, iOS 27.0, with inputs `sha256:568ea7d8…3d47a12`.
- iPad: `.private/ios-test-20261026T143540Z-68274.txt` shows exit 0, 2 of 2 passed on iPad Pro 11-inch (M5) with the
  same fingerprint.
- Capture times fit those runs: iPhone 09:32:57 to 09:34:55 and iPad 09:36:07 to 09:38:07. The regenerated
  `annotated/approvals-ios-dark-contrast.png` is from 09:46.
- I didn't recompute the fingerprint myself. The logs and the ledger agree on it, and the patch matches the worktree.

### Annotation fix (review 12 polish 3), closed

In the after panel of `annotated/approvals-ios-dark-contrast.png`, marker 1 now sits in the left gutter. Its arrow ends
in the button padding just before the "A" and doesn't cover any of the label.

## Notes, nonblocking

1. The `if enabled { … } else { … }` produces conditional content, so the label's view identity changes when a button
   becomes disabled. Today's labels are text and a stateless spinner, so nothing visible is lost. The captures show no
   glitch. Leave it as is.
2. These items from review 12 are still open and still assigned to their own passes: the Connection busy spinner forced
   to `.tint(.white)` (`RootView.swift:297`) and the Home "Create an assistant" fake disabled state at `.opacity(0.4)`.
   R1 doesn't fix or worsen either. In Approvals, native "Approving…" is now system gray. That's legible for the short
   sending window, and it's still review 12 polish item 4.
3. Disabled labels are WCAG-exempt and now match the system and the sibling controls. The settled meaning comes from
   the full-contrast status line, which review 12 already accepted.
4. Limits are unchanged from review 12: no physical device, VoiceOver, hardware keyboard or live SSE. I made no new web
   observations. The web scores of 9 are reused because no web source changed after review 12.
