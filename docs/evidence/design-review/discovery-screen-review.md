# Search, saved items, history and automations: whole-area review, round 1

Reviewer: Claude Opus 5.5, high reasoning effort requested through target
options, Anthropic. OpenAI implemented the work (Sol and Terra). Round 1 of at
most 3. This review gives one score for the whole Search & saved area. It does
not grade each capture.

Reviewed commit: `11f01b67c19890479cd7f607d294967e4f8e4c86` on PR #207.

Screenshots: `/Volumes/DevSSD/scratch/wildbots-design-review/discovery-screen-r1/`.
Web coordinates are CSS pixels in the 1440x1000 and 390x844 captures. Native
coordinates are pixels in the labeled `native-discovery-overview.png`
(1240x915), which is legible at that size for everything cited here.

Sources read: `src/components/DiscoveryPanel.tsx`, `src/components/discovery.css`,
`src/shared/discovery.ts`, `ios/AgentInterface/DiscoveryViews.swift`, plus
`src/server/discovery.ts`, `src/server/store-personal.ts`, `src/time.ts`,
`src/app/ChatHeader.tsx` and `src/server/hermes-operation-contracts.ts` where a
claim needed checking. The capture-only Debug code was not reviewed.

## Score: 8.2 / 10, not yet passing

The area works and stays honest. Incremental search drops stale answers on both
clients. History states that it is read-only and leaves the live conversation
alone. Saved items describe themselves as pointers that can go stale. Pause and
Resume are explicit buttons. Usage shows "Unknown" instead of inventing a cost,
and the footnote says what the numbers leave out. Layout holds at 390 px, the
tab control fits, and touch targets reach 44 px on phone web.

The score is held down by what the screens fail to tell the reader. A raw
status enum is the most prominent fact on the routine row. History opens with
no title, assistant, or speaker names. Save confirmations land off screen on
phone. A saved reply and a saved conversation look identical. Search results
don't say where a tap will take you. None of these needs new data. Each fix
uses fields both clients already receive.

## Issues, most important first

1. **Routine status shows a raw enum: "Last result: delivery_failed".**
   Seen: `automations-1440.png` x 608-724, y 279; the same in
   `automation-paused-*`, `automation-usage-*` and every 390 capture at y 284.
   Native overview x 965-1133, y 417. Source: `DiscoveryPanel.tsx:80` prints
   `row.lastStatus` as-is, and `DiscoveryViews.swift:125` does the same. Hermes
   sends `job.last_status` verbatim (`src/server/hermes.ts:792`). This is the
   first status a person reads on a failed routine, and it reads like a log
   line.
   *Fix:* Map known values to plain words with the existing
   label-map-plus-fallback pattern (`AutomationPanel.tsx:142,151`), for
   example `delivery_failed` to "Delivery failed", `ok` or `success` to
   "Succeeded", `error` to "Failed". Show unknown values verbatim so nothing is
   hidden. Mirror the map in Swift. If the status is a failure and an error
   line follows, color the status with the danger tone so the two read as one
   fact.

2. **History opens with no context: no conversation title, no assistant, no
   speaker names.**
   Seen: `conversation-history-1440.png` y 231 says only "Conversation
   history". Speakers are labeled "User", "Assistant" and "Tool" at y 343,
   443, 670, 789 and 867. On phone, `conversation-history-390.png` scrolls to
   the saved reply, so the reader lands mid-thread with no heading in view.
   Native uses the same generic section header and role labels
   (`DiscoveryViews.swift:79,275-277`). Source: `DiscoveryPanel.tsx:73,75`.
   The server already attaches `sender.name` for app users
   (`src/server/discovery.ts:51`), and both clients look up the assistant name
   elsewhere in this panel.
   *Fix:* Use the hit or saved-item title as the heading, with "Ranch hand ·
   read-only history" under it. Fall back to "Conversation history" only when
   no title is known. Label user messages with `message.sender?.name`, or
   "You" for the signed-in user, and assistant messages with the assistant
   name. Keep "Activity" and "Scheduled" as they are.

3. **Saving inside history gives feedback where the reader can't see it.**
   Seen: "Save reply" at `conversation-history-1440.png` x 555-611, y 443 and
   `conversation-history-390.png` x 99-155, y 327 is 12 px muted text with no
   border, placed next to the role label, so it reads as metadata rather than
   an action. Code: the "Saved. Find it in Saved items." notice renders at the
   top of the panel (`DiscoveryPanel.tsx:72`), above the history. On phone the
   panel has scrolled the target reply to center (`DiscoveryPanel.tsx:69`), so
   the confirmation lands off screen. Native puts `notice` in its own section
   above history (`DiscoveryViews.swift:76`), so a long page hides it there
   too. Not seen: no capture shows the after-save state. The capture log
   saved one conversation per viewport. The button never changes, so tapping
   twice gives no sign that the first tap worked. The server dedupes
   (`store-personal.ts:54-56`), so a repeat tap is harmless, but the person
   can't tell that.
   *Fix:* Give the per-reply save the same outlined small-button treatment as
   "Save conversation", or an icon button with a text label. After success,
   change that button to "Saved" in place and disable it for the page.
   Keep the top notice for errors. Apply the same in-place state to "Save
   conversation".

4. **Saved items can't tell a saved reply from a saved conversation.**
   Seen: native overview x 452-600, y 411-432 shows "Brisket reply" labeled
   "Ranch hand · Conversation". Web rows at `saved-items-1440.png` y 234-260
   show only the title and "Conversation". Source: `DiscoveryPanel.tsx:79` and
   `DiscoveryViews.swift:107` choose between "Routine output" and
   "Conversation" only. A pointer with `messageId` opens at one highlighted
   reply, which is a different promise from a whole conversation. No row shows
   when it was saved, although `createdAt` arrives with every item.
   *Fix:* Label `kind === 'session' && messageId` as "Reply", and keep
   "Conversation" and "Routine output". Add the saved date with `When` in the
   same meta line, for example "Ranch hand · Reply · Saved Tuesday". Do the
   same on native.

5. **Search results don't say where a tap goes, or how recent they are.**
   Seen: `search-results-1440.png` y 270-340 and native overview y 350-500
   render every hit as title, assistant and snippet with a chevron. Source:
   `DiscoveryPanel.tsx:78` sends a tap to one of three places: routine output,
   the live conversation (`live(hit)`, line 51), or read-only history.
   `DiscoveryViews.swift:215-223` branches the same way. The reader can't tell
   whether a tap opens the chat they can reply in or a read-only archive. The
   Hermes contract carries an optional `updatedAt` per hit
   (`hermes-operation-contracts.ts:40-41`, `shared/discovery.ts:2`), and
   neither client shows it. The native `SearchHit` struct doesn't decode it
   (`DiscoveryViews.swift:4`).
   *Fix:* Add a short kind word to the meta line: "Current chat", "Past
   conversation" or "Routine output", derived from the same branch the tap
   uses. Render `updatedAt` with `When` when Hermes sends it, and show
   nothing when it doesn't. Decode the field on native.

6. **On phone, the only way back to results scrolls away, and the visible back
   button leaves the area.**
   Seen: `conversation-history-390.png`. "Back to results" has scrolled off
   above y 69 because the page centers the saved reply. The chevron at x 30,
   y 33 is the app header's "Back to assistants" button
   (`src/app/ChatHeader.tsx:30-31`). Code: leaving the `find` view unmounts
   `DiscoveryPanel` (`App.tsx:243`), which drops the query and results held in
   local state. Not seen: no capture taps that button. A person who reads to
   the bottom and taps the obvious chevron loses their search.
   *Fix:* Make the history heading row with "Back to results" sticky at the
   top of the panel scroll area on web (`position: sticky; top: 0` with the
   panel background). Native already puts Back first in the section, so a
   pinned toolbar item or `.safeAreaInset(edge: .top)` would match.

7. **A paused routine reads like a scheduler problem, and its state has no
   visual weight.**
   Seen: `automation-paused-1440.png` y 257-279 shows "Ranch hand · Paused"
   then "No upcoming run reported". The second line suggests Hermes failed to
   report something, when the person paused it on purpose. Enabled vs Paused
   is muted body text at the same weight as the assistant name, in both
   states. Source: `DiscoveryPanel.tsx:80`, `DiscoveryViews.swift:124-125`.
   *Fix:* When `enabled` is false, say "Paused. No runs until you resume."
   Keep "No upcoming run reported" for enabled routines with no `nextRunAt`,
   where it is accurate. Give the status a small status chip or bold token,
   matching how the Routines screen marks Active and Paused, so the state
   scans before the details.

8. **Native Remove looks like a primary action.**
   Seen: native overview x 714-788, y 337-365 and y 406-434. Remove is a green
   tinted capsule, the same treatment as Search and View outputs. Web keeps it
   as quiet muted text at `saved-items-1440.png` x 1244-1292, y 246. Source:
   `DiscoveryViews.swift:109-110` uses `.bordered` with no role. Neither client
   confirms or offers undo. A removed pointer is cheap to recreate when its
   source is still at hand, so confirmation would be heavier than the risk.
   *Fix:* Use `Button("Remove", role: .destructive)` and add a
   `.swipeActions` delete, which is what iOS users try first. An undo toast is
   optional.

9. **Usage sits under Automations without being announced, and repeats one
   block per assistant.**
   Seen: `automations-1440.png` y 472-1000. Usage takes most of the tab. Its
   footnote says it covers main-session usage, which isn't automation usage.
   The tab hint at y 187 ("Upcoming work, recent failures and who receives
   results.") and the page subtitle ("Past answers, saved items and
   automations") don't mention usage. Six identical three-line blocks push
   later assistants below the fold at 1440. Native groups usage in one card
   (overview y 581-669), which scans better.
   *Fix:* Lowest-cost option: add "and 30-day usage" to the tab hint and the
   page subtitle. At 1440, render usage as a compact table with columns for
   assistant, sessions, tokens, reported cost and estimate, and keep the
   stacked rows under 600 px. Keep the "Unknown" and "(partial)" wording
   exactly as it is.

10. **Small polish items.**
    - The search field's clear button is Chromium's default blue at
      `search-results-1440.png` x 1209, y 193 and `search-results-390.png`
      x 279, y 178. It is the only blue in the area. Style
      `::-webkit-search-cancel-button` with the muted ink, or hide it and use
      a styled clear button.
    - The same assistant is "Ranch" on search hits and "Ranch hand" in Saved
      and Automations (`search-results-1440.png` x 484-520, y 305 vs
      `saved-items-1440.png` y 259). Hits use `hit.botName`, while the other
      tabs look the name up in bootstrap. The fixture may cause this gap, but
      using the bootstrap lookup with `botName` as fallback gives one source
      of names.
    - History says "Tool" above a receipt that already starts "Tool finished
      ·" (`conversation-history-1440.png` y 670-714). Drop the role label for
      tool-call rows.
    - Reply titles replace `_` with spaces (`DiscoveryPanel.tsx:75`,
      `DiscoveryViews.swift:174`), so a saved reply about
      `binary_sensor.north_gate` becomes "binary sensor.north gate". Strip
      only markdown emphasis pairs, or leave underscores inside words alone.
    - The tab `nav` is labeled "Search and saved" (`DiscoveryPanel.tsx:71`)
      and leaves out Automations. "Search, saved items and automations"
      matches what it holds.

## Preserve

- Stale-response guards: `searchSeq` with `searched` on web, and
  `SearchRequests` with `searchedQuery` on native.
- Read-only history and its statement, the 404 fallback for search hits only,
  and the "history changed" error for saved replies.
- Live-session hits opening the real conversation at the message.
- Saved items as pointers with server-side dedupe, and the "Removed originals
  may be unavailable" line.
- Explicit Pause and Resume, followed by a refetch.
- "Unknown" cost, "(partial)" only beside a reported number, and the
  unavailable-assistants count.

## Coverage

Seen in captures: web search with one hit, read-only history at the saved
reply, Saved items, enabled, paused and resumed routine, and usage, each at
1440 and 390. Native Search, Saved and Automations from Debug fixtures.

Code only: save feedback placement, the phone back-button path, the live,
history and routine tap branches, and the dedupe on save.

Not seen, and not scored as defects: search empty, no-results and
unavailable-assistant states; history pagination and file attachments beyond
one link; native history, native paused state and any native gesture or
keyboard path; real provider search, scheduling, notification delivery and
cost accuracy; VoiceOver, dark mode and large text. Fixture timestamps, the
Oct 3 next run, canned hit relevance and the duplicate phone Saved rows were
not treated as product evidence.

## Path to 9

Issues 1 through 5 carry the score. Each is a labeling or placement change
that uses data already on the client, so it should not need API work. Fixing
those five on both clients, plus 6 and 7, should clear the bar. Items 8 to 10
are worth doing in the same pass if they stay small.
