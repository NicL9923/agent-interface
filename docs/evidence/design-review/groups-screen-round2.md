# Group conversations screen review, round 2

- Reviewer: Claude Opus 5.5 (Anthropic), independent of the OpenAI Sol implementation.
- Effort: High was requested. This session can't observe how its internal effort setting maps to that level, and this note doesn't assume it ran below High.
- Code state: `c3a57ea361355701b37c9684dca01701d8f98607` on `nic/full-app-design-review`, PR #207. Scope is the product diff since `c4a7fcac5d8d5e29c83e24ae91f9da15a24bd850` plus the code that calls the changed lines.
- Captures: `/Volumes/DevSSD/scratch/wildbots-design-review/group-screen-r2/`. Web frames are 1440x1000 and 390x844. The native frame is 1206x2622. Coordinates are pixels in the named raw capture.
- Review crops: `/Volumes/DevSSD/scratch/wildbots-design-review/group-screen-r2-review/`, including `phone-a.png`, `phone-b.png`, `desk-create.png`, `desk-mention-approval.png`, `mention-zoom.png` and `sent-compare.png`.

## Score

**8.6 / 10. Not passing yet. The bar is 9.**

Round 2 fixed the big problems. Threads now have visible context, speakers are identifiable, the native composer reads cleanly, and approvals name the requester. Two visible glitches remain. A newly sent message lands partly under the sticky composer. On desktop, the mention popover now covers the last "Reply in thread" link and leaves a stray glyph fragment beside it. Both fixes are small, but both show up during the core compose-and-send loop.

## Round 1 findings, settled

| R1 issue | Status | Evidence |
| --- | --- | --- |
| 1. Invisible threads | Fixed | Pixel: `group-thread-1440.png` banner (653-1137, 513-536) names "You: Can we fit…", and the selected message has a tint and outline at (635-1393, 173-286). The reply carries "In thread with You: …" with an accent rule at (648-1228, 343). Same at 390, and on native at (96-1040, 980-1080). Code: `src/components/GroupChats.tsx:167-170,202`, `ios/AgentInterface/CollaborationViews.swift:443`. Using the first loaded message as context, with no invented parent ID, is the honest choice. |
| 2. Weak speaker identity | Fixed | Pixel: 24px assistant avatar and 14px name at `group-conversation-1440.png` (650-764, 313). "You" with tinted card at (636-1392, 174-285). Native avatar and name at (100-596, 921). Native "You" is code-only, because the fixture sender isn't the signed-in user (`CollaborationViews.swift:452`). |
| 3. Truncated native placeholder | Fixed | Pixel: `native-Groups.png` placeholder "Message the group" at (72-498, 2341). Hint "Type @ to address one assistant." at (37-613, 2459) is readable. |
| 4. Approval and unconfirmed notices unnamed | Fixed on web, code-only on native | Pixel: "Ranch hand requests approval" with avatar at `group-approval-1440.png` (884-1118, 608) and `group-approval-390.png` (818-1053, 513). Native `CollaborationViews.swift:350,353` and the web unconfirmed note are code-only. |
| 5. Native member list looked like an input | Fixed | Pixel: plain section header at `native-Groups.png` (96-1049, 401). |
| 6. Weak reply affordance | Fixed | Pixel: accent green "Reply in thread" at `group-conversation-1440.png` (648-737, 257). It matches native. |
| 7. Status contradicted thread mode | Fixed | Pixel: "Assistants are idle." under the thread banner at `group-thread-1440.png` (653-762, 638). |
| 8. Mention popover clipped the last message | Fixed at 390, regressed at 1440 | See remaining issue 2. |
| 9. Reply didn't move focus or have a unique name | Fixed, code-only | `GroupChats.tsx:172` and the reply button `aria-label` with speaker and snippet. Native `composerFocused` and `.accessibilityLabel` at `CollaborationViews.swift:448-450`. Covered by unit tests, not observed. |
| 10. No feedback at the six-assistant limit | Fixed | Pixel: "6 chosen" legend and the limit sentence at `group-create-limit-1440.png` (900-1107, 272) and (877-1204, 582). Avatars on every row. Native `CollaborationViews.swift:262-271` is code-only. |

Safety behavior was read in the diff and is unchanged. Send still keeps the selected `threadId` and clears `replyToId` only on confirmed success (`GroupChats.tsx:146`). Room changes reset both fields (`:126`). Approval still posts the exact task, member, generation and request IDs.

## Remaining issues

Tags: **Pixel** means seen in a raw capture and traced in source. **Code** means read in source only.

### 1. A sent message lands under the sticky composer. Severity: medium. Pixel.

- `group-sent-390.png`: the new "You" card starts at (16-374, 628), and the composer's top edge cuts it at y=697. The card's "Reply in thread" link and bottom padding are hidden. The green own-message tint makes the overlap obvious. Comparison crop: `sent-compare.png`. The round 1 frame happened to fit, but the behavior predates round 2.
- Source: `src/components/GroupChats.tsx:146` reloads after send with no scroll. `.group-composer` at `src/components/collaboration.css:37` is `position: sticky; bottom: 0` with no clearance. Browser scroll anchoring keeps the old position, so appended content slides under the composer.
- Smallest fix: after a confirmed send's reload, scroll the last `.group-message` into view with `block: 'end'`, and give `.group-message` a `scroll-margin-bottom` equal to the composer's height. A fixed 160px value is fine, or read it from the composer's height. Apply the same scroll when a new member reply arrives while the person is already at the bottom. Native `List` needs a matching `ScrollViewReader` scroll to the last message ID.

### 2. On desktop, the mention popover leaves a glyph fragment. Severity: low. Pixel.

- `group-mention-1440.png` (648-652, 428-440): moving the popover up by 12px (`collaboration.css:59-61`, `bottom: calc(100% + 6px)`) put it over the last "Reply in thread" link. The popover's rounded top-left corner exposes a sliver of the "R". It reads as a rendering glitch, the same class of defect as round 1. Zoom: `mention-zoom.png`, top half. At 390 the popover sits below the link without touching it, as shown in the bottom half.
- Smallest fix: set `.mention-list` to `left: 0` so its rounded corner clears the 12px message inset. Overlapping the transcript is fine for a popover. Partial glyphs aren't.

### 3. On own messages, the selected state relies on a 1px outline. Severity: low. Pixel.

- Own tint `--user` #e7eee4 and selected `--accent-soft` #dce9df are nearly the same fill (`src/styles.css:21,24`). In `group-thread-390.png` (796-1154, 224-383 in `phone-a.png`), the only difference from the unselected own card is the thin outline. A selected assistant message, which has no tint at rest, would contrast fine.
- Smallest fix: on `.group-message.selected` (`collaboration.css:27`), use a 3px inset accent bar, such as `box-shadow: inset 3px 0 var(--accent)`, or a 2px outline. Native selection at `CollaborationViews.swift:452` has the same tint-on-tint risk. It is code-only.

### 4. Small polish. Severity: low.

- Pixel: at the six-assistant limit, the disabled "Trail guide" row fades only its checkbox. The avatar and name stay full contrast at `group-create-limit-1440.png` (673-760, 514) and `group-create-limit-390.png` (443-571, 581). Add `.group-create fieldset label:has(input:disabled) { opacity: .55 }` at `collaboration.css:47`. Native `Toggle` dims automatically.
- Pixel: the approval card has uneven vertical padding. At `group-approval-1440.png`, there is about 25px above the requester line and about 40px below the buttons, at (856-1612, 575-736). Trim the bottom margin of `.actions` inside `.approval-card`.
- Code: "In thread with …" repeats a quote of up to 100 characters on every reply in a thread (`GroupChats.tsx:202`, `CollaborationViews.swift:443`). In a long single-thread run on phone, that adds two lines per message. Show it only when the previous message belongs to a different thread.
- Code: when the first character is typed, the status changes from the @ hint to "Assistants are idle." (`GroupChats.tsx:184`). The live region announces a line that says nothing useful to someone who's typing. Keep the hint, or render nothing, while idle with a draft.

## What works

- Thread context is honest and readable at both widths. The banner clamps to two lines on phone, as in `group-thread-390.png` (810-1050, 665-684 in `phone-a.png`). "New topic" stays on one line.
- Speaker identity now matches the rest of the app. Avatars come from `bootstrap.bots`, names come from room members, and fallbacks are sensible (`GroupChats.tsx:158-163`).
- The approval card leads with who is asking, then what, then the two decisions. On phone, the description and both 44px buttons sit fully above the composer.
- The native frame is clean: plain member header, avatar rows, accent reply links with 44pt targets, and a separate readable mention hint.
- The create picker scans well with avatars, a live count and an explicit limit message. Long names wrap cleanly at 390.

## Coverage limits

- Pixel-observed: web conversation, mention, thread, create, create-at-limit and approval at both widths, the phone sent state, and one native populated conversation.
- Code-only: native "You" label and tint, native selected-thread banner and highlight, native create form, approval and unconfirmed notices, every focus hand-off, accessible names, and the web unconfirmed-turn note. The "Open this group in Hermes" destination wasn't verified.
- Not covered: real approval decisions, uncertain send or create recovery, Stop, room revocation, Load more, empty states, dark mode, large text or zoom, VoiceOver, native gestures, and long multi-thread rooms. Fixture limits are accepted as stated: Sep 21 native dates, different demo content across platforms, and relative web times.

## Round 3 fixes, in order

1. Scroll the newest message clear of the sticky composer after send, on web and native (issue 1).
2. Set `.mention-list` to `left: 0` (issue 2).
3. Give the selected message an accent bar instead of relying on tint (issue 3).
4. Optional polish from issue 4: dim disabled create rows, balance approval padding, and quote thread context only on interleaved replies.

Issues 1 and 2 alone should clear 9 if the recaptured `group-sent-390.png` and `group-mention-1440.png` look clean.
