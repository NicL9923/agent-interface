# Search, saved items, history and automations: whole-area review, round 2

Reviewer: Claude Opus 5.5, Anthropic. OpenAI Sol implemented the work, so
this review is independent. High effort was requested. This session does not
expose how effort maps to internal settings, so I can't confirm the level
beyond that request. This is round 2 of at most 3, with one score for the
whole area.

Reviewed commit: `a2c0198870610a401eb4d1bdf4d760126a65510c` on PR #207. The
scope is the diff since `11f01b67c19890479cd7f607d294967e4f8e4c86` plus its
callers. Round 1 is in `discovery-screen-review.md` (8.2).

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/discovery-screen-r2/`.
Web coordinates are CSS pixels in the 1440x1000 and 390x844 captures. Native
coordinates are pixels in the 1206x2622 originals. I read the raw captures
directly and did not use the annotated comparisons or `inspection-overview.jpg`.
I cropped and enlarged the sticky heading area, and I sampled pixels to
measure text contrast.

Sources read: `src/components/DiscoveryPanel.tsx`, `src/components/discovery.css`,
`src/shared/discovery.ts`, `src/app/ChatHeader.tsx`, `src/app/use-action.ts`,
`ios/AgentInterface/DiscoveryViews.swift`, plus the new cases in
`tests/discovery-ui.test.ts` and `HomeParityTests.swift`. I did not review the
capture tooling, `DebugFixtures` or the DEBUG fixture shortcut in
`DiscoveryView`.

## Score: 8.8 / 10, not yet passing

This is a solid round. All ten round 1 findings were addressed on both clients,
and I can see most of the fixes in the captures. History now opens with the
conversation title, "Ranch hand · Read-only history", "You" and "Jordan" as
speaker names, and a pinned Back control. Save reply is an outlined 44 px
button that changes to "Saved" in place. Saved rows say "Reply" or
"Conversation" and show the saved date. Search hits name their destination.
Routine status is in plain words, failures use the danger color, paused
routines explain why nothing is scheduled, and desktop usage is a table. The
honesty guarantees from round 1 still hold.

The area is held just under the bar by a visible glitch in the new sticky
heading, saved reply titles that read like raw markdown, and a page subtitle
that no longer mentions automations. Each one is a small fix.

## Issues, most important first

1. **Content shows through above the pinned history heading.**
   Observed in `history-bottom-1440.png` x 472-640, y 90-114: the bottom of a
   Save reply button and clipped text from the row above appear between the
   page header rule and "Back to results". The same band appears in
   `history-bottom-390.png` x 16-374, y 69-85 as table cell edges.
   `conversation-history-1440.png` y 90-96 shows a sliver of the tab strip in
   the same place. Cause: `.discovery-panel` scrolls and has 24 px top padding,
   or 16 px under 600 px (`discovery.css:1,32`). `.history-heading` sticks at
   `top: 0` (`discovery.css:39`), which leaves that padding uncovered. This was
   round 1's issue 6 fix, and it now shows on every scrolled history page.
   Native does not have this problem: `native-History.png` y 360-625 shows a
   clean inset with a divider.
   *Fix:* Offset the sticky heading by the panel padding and add the same
   amount inside it, for example `top: -24px; padding-top: 32px` and
   `top: -16px; padding-top: 24px` under 600 px. Another option is to move the
   panel's top padding onto its first child so the scrollport edge is the
   visible edge.

2. **Saved reply titles keep markdown leftovers and run across two lines.**
   Observed in `saved-items-1440.png` x 484-1183, y 234-257: "I looked at the
   last 48 hours of events for binary_sensor.north_gate . - 31 open/close
   pairs, all under 4 seconds". `saved-items-390.png` y 231-277 wraps to three
   lines. Cause: `savedReplyTitle` (`src/shared/discovery.ts:25-28`) and
   `replyTitle` (`DiscoveryViews.swift:270`) replace each backtick with a
   space, which leaves " .". They also keep the newline-joined list marker
   "- " and cut at 120 characters with no word boundary. The underscore fix
   from round 1 works. This title is the main label in the Saved tab, so it
   matters more than its size suggests.
   *Fix:* On both clients, delete backticks without adding a space, take the
   first non-empty line, strip leading list or heading markers, collapse
   whitespace, and cut at about 80 characters on a word boundary with an
   ellipsis. Keep the existing "## **Gate**" to "Gate" and identifier cases,
   and add one case for a reply that opens with a list.

3. **The page subtitle no longer names Automations.**
   Observed in every web capture at x 372-571, y 59 and in every native
   capture at y 280 (1206 px scale): "Past answers, saved items and usage".
   Source: `ChatHeader.tsx:6`, `DiscoveryViews.swift:156`. Round 1 asked to
   add usage, not to replace automations. The third tab is named Automations
   and holds Pause and Resume, so the header now leaves out the one tab with
   mutating controls.
   *Fix:* Use "Past answers, saved items, automations and usage" on both
   clients, or "Past answers, saved items and automations" since the tab hint
   already mentions 30-day usage.

4. **A failed save or a history error appears where the reader can't see it.**
   Code only, not captured. The success state is now in place, but the error
   still renders above the history section (`DiscoveryPanel.tsx:112`; native
   `DiscoveryViews.swift:80`). Search hits and saved replies open centered on
   a reply, so the reader is scrolled away from the top. If Save fails there,
   the button returns to "Save reply" and the reason is off screen. Paging
   errors behave the same way.
   *Fix:* While history is open, render the error FormMessage inside
   `.history-heading` on web and inside `historyToolbar` on native, so it
   stays pinned with Back. The success notice can stay where it is or be
   removed, since "Saved" in place already confirms the save.

5. **Native Save reply competes with the content.**
   Observed in `native-History.png` x 316-643, y 1129-1269 and x 352-679,
   y 1729-1869. Save reply is a large brand-tinted capsule, the same style as
   Back to results and Search. It appears on every assistant reply, so a long
   history becomes a column of green pills, and each one outweighs the
   speaker name next to it. Web uses a neutral outlined button
   (`conversation-history-1440.png` x 569-655, y 431-474), which reads as
   secondary. Source: `DiscoveryViews.swift:362`.
   *Fix:* Keep the 44 pt target but use a neutral tint, such as
   `.tint(Palette.muted)` with `.controlSize(.regular)`, or a bookmark icon
   with the text label. That matches web and keeps Back as the only tinted
   control in the history view.

6. **Small polish items.**
   - Meta lines leave single words on their own line at 390. Observed: "AM"
     in `search-results-390.png` x 24, y 329, "ago" in `saved-items-390.png`
     x 24, y 395, and "failed" in `automation-paused-390.png` x 16, y 312.
     Fix: wrap each `·` segment in a `white-space: nowrap` span. For the
     routine row, put "Last result" on its own line as native already does
     (`native-Automations.png` y 1235).
   - Web Save can show "Saving…" after a return trip. Code only. If the
     reader taps Save reply and then Back before the request finishes,
     `reset()` makes `current()` false, so `savingKey` is never cleared and
     the pin is never recorded (`DiscoveryPanel.tsx:92-101`). Reopening that
     history shows "Saving…" on a reply that the server did save. Fix: clear
     `savingKey` in `back()` and `changeTab()`, or clear it and record the
     pin without the `current()` guard. Both are local UI state, and the
     component remounts per user.
   - The web speaker fallback prints raw lowercase roles. Code only.
     `DiscoveryPanel.tsx:107` returns `message.role` for `system`, and for
     `tool` when there is no `toolCall`. The `text-transform: capitalize`
     that used to hide this was removed. Native capitalizes. Fix: map these
     to "System" and "Tool".
   - The routine state chip differs between clients. Web shows a bold
     "Enabled" and a chip only for Paused (`automation-paused-1440.png`
     x 558-619, y 249-270). Native shows a chip for both states
     (`native-Automations.png` x 359-545, y 1062-1115). Either pattern works.
     Pick one.
   - Optional: the usage table splits tokens onto two lines, which doubles
     each row's height. Seven rows reach y 1000 in `automations-1440.png`.
     "1,200 in · 400 out" on one line, with right-aligned number columns,
     would roughly halve the table height.

## Settled from round 1

These are verified and need no more review unless their code changes.

| Round 1 item | Status | Evidence |
| --- | --- | --- |
| 1 Raw `delivery_failed` | Fixed both clients; unknown values pass through | `automations-1440.png` y 283 in danger color; `discovery.ts:21`; Swift switch; tests |
| 2 History context | Fixed: title, assistant, You/named sender, assistant name | `conversation-history-1440.png` y 171-200, 335, 452, 793; `native-History.png` y 400-580 |
| 3 Save feedback and affordance | Fixed: outlined 44 px button, in-place Saved, re-enabled after Remove | `reply-saved-1440.png` x 569-631, y 545-588; measured 4.96:1 text contrast |
| 4 Reply vs conversation, saved date | Fixed both clients | `saved-items-1440.png` y 281, 355; `native-Saved.png` y 995, 1218 |
| 5 Search destination and date | Fixed; `updatedAt` decoded on native | `search-results-1440.png` y 305, 402, 500; `native-Search.png` y 1053, 1318 |
| 6 Back scrolls away | Fixed on native; web works but see issue 1 | `history-bottom-*`; `native-History.png` |
| 7 Paused wording and weight | Fixed | `automation-paused-1440.png` y 259-285; chip text 4.96:1 |
| 8 Native Remove primary | Fixed: destructive role, borderless, swipe action | `native-Saved.png` x 929-1107; swipe is code only |
| 9 Usage undiscoverable, too tall | Fixed hint and desktop table; phone stack kept | `automations-1440.png` y 187, 540-1000; `automation-usage-390.png` y 495-844 |
| 10 Polish | All five fixed | Custom muted clear x 1208, y 193; "Ranch hand" on hits; no Tool label above receipt; underscores kept; nav label |

## Preserve

- Stale guards: `searchSeq` and `searched` on web, `SearchRequests` and
  `searchedQuery` on native, and `historyRequest` plus scope checks. Back now
  runs `reset()` on web and clears `historyRequest` on native, so a late
  history response can't reopen the page. Keep both.
- Exact message pointers. Saved replies open centered on the target, and
  "history changed" errors appear when the target is gone. The 404 fallback
  applies to search hits only.
- Live hits open the real conversation. Read-only history leaves the live
  session alone.
- Pinned state seeded from the Saved list, cleared on Remove, and keyed on
  bot, session and message.
- Explicit Pause and Resume followed by a refetch. "Unknown" cost, and
  "(partial)" only next to a reported number, in both the table and the
  stack.

## Coverage

Observed in captures: web search with three destination kinds, history at the
target reply and at its end, the in-place Saved state, Saved items with reply
and conversation rows, enabled and paused routines with a failure, and the
usage table and stack, all at 1440 and 390. Native Search, Saved, Automations
and a long History page with the pinned heading.

Code only: the save error path, the Back-during-save race, the system and tool
role fallback, native swipe-to-remove, focus returning to the active tab, and
re-enabling Save after Remove.

Not exercised, and not scored as defects: native interaction and the new
native unit cases, which did not run on this host; empty, no-results and
unavailable-assistant search states; history pagination; real providers,
scheduling, delivery and cost accuracy; clipboard; VoiceOver, dark mode and
large text. The fixed Oct 3 schedule, the generic native recipient and the
24-hour native times reflect fixture data and simulator locale, not product
defects.

## Path to 9

Fix issues 1 through 4. They are a CSS offset, a title helper shared by two
clients, a one-line subtitle, and moving the history error into the pinned
heading. That should clear the bar. Issue 5 and the nowrap and "Saving…"
items in 6 are small enough to land in the same pass. The chip parity and
usage density items are optional.
