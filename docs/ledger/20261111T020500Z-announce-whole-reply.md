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

## Review fix: a last segment that is still streaming

Merged `origin/main` at `2f1670e` first, as its own commit. Review found that a read taken while the last segment was
still streaming (`src/server/hermes.ts` adds the streaming row to a conversation read while the assistant works)
dropped the held row and every row before it. Held "Intro.", a tool, "Answ" streaming, then saved "Answer." read only
"Answer."; a turn that finished with its last segment unsaved read only that segment.

`watchReplies` now builds `held` from `waitingBefore` whether or not the held row was saved, and adds the held row's
own text only when it is saved. In the unsaved branch `before` is the held parts and the turn's saved speakable rows
after the last one seen, and `waitingBefore` carries them while the assistant still works. The held reply is dropped
when the newest turn is not the one it belongs to, so the watch records that turn (`waitingTurn`) in place of the old
row-position check, which could not place an unsaved row that had left the conversation. The newest turn is the unsaved
tail's, or else the newest saved row's.

### Tests and red proof

`tests/reply-announcement.test.ts`, "while its last segment is still streaming" (5): the held segment kept when the saved
last segment replaces the streaming one; kept through reads that see it grow, with a saved row and a new tail between;
the finished turn with an unsaved last segment, read once and not again when it is saved; saved rows ahead of a tail no
read held; a held segment of an earlier turn dropped when the next turn's tail streams. Run against the committed code,
four of the five fail (the fifth, the earlier-turn drop, already held). Each line broken by hand, the new file,
`tests/message-origin.test.ts` and `tests/app-ui.test.ts` run, then restored:

- `before = parts` in the unsaved branch replaced by `[]`: 4 failed.
- the held turn check replaced by `watch.waiting`: 2 failed (earlier turn dropped, saved and streaming).
- `waitingTurn` not carried: 6 failed.
- `newest` ignoring the unsaved tail: 2 failed, plus the existing `app-ui` "reads an identical reply in the next turn".
- `parts` needing an arrived saved row: 2 failed.
- the held row's text added whether or not it is saved: 2 failed, plus the existing `app-ui` "reads the finished reply
  when Hermes swaps its in-flight row".
- `waitingBefore` not carried in the watch: 4 failed.

### Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 203 files, 3537 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 38 passed. The iOS copy of this logic did not change and did not run.
