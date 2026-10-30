# Group conversations screen review, round 3

- Reviewer: Claude Opus 5.5 (Anthropic), independent of the OpenAI Sol implementation.
- Effort: High was requested. This session can't observe how its internal effort setting maps to that level, and this note doesn't assume it ran below High.
- Code state: `4ce64c6f7de69aa421bbb5a92b28d419f005c2f5` on `nic/full-app-design-review`, PR #207. Scope is the product diff since `c3a57ea361355701b37c9684dca01701d8f98607` plus the code that calls the changed lines. Settled round 1 work wasn't reviewed again.
- Captures: `/Volumes/DevSSD/scratch/wildbots-design-review/group-screen-r3/`. Web frames are 1440x1000 and 390x844. The native frame is 1206x2622. Coordinates are pixels in the named raw capture.
- Review crop: `/Volumes/DevSSD/scratch/wildbots-design-review/group-screen-r3-review/mention-zoom-1440.png`, which is `group-mention-1440.png` (620-900, 400-480) scaled 4x.
- Method: source and saved pixels only. No tests, builds, browsers or runtime checks were run for this review.

## Score

**9.0 / 10. Pass.**

Both requested checks are clean. A confirmed send on phone now lands fully above the composer, and the desktop mention popover no longer leaves a glyph fragment. The selected-message bar, dimmed disabled rows, balanced approval padding and steady idle hint also landed, and none of the frames show a visual regression. Two code-only issues remain in the new auto-scroll. Both depend on what sits below the newest message, and neither affects the common send-and-read loop shown in the captures.

## Round 2 findings

| R2 issue | Status | Evidence |
| --- | --- | --- |
| 1. Sent message under the sticky composer | Fixed on web. Native is code-only. | Pixel: in `group-sent-390.png`, the new "You" card spans (16-374, 548-680), its "Reply in thread" link sits at (28-117, 641), and the composer starts at y=697. That leaves a 16px gap, which matches the formula in `src/components/GroupChats.tsx:192-201`. The flag is set only after a confirmed send (`:153`) and is cleared on room change (`:133`). The failed or uncertain path never sets it. Native: `ios/AgentInterface/CollaborationViews.swift:376-385,541` scrolls to the last message ID with `.bottom` above the existing `safeAreaInset` composer. |
| 2. Mention popover glyph fragment on desktop | Fixed | Pixel: in `group-mention-1440.png`, the popover at (637-856, 429-476) starts flush with the composer edge and fully covers the last "Reply in thread" link. The 4x crop shows no partial "R" or other stray glyph. The source change is `left: 0` at `src/components/collaboration.css:63`. |
| 3. Selected own message relied on a 1px outline | Fixed on web. Native is code-only. | Pixel: a 3px accent bar is visible at `group-thread-1440.png` (636-639, 174-285) and `group-thread-390.png` (16-19, 224-383). With the outline, the selected own card now reads clearly against the unselected own tint at `group-conversation-390.png` (16-374, 224-383). Native overlay is at `CollaborationViews.swift:466-467`. |
| 4a. Disabled create rows faded only the checkbox | Fixed | Pixel: the "Trail guide" avatar and name are dimmed at `group-create-limit-1440.png` (673-803, 514) and `group-create-limit-390.png` (53-183, 581). See `collaboration.css:48`. |
| 4b. Uneven approval card padding | Fixed | Pixel: in `group-approval-1440.png`, the card spans y 573-719, with about 27px above the requester line and about 23px below the buttons. The phone card at `group-approval-390.png` (16-374, 503-672) is balanced too. See `collaboration.css:49`. |
| 4c. Idle status swapped to "Assistants are idle." while typing | Fixed | Pixel: the hint stays "Type @ to address one assistant." with a draft at `group-thread-390.png` (30-220, 791) and `group-conversation-1440.png`. Source: `GroupChats.tsx:191`, `CollaborationViews.swift:321`. |
| 4d. Repeated thread quotes on consecutive replies | Left as is | It was optional in round 2. It's still a phone polish item for long single-thread runs. |

Safety was read in the diff and is unchanged. Request IDs, the `accepted !== true` guard, exact retry bodies, `threadId` handling and approval IDs are unchanged on both clients. The scroll flag is a ref and doesn't affect send state.

## Remaining issues

Tags: **Pixel** means seen in a raw capture and traced in source. **Code** means read in source only.

### 1. Auto-scroll aligns the last message, not the end of the transcript. Severity: low to medium. Code.

- Web: `GroupChats.tsx:217` attaches the scroll target to the last `.group-message`. `:198-200` then pins that message's bottom 16px above the composer. Anything rendered between that message and the composer gets pushed under the sticky composer. That includes the "Load more messages" button (`:222`), the empty-state line, the pending approval card and the unconfirmed-turn note (`:224-230`). `block: 'end'` also scrolls up from the true bottom when needed, because the target sits about 16px short of the maximum scroll.
- Concrete case: on a 390px phone with an overflowing room and a pending approval, the person sends "@ranch why do you need that?". After confirmation, the approval card (about 170px tall, per `group-approval-390.png`) ends up behind the composer. Only a sliver of its top shows, while the status reads "Discussion needs attention." The same happens when a member reply arrives while the reader sits at the bottom with an approval pending.
- Native has the same shape. `scrollTo(last message, anchor: .bottom)` at `CollaborationViews.swift:383` leaves the approval and Stop section (`:351-362`) below the visible area.
- Smallest fix: on web, scroll the panel to its end with `panel.current.scrollTo({ top: panel.current.scrollHeight })`. At maximum scroll, the sticky composer sits in its natural spot after every trailing item, so no margin math is needed. On native, add a zero-height row with `.id("end")` after the actions section and scroll to it.

### 2. "Load more messages" counts as a new arrival and jumps past the loaded page. Severity: low. Code.

- Pages load in ascending order. "Load more" calls `room.reload()` (`GroupChats.tsx:222`), which reads `since=cursor`. A reader who presses it is at the bottom by definition, so `onData` (`:56-59`) sets the follow flag. The view then jumps to the end of the newly loaded page and skips its contents. Before round 3, scroll anchoring left the reader at the start of the new page. Native doesn't have this problem, because following there is driven by `onChange(of: messages.last?.id)` while the last row is visible. Its Load more row, though, has the same exposure if the last message row is on screen.
- Smallest fix: skip the follow flag when the previous page reported `has_more`, because that reader is still paging through history, not watching live arrivals.

### 3. Carried polish. Severity: low. Code.

- "In thread with …" still repeats a quote of up to 100 characters on every reply in a run (`GroupChats.tsx:219`, `CollaborationViews.swift` `messageRow`). Showing it only when the previous message belongs to a different thread would save two lines per reply on phone.
- Web now opens a room at its last loaded message, because the near-bottom check passes while the panel is empty. Native opens at the top. On phone web, this also scrolls the room chips out of view on open. It's a defensible chat default, but the two platforms differ.

## Observed vs source-only

- Observed in pixels: phone web sent state, desktop mention popover, selected bar at both widths, dimmed limit rows at both widths, approval padding at both widths, steady idle hint, and the unchanged native populated conversation (`native-Groups.png`, with no visual regression next to round 2).
- Source-only: all native scrolling and following, the native selected bar, native "You" state, native create form and approvals, focus hand-off, accessible names, the follow-only-at-bottom rule on web, and both remaining issues above.

## Coverage limits

- The agent reports that 42 focused tests, the web production build and a native generic-simulator compile passed. This review didn't rerun them. The new regression test covers staying put while reading above the bottom, following at the bottom, measured clearance for a confirmed send, and no scroll on a failed send. It doesn't cover trailing approval cards or Load more.
- Native unit cases and gestures weren't run, because of the host's Xcode and CoreSimulator mismatch. The native frame is a fixture-only compiled render.
- Not covered: real approval decisions, live coordinator streams, multi-page rooms, room revocation, clipboard, VoiceOver, dark mode, and large text or zoom. These fixture limits are accepted as stated: fixed Sep 21 native dates, relative web times and different demo content across platforms.
