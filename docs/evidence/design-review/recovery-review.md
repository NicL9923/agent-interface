# Failed and interrupted turns: independent review

Reviewer: Claude Opus 5.5, high effort. Implementer: GPT-6.1 Sol.
Scope: uncommitted delta on `nic/full-app-design-review` against `098c9b1`, plus callers
(`use-turn-retry.ts`, `AppStore.retryOffer`, `CheckboxStyle`, `styles.css` activity rules).
My collages and crops are in `reviews/14-recovery-collages/`.

## Verdict

Gate does not pass yet. Root should not advance to Assistant details/artifacts.

| Surface | Score | Blocking items |
| --- | --- | --- |
| Web desktop | 8.5 | M1, M2 |
| Web phone | 8.5 | M1, M2 |
| Native iPhone | 8.8 | M3 |
| Native iPad | 8.8 | M3 |

The direction is right on every surface. Before, the failure read as a grey "is having
trouble..." line with a tiny Retry. Now each surface has a clear heading, the real reason,
an honest sentence about the draft and a 44 px or larger action. The three blockers below
are small and local. Once they're fixed and recaptured, I expect web at 9.2 and native at 9.2.

## Must fix

### M1. Web: the failure announcement moved into a newly mounted live region

- `src/app/Conversation.tsx:227-231`. While working, `<div role="status"><Shimmer/></div>` is
  mounted. On failure or interruption the ternary swaps it for a different element, a
  fragment whose `<p className="recovery-title" role="status">` is new. React unmounts the old
  region and inserts a new one with its text already set.
- Live regions announce changes to a region that already exists. A region inserted with
  content often stays silent, especially in Chrome with NVDA or JAWS. Before this change, the
  same element changed text in place to "Ranch hand is having trouble...", so it was announced.
  This is a regression in the screen's main job, telling the person the task stopped.
- The codebase already knows this rule: `Conversation.tsx:151` says "Always mounted, so a
  screen reader is already watching when a reply lands."
- The reason (`.recovery-detail`) is outside any live region, so it is never announced.
- Fix: keep one always-mounted `<div role="status">` and switch only its children. Put the
  title and the detail inside it. Add a test in `tests/transcript-ui.test.ts` that renders
  `working` and then `failed`, and asserts the same `[role=status]` node now holds the title
  and the reason.
- Screenshot: not visible in pixels. Verified from code.

### M2. Web: the main recovery action is a muted grey ghost button, while native uses the primary style

- `src/styles.css:680` sets `.activity-status { color: var(--muted) }`. `.retry-turn` inherits
  it (`button { color: inherit }`, `styles.css:75`). The Retry and "Put my message in the
  message box" labels render `#697268` on `#FAF8F2`, 4.70:1, which I sampled in
  `after/web-recovery-failed-phone.png`. That's the same grey as the helper text above it.
- Native moved both actions to `.accentProminent` (filled green, 5.91:1). Seen together in
  `reviews/14-recovery-collages/web-phone-retry.png` and `ios-retry.png`, the same action looks
  primary on iOS and secondary on web. Web is also inconsistent with itself: Approve
  (`Conversation.tsx:470`) and the question Send (`AttentionCard.tsx:118`) use `.primary`.
- Enabled Retry (4.70:1) and disabled Retry (1.74:1, `after/web-recovery-retry-unsupported.png`)
  differ only by shade of grey. The enabled state reads weak.
- Fix: give the web recovery actions `className="primary ..."`
  (`Conversation.tsx:242`, `:244`), matching native and the accepted Approvals pattern. Keep
  the 44 px minimum and the focus ring, and recheck the focus ring on the filled button.
  If root prefers a secondary treatment, then both platforms must switch to it, and its label
  must use `var(--ink)`, not muted. Either way, the two platforms should match.
- Screenshots: `after/web-recovery-failed-desktop.png`, `after/web-recovery-failed-phone.png`,
  `after/web-recovery-retry-refused.png`.

### M3. Native: the review checkbox's 44 pt frame is not its tap target

- `ios/AgentInterface/StatusDock.swift:104-106` adds `.padding(.vertical, 6).frame(minHeight: 44)`
  outside the `Toggle`. The tappable view is the plain `Button` inside `CheckboxStyle`
  (`ConversationView.swift:1152-1160`). Its label is an `HStack` with no `contentShape`. Padding
  and frames outside a button don't widen where it can be tapped, and empty areas inside the
  stack don't register taps. The target is about the height of one subheadline line, roughly
  20 pt, plus a 13 pt square glyph (`reviews/14-recovery-collages/ios-review-row-crop.png`).
- The same file uses the correct idiom at `ConversationView.swift:967`:
  `.frame(minHeight: 44).contentShape(RoundedRectangle(...))`.
- This is the only control that unlocks Send after an interruption, so it needs the full
  target. The delta looks like it meets 44 pt but doesn't.
- Fix: in `CheckboxStyle`, move the vertical padding and `minHeight: 44` onto the label and add
  `.contentShape(Rectangle())`. Then the whole row is tappable. Check it with a UI test that
  taps a coordinate in the row's padding and asserts Send becomes enabled.
- Confidence: high, from SwiftUI hit-testing rules and the repo's own idiom. A screenshot
  can't show it. I didn't run a device or simulator.

## Non-blocking polish

1. The web Retry icon stays 16 px at 200% text (`Conversation.tsx:247`), so it looks undersized
   next to a label about 28 px tall (`after/web-recovery-failed-large-text.png`). Size it in
   `em`.
2. The web review checkbox stays about 13 px at 200% text while its label doubles
   (`after/web-recovery-interrupted-large-text.png`). Scale it with `width: 1.1em; height: 1.1em`.
3. At 200% or AX3 with an interruption, the title scrolls out of view and the screen opens on
   body text (`after/web-recovery-interrupted-large-text.png`,
   `after/ios/recovery-interrupted-large-text.png`). This is acceptable for a scrolled
   transcript. It's worth a look if the title can sit nearer the gate.
4. On iPad, guidance lines run about 95 characters
   (`reviews/14-recovery-collages/ipad-recovery-unsupported-result-crop.png`). Capping the
   recovery copy near 65 to 70 characters would read better.
5. Neither title carries heading semantics. Web uses `<p>`. Native lacks
   `.accessibilityAddTraits(.isHeader)`. Optional.
6. `RetryTurn.checkingNotice` (`ConversationTurnView.swift:346`) is now unused. The new
   checking sentence is repeated literally in `Conversation.tsx:237`, `ConversationView.swift:622`
   and the native hint. Remove the dead constant or update it and reuse it.
7. When Hermes can't look requests up, the disabled Retry stays on screen forever beside copy
   telling the person to use the message box (`after/web-recovery-retry-unsupported.png`,
   `after/ios/recovery-unsupported-result.png`). Hiding it would remove a dead control. This one
   is debatable.
8. This predates the delta: after a put-back, "Put my message in the message box" stays enabled,
   and each tap appends the message again (`after/web-recovery-retry-put-back.png`). Track it as
   a follow-up, not for this gate.

## What I verified

- Retry logic is unchanged. In the web diff, `use-turn-retry.ts` is untouched. The fixture
  driver throws if a retry carries `draftBaseRevision` or omits `retryOf`, and it asserts that an
  unconfirmed retry reuses its request ID with `reviewedUncertain: true`. Native `retryOffer` and
  `RetryRequest` are untouched.
- The refused state keeps the earlier draft. The web driver asserts
  `"Keep this draft\n\nIs the north gate closed?"`, and native asserts the same composer value.
- The interruption gate holds on both platforms. Send is disabled before the check and enabled
  after, as asserted in `capture-design.js` and `ScreenshotTourTests.swift:373-379`.
- Contrast: native enabled action 5.91:1 light and 9.32:1 dark, matching
  `recovery-final-button-samples.txt`. Muted recovery text on native and web is 4.70:1 light and
  7.57:1 dark. The web review box border measures 4.71:1. The native checkbox outline measures
  4.70:1.
- Reports: `recovery-final-before.json` and `recovery-final-after.json` each have 19 unique
  paths, `overflow: false` on every entry, and 5 retry submissions. `recovery-v3-tests.log` shows
  104 passed. `recovery-v3-build.log` built. `ios-recovery-v4-after.log` and
  `ipad-recovery-v4-after.log` show `testRecoveryDesignReview` passed.
- The annotated comparisons have timestamps after the final captures. The 12 pairs match the raw
  before and after images I checked. I found no false claim in the ledger or the acceptance note.

## Evidence limits

- No VoiceOver, NVDA, hardware keyboard, physical device or live Hermes stream was run. That is
  stated honestly. M1 and M3 are exactly the kind of issue those runs would catch.
- The accepted-retry web image comes from a reload, not an SSE update.
- The 27 native transcript tests ran on an earlier native fingerprint. Only the label, button
  style and wrapping changed since then. I accept that reasoning, but M3's fix must rerun them.
- The interrupted fixture has no tool calls, so "Review the last actions above" points only at
  assistant prose. A fixture with a completed tool call in the interrupted turn would be more
  realistic.
- I didn't recompute the web or native fingerprints.

## Re-review scope

After the fixes, I only need the diff for M1 to M3, a new failing-then-passing test for M1, a UI
test for M3, and fresh `after/` web phone, desktop and dark captures plus annotated web
comparisons for M2. Native pixels don't need recapturing for M3 unless the layout changes.
