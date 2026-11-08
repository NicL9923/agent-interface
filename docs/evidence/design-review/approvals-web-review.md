# 12 Approvals recheck

Reviewer: Claude Opus 5.5, high effort. The implementer was OpenAI (GPT-6.1 Sol), so this is a cross-provider review.
Scope: the M1, M2 and M3 corrections from review 11, the new shared native prominent style, and its callers and
callees. I compared `reviews/12-approvals-input.patch` with the live `git diff 1933cd6`. They match except for docs and
ledger files. I didn't re-review the accepted native opening geometry or the settled Today, Home, Conversation and
Questions work.
Method: I read source, screenshots, reports and logs only. I ran no builds, tests, browser or simulators and edited no
source. My collages, crops and the small Pillow helpers I used to make them are in `reviews/12-approval-collages/`
and `reviews/12-tools/`.

## Verdict

| Surface | Review 11 | Now | Gate |
| --- | --- | --- | --- |
| Web desktop | 8.5 | **9** | Passes |
| Web phone | 8.5 | **9** | Passes |
| Native iPhone | 8 | **8.5** | Blocked by R1, a regression from the M3 style |
| Native iPad | 8 | **8.5** | Blocked by R1 |

**Root should not move to "Failed and interrupted turns" yet.** M1 and M2 are closed on the web. M3 is closed for
enabled buttons, but the new shared style broke disabled prominent buttons across the native app. The fix is about
five lines in one file. Then the native held, unsupported and disabled Questions states need recapturing. Once that
evidence shows the system disabled label again, I expect 9 on iPhone and iPad, and root can move on. The web doesn't
need a rerun.

## Must fix

### R1. Native: `AccentProminentButtonStyle` makes disabled labels nearly invisible

Source: `ios/AgentInterface/RootView.swift:9-14` always applies `configuration.label.foregroundStyle(Palette.onAccent)`.
A disabled `.borderedProminent` button switches to a gray fill, but the explicit label color overrides the system's
disabled label color. So the label keeps its accent-pair color on the gray fill.

I sampled these pixels from the fresh captures:

| State | Label on fill | Ratio |
| --- | --- | --- |
| Baseline system disabled, light (`before/ios/approvals-unsupported.png`) | #C2C2C0 on #E9E8E4 | 1.45 |
| Baseline system disabled, dark (`before/ios/questions-dark-bottom.png`) | #65696A on #3E4442 | 1.79 |
| **Now, light** (`after/ios/approvals-approved-held-sent.png`, `-unsupported.png`) | #FFFDF7 on #E9E8E4 | **1.15 to 1.21** |
| **Now, dark** (`after/ios/approvals-approved-held-dark-sent.png`, `questions-dark-bottom.png`) | #1B211E on #3E4442 | **1.47** |
| Sibling bordered "Decline", disabled, for comparison | #C2C2C0 on #E9E8E4 | 1.45 |

Crops: `12-approval-collages/crop-ios-approvals-approved-held-sent.png`, `crop-ios-approvals-approved-held-dark-sent.png`,
`crop-before-unsupported.png`, `crop-before-q-dark.png`, and `disabled-before-after.png`.

In light mode, the settled "Approved" pill now looks like an empty gray capsule next to a legible "Decline". The new
"Approval sent." line carries the meaning, so M2 itself holds. But this is the new evidence for M2, and it shows an
obvious defect. WCAG exempts disabled controls from contrast, but these labels carry state, not just "unavailable":

- Approvals: "Approving…" and "Declining…" while a decision is sending. Native shows no other visible progress until it
  settles, unlike the web's "Sending decision…" line.
- Questions, accepted at 9: the disabled "Send answers" and the busy "Sending answers…".
- Connection (`RootView.swift:289-295`, disabled while busy): "Checking server…" and "Signing in…".
- `HomeStates.swift:106`, `:161`: "Checking connection…".
- `ComputerView.swift:118`: "Updating…". `DeviceNotifications.swift:62`: "Enabling…". And the disabled
  "Create an assistant", "Send securely" and "Retry same saved message".

Fix direction: apply `onAccent` only while the button is enabled, so disabled buttons keep the system treatment. The
`.disabled` set on the call site reaches the style body through the environment:

```swift
struct AccentProminentButtonStyle: PrimitiveButtonStyle {
  func makeBody(configuration: Configuration) -> some View { AccentProminentButton(configuration: configuration) }
}
private struct AccentProminentButton: View {
  let configuration: PrimitiveButtonStyleConfiguration
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    Button(role: configuration.role, action: configuration.trigger) {
      if enabled { configuration.label.foregroundStyle(Palette.onAccent) } else { configuration.label }
    }.buttonStyle(.borderedProminent)
  }
}
```

Rerun: recapture `approvals-{approved,denied}-held-sent`, `approvals-approved-held-dark-sent`,
`approvals-unsupported`, `questions-dark` and `questions-dark-enabled` on iPhone and iPad. Then sample the disabled
labels. They should read about 1.45 light and 1.79 dark, matching the sibling "Decline". Enabled labels should still
read 5.91 light and 9.32 dark. The current UI tests and assertions cover the flows, so no new test is needed. XCUITest
can't check color, and the pixel samples are the proof.

## M1, web: closed

- The CSS diff against `1933cd6` is pure addition at `src/styles.css:658-664`. The `.approval-card` shell, `h2` and
  `small` rules match the accepted commit byte for byte. The new grid, margins, 11px eyebrow, 14px expiry and
  unavailable text, and 44px action rules are all scoped to `.decision-card`, which only `ApprovalCard` renders
  (`Conversation.tsx:459`). `.decision-status` is unscoped but has a single user (`Conversation.tsx:468`). Specificity
  holds: `.decision-card .actions` (0,2,0) beats the later `.actions` rule, and `.decision-card small` comes after
  `.approval-card small` with equal specificity.
- Question and secure cards are back to the accepted shell. The fresh 09:08 web Question captures match accepted rhythm
  (`12-approval-collages/web-phone.png`, last two panels). `questions-approvals-v2-regression.json` reports 21 screens
  with no overflow and 8 openings with no jump button. The first choice is visible at every normal size.
- The opening selector and removal tracking now use `[data-attention-kind="clarify"], [data-attention-kind="approval"]`
  (`use-conversation.ts:330`, `:338`, `:348`). The only producers of `data-attention-kind` are `attentionAnchor` in
  AttentionCard, ApprovalCard and SecureRequestCard. Secure cards have `secure`, so they never match. The query is
  scoped to the transcript element, so the dock can't match.
- The tests discriminate (`tests/transcript-ui.test.ts:594-619`). The approval opens at 1400 with no jump button, then
  follows to 2600 after removal. With an official card before a question, the view opens at the question, 1000. Review
  11's selector would have opened at the official card, 500, so this test would have failed against it. 58 of 58 web
  tests pass and the build passes, per the logs.

### Correction to review 11: the implementer's objection holds

I claimed that a secure card listed before a question would newly win the opening. That was wrong for real secure
requests. `use-conversation.ts:168-171` sets `reveal.current` for a new secure request on the first load or while
following, and the layout effect consumes `reveal` before it tries the ordinary selector (`:334-338`). `git show 1933cd6`
has the same lines at 171 and 334-335. So a real secure request already won in the accepted commit, and the web already
opened at secure cards before this delta. The test asserting the explicit secure reveal at 500 encodes established
behavior and should stay. My official-card claim was correct and is now fixed. Native secure-versus-question parity,
review 11 polish item 1, stays with the future Secure pass as N1.

## M2: closed on web, closed on native apart from R1

- Web: a visible `p.decision-status role="status"` says "Sending decision…", then "Approval sent." or "Decline sent."
  `approvals-v2-after.json` reports 14px, opacity 1, rgb(105,114,104) for both. Payloads are approve, approve, deny,
  deny. The settled buttons stay disabled at opacity 0.42, which is fine now that the words are visible
  (`web-phone.png`, panels 2 and 3).
- Native: a footnote `Text(confirmation)` in `Palette.muted` appears under the actions once the decision settles
  (`ConversationTurnView.swift:165`), with `AccessibilityNotification.Announcement` posted after a successful POST
  (`:181`). `store.dismissError()` runs before resending (`:172`). I inspected the announcement in code only.
- The `holdDecision` fixture only suppresses the post-decision GET swap (`DebugFixtures.swift:353`). The held variants
  remove `decisionError`, tap once, assert the specific confirmation and the disabled settled button, then capture
  (`ScreenshotTourTests.swift:315-322`). The failure and retry variants are still captured, and the tests still check
  the error and the retry payload. Fresh iPhone and iPad captures show "Approval sent." and "Decline sent." under the
  actions in light and dark (`ios-held.png`, `ipad-held.png`). They have no before images because that state was never
  captured, and the ledger says so honestly.
- The stale "1 decision waiting" dock in the held state is still visible. It is correctly left with the status-dock
  follow-up.

## M3: closed for enabled buttons, but the style needs R1

- `Palette.onAccent` (`AvatarView.swift:21`) is #FFFDF7 in light mode and #1B211E in dark. I sampled the fresh captures:
  Approve light #FFFDF7 on #246F59 is 5.91. Approve dark #1B211E on #8BD2B2 is 9.32. Questions "Send answers"
  enabled in dark, iPhone and iPad, is 9.32 (`questions-dark-enabled.png`). The baseline dark Approve was 1.76.
- Style shape: one native `Button(role:action:)` wrapped in a `PrimitiveButtonStyle`, so the call site keeps one
  control and one action. `.disabled`, `.controlSize`, `.tint` and `.buttonBorderShape` are environment values, so
  they still reach the inner button, as the capsule Connection button and the large Approve show. Accessibility
  identifiers still resolve, because the UI tests find `Approve`, `enableNotifications`, `retryConnection` and the
  others. `rg borderedProminent ios` leaves only `RootView.swift:13`, and there are 14 `.accentProminent` call sites.
  No custom shape or background was added.
- Tint overrides by callers: ComputerView's held state tints `Palette.muted`. With `onAccent` that measures 4.91 light
  and 7.57 dark, up from white at 2.16 in dark. That is an improvement. Every other override is `Palette.accent`.
- R1 above is the only defect in the style.

## Accepted polish and limits (nonblocking)

1. `RootView.swift:291` forces the Connection button's busy spinner to `.tint(.white)`. After R1, that spinner shows on
   the system disabled fill. It's pre-existing and belongs to the Connection screen pass.
2. `BotListView` "Create an assistant" fakes a disabled state with `.opacity(0.4)` instead of `.disabled`, so it keeps
   `onAccent` at 40%. It's pre-existing and belongs to the Home and setup pass.
3. In `annotated/approvals-ios-dark-contrast.png`, the "1" marker on the after panel sits on the "o" of "Approve" and
   hides part of the label it measures. Offset the marker the way the before panel does.
4. Native still has no visible text while a decision is sending. After R1, the system-gray "Approving…" label is
   legible enough for a sub-second window, so this doesn't block.
5. Review 11 polish items 2 to 7 are unchanged and still apply: the post-decision receipt, the dock duplication, iPad AX
   stacking, the top inset under the navigation bar, no unseen cue while parked, and the identical error captures.
6. Limits: no physical device, VoiceOver, hardware keyboard or trackpad, live SSE removal, expiry race, or real
   provider action. Announcements are source-inspected only. I didn't recompute the web or native fingerprints. I
   confirmed the logs: web 58 of 58 and build OK, iPhone 3 of 3 (`ios-approvals-v2-final.log`) and iPad 3 of 3
   (`ipad-approvals-v2-final.log`). The 14 restyled screens outside Approvals and Questions get their own full
   reviews later.
