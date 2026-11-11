# November 11 the "replied" announcement reads a reply saved as several rows

Branch `t3/announce-whole-reply` over `origin/main` at `23e758b`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Web client only. The iOS app has its own copy of this logic (`ReplyWatch` in `ios/AgentInterface/ConversationView.swift`),
which did not change and did not run.

## What changed

`watchReplies` (`src/app/reply-announcement.ts`) took the last speakable saved row after the last message seen as the
reply. A turn that saves text, a tool call and more text as separate rows was announced as its last row only.

- The reply is now every speakable saved row of the newest turn that arrived since the last message seen, joined with a
  blank line. `replySnippet` still cuts the joined text at 200 characters, as it cut one row. The reply keeps the id of
  its last row, which `use-conversation.ts` and the existing tests read.
- A reply held while the assistant is still working keeps its last row (`waiting`, as before) and the words of the rows
  before it (`waitingBefore`). A later read in the same turn adds its new rows after them, so a segment that arrives
  while the assistant is working is no longer lost. The held row is read again from the conversation each time,
  because Hermes rewrites a saved row under one id as its text streams in. A held reply from an earlier turn is dropped
  when a new turn's reply arrives.
- What was already read is compared on the joined text, without whitespace, because the live copy and the saved rows
  separate the same words differently. `afterHeard` finds the last run of rows that spells the heard words (the whole
  reply, its tail or its head) and announces only the rows after it, or nothing. Before, the heard text was compared with
  the last row alone, so a reply read live as one text and then saved as several rows was read a second time.

Not changed: while a saved row is held and the next read shows a new unsaved tail, the unsaved tail still replaces the held
row, as before.

## Tests and red proof

`tests/reply-announcement.test.ts` (15, new): a two-segment reply with a tool row and a progress line between; the length
limit applied after the join; two turns between reads; the id kept; a whole reply heard live and then saved as rows
(silent); a head heard (only the rest); a tail heard (silent, as before); other words and the same words from an earlier
turn heard (read in full); a held segment joined with a later read's segment; segments across several reads read once;
a held segment alone when nothing is added; a held row that grew in place, alone and followed by a new segment; a held reply from an earlier turn dropped. Each line broken by hand, the new
file, `tests/message-origin.test.ts` and `tests/app-ui.test.ts` run, then restored:

- the join cut back to the last row: 7 failed.
- the turn bound removed from the row range (`known + 1`): 1 failed (two turns between reads).
- no held rows joined: every join case failed.
- the held rows' turn check weakened to `indexOf(heldRow) >= 0`: 1 failed.
- the held row's earlier rows (`waitingBefore`) dropped, or not carried in the watch: 1 and 2 failed.
- the held row no longer read again from the conversation: 4 failed, among them the existing
  `tests/app-ui.test.ts` "waits for the assistant to stop working and reads the finished text, not each stage". A first
  version of this change dropped that refresh, and the full run caught it; the two growth tests above were added for it.
- `afterHeard` replaced by a whole-text comparison: 2 failed (head heard, tail heard).
- the heard turn check removed: 1 failed.
- whitespace no longer ignored in the comparison: 1 failed (the whole reply heard live).

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 202 files, 3443 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 29 passed. An earlier full run of this branch failed the existing
`app-ui` announcement test, described above; it passed after the fix.
