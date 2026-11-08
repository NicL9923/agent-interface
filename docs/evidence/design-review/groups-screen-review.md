# Group conversations screen review, round 1

- Reviewer: Claude Opus 5.5 (Anthropic), independent of the OpenAI Sol/Terra implementation.
- Effort: High was requested. This session cannot observe how its internal effort setting maps to that level. This note does not assume it ran below High.
- Code state: `c4a7fcac5d8d5e29c83e24ae91f9da15a24bd850` on `nic/full-app-design-review`, PR #207.
- Captures: `/Volumes/DevSSD/scratch/wildbots-design-review/group-screen-r1/`. Web frames are 1440x1000 and 390x844. The native frame is a 1206x2622 iPhone render. All coordinates below are pixels in the named source image.
- Review crops: `/Volumes/DevSSD/scratch/wildbots-design-review/group-screen-r1-review/`.

## Score

**7 / 10. Not passing. The bar is 9.**

The screen matches the warm neutral and green system. The mention picker and the create flow are solid, and both widths hold up. The score stays at 7 because threads are offered but never shown. Every message has "Reply in thread", yet the transcript is flat, and the reply banner doesn't say which message you're answering. Speaker identity is also weak for a room built around several assistants, and the native composer cuts off its own instructions.

## Prioritized issues

Each tag marks where a finding comes from. **Pixel** means seen in a capture and checked in source. **Code** means source only, in a state nobody captured.

### 1. Threads are invisible after you start one. Severity: high. Pixel and code.

- `group-thread-1440.png` (653-823, 451): the banner reads "Replying in thread · New topic" and doesn't name the message being answered. Both messages above it show the same "Reply in thread" link at (636-718, 250) and (636-718, 380). Neither one is highlighted, so after clicking you can't tell which thread you joined.
- `group-thread-390.png` (30-200, 609): same banner, same ambiguity.
- `native-Groups.png` (96-340, 920) and (96-340, 1192): native also shows "Reply in thread" under every message with no grouping.
- Source: `src/components/GroupChats.tsx:179-180` maps messages in `seq` order and uses `payload.thread_id` only for the button. `src/components/GroupChats.tsx:184` renders the banner with no parent context. Native does the same at `ios/AgentInterface/CollaborationViews.swift:325-336` and `:371`.
- Effect: a thread reply lands at the bottom of the flat list. It looks exactly like a new topic and still offers "Reply in thread" itself. The thread model exists for the server but not for the person reading.
- Smallest fix: in the banner, name the parent's sender and a one-line snippet, such as "Replying to Ranch hand: Replace the battery…", and give the parent message the selected tint (`--accent-soft`) while `threadId` matches it. Mark messages whose `thread_id` matches an earlier message with a small "In thread" label or a left rule. Hide "Reply in thread" on them, or keep it but drop the duplicate entry point. Make the same change on native.

### 2. Speakers are hard to tell apart in a room of assistants. Severity: medium. Pixel and code.

- `group-conversation-1440.png` (636-708, 194) and (636-708, 297): "Nicolas" and "Ranch hand" are 12px semibold labels (`.message-attribution` at `src/styles.css:547-556`) above 16px body text. Human and assistant messages look identical. The rest of the app identifies assistants by avatar, as in the sidebar at (20-75, 95-745), but this room drops avatars entirely.
- `native-Groups.png` (96-460, 780) and (96-430, 1052): same on native, with `.caption.bold()` at `ios/AgentInterface/CollaborationViews.swift:328`.
- The person's own messages aren't marked as theirs. `Attributed.sender.id` is available at `src/components/GroupChats.tsx:17` and could be compared with `bootstrap.user.id`.
- Smallest fix: `member_id` is the bot id (`src/server/collaboration.ts:72`), so `bootstrap.bots` can supply a 20-24px avatar beside assistant names. Label the person's own messages "You". This needs no layout change beyond the attribution row.

### 3. The native composer placeholder is truncated. Severity: medium. Pixel.

- `native-Groups.png` (72-1000, 2350): the placeholder reads "Message the group… use @handle to a…". The part that teaches mentions is cut off. Crop: `group-screen-r1-review/native-composer-crop.png`.
- Source: `ios/AgentInterface/CollaborationViews.swift:388`, a vertical-axis `TextField` with `lineLimit(1...6)`. The placeholder shows on one line only.
- Smallest fix: shorten the placeholder to "Message the group" and move the mention hint into the status line under the field while the draft is empty, for example "Type @ to address one assistant". Web wraps the text today, but should use the same copy for parity.

### 4. Approval and unconfirmed-turn notices don't say which assistant. Severity: medium. Code only, uncaptured state.

- `src/components/GroupChats.tsx:183` and `ios/AgentInterface/CollaborationViews.swift:346-350` render the approval text plus "Allow once" and "Deny" without naming the requesting member. `actionItem.member_id` is available on the same object. A room can hold up to six assistants, so the person approves a command without knowing who asked for it.
- On iOS, the unconfirmed-turn copy says "Review it in the native group client". Inside the native app, that phrase is ambiguous, and it also doesn't name the member.
- Smallest fix: prefix the card with the member's display name and avatar, such as "Ranch hand wants to run…". Rewrite the iOS copy to name the actual place to review the turn.

### 5. The native member list looks like an input field. Severity: low to medium. Pixel.

- `native-Groups.png` (48-1156, 452-608): the member caption "Ranch hand (@ranch) · Kitchen companion (@kitchen)" sits alone in a fully rounded white section. It reads like a search field or a tappable pill and costs about 160px of height.
- Source: `ios/AgentInterface/CollaborationViews.swift:320`.
- Smallest fix: make it a plain section header or footer on the message section, or use a navigation subtitle, instead of its own row.

### 6. The web "Reply in thread" link has weak affordance and differs from native. Severity: low. Pixel.

- `group-conversation-1440.png` (636-718, 250) and (636-718, 380): the link is 12px muted gray with no underline or icon, so it reads as metadata. Native renders the same control in accent green at `native-Groups.png` (96-340, 920).
- Source: `src/components/collaboration.css:28`.
- Smallest fix: use `color: var(--accent)` at rest to match native. Hover already turns it accent.

### 7. Composer status copy conflicts with thread mode. Severity: low. Pixel.

- `group-thread-1440.png` (653-740, 549): "Ready for a topic." sits under "Replying in thread". The status describes the assistants, but it reads as a hint about what you're typing.
- Source: `src/components/GroupChats.tsx:167`, mirrored at `ios/AgentInterface/CollaborationViews.swift:311`.
- Smallest fix: when idle, say "Assistants are idle", or show nothing and keep only the working and blocked states.

### 8. The mention popover clips the last message's link. Severity: low. Pixel.

- `group-mention-1440.png` (636-868, 378-432): the popover's top edge cuts through the descenders of "Reply in thread" on the last message. It looks like a rendering glitch. Crop: `group-screen-r1-review/mention-crop.png`.
- Source: `src/components/collaboration.css:53`, `bottom: calc(100% - 6px)`.
- Smallest fix: use `bottom: calc(100% + 6px)` so the popover floats clear of the composer border. Alternatively, give the composer more top margin while suggestions are open.

### 9. "Reply in thread" doesn't move focus and has no unique name. Severity: low. Code only.

- `src/components/GroupChats.tsx:180` only sets `threadId`. Keyboard and screen reader users stay on the button and must find the composer themselves. Every button announces as "Reply in thread", with no sender context.
- Native `ios/AgentInterface/CollaborationViews.swift:334` has no `FocusState` hand-off either.
- Smallest fix: focus `field.current` after setting the thread. Add `aria-label={`Reply in thread to ${sender}`}`, and use `.accessibilityLabel` on native.

### 10. The create picker gives no feedback at the six-assistant limit. Severity: low. Code only.

- `src/components/GroupChats.tsx:161` and `ios/AgentInterface/CollaborationViews.swift:262` silently disable the remaining checkboxes once six are chosen. No count or reason is shown. Assistant rows also lack avatars (`group-create-1440.png` (674-965, 300-490)), which makes similar names harder to scan.
- Smallest fix: add a live legend suffix such as "Choose 2–6 assistants · 2 chosen" and reuse the small avatar from issue 2.

## What works

- Visual system: warm surface, green accent, soft selected room tint, dashed "New group", and rounded composer all match the established design at both web widths and on native.
- The mention flow is well built. The listbox has `aria-activedescendant`, Enter and Tab accept without sending, Escape closes, and IME composition is respected (`src/components/GroupChats.tsx:186-207`). Native announces the inserted mention. The agent's hands-on check, typing @ra and pressing Enter, matches the code.
- The create flow is clear. The fieldset legend states the 2–6 rule, Create stays disabled until it's met, and the personal-assistant visibility note appears in context. Cancel keeps the conversation draft.
- Phone layout: rooms collapse to a horizontal chip row, `min-height: 44px` touch targets apply to reply and thread controls (`src/components/collaboration.css:44-46`), and long text wraps cleanly. `group-sent-390.png` shows the sent message landing and the draft clearing.
- Safety paths are intact and unchanged by this review: saved request IDs with exact retry bodies for send and create, scope-guarded errors and reloads, the 404 room-revocation wipe, stream-coalesced reloads, and explicit Allow once / Deny.

## Coverage gaps, not graded as defects

- Not exercised in any capture or by hand: real room creation, uncertain send or create recovery, Allow once / Deny, Stop discussion, room revocation, "Load more messages", the empty room, and the no-rooms empty state.
- Native: one fixture conversation frame only. No gestures, keyboard, mention picker, create sheet, VoiceOver, dark mode, or Dynamic Type.
- Web: light mode only. No dark-mode or 200% zoom capture.
- Fixture limits accepted as stated: the fixed Sep 21 native dates, different demo content across platforms, relative web timestamps, and the draft carried from the 1440 run into the 390 frames.

## Next small fixes, in order

1. Give threads context: name the parent in the banner, tint the parent, and label replies (issue 1).
2. Add assistant avatars and a "You" label in attribution (issue 2).
3. Shorten the native placeholder and move the @ hint to the status line (issue 3).
4. Name the requesting assistant on approval cards (issue 4).
5. Apply the small CSS and copy fixes in issues 5-8 as one pass.
