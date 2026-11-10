# November 10 a streaming delta stops re-reading the whole loaded transcript

Branch `t3/window-work-memo`. The change and the before measurements were made from `origin/main` at
`f0ae0a5`; the branch was then moved onto `3f8235d` (#311, which touches the composer, keyboard and
scroll code, not these derivations) before it was published. The checks and one confirming measurement
ran at the commit that carries this entry, on NicolasLaptop (Fedora 44, Linux x64, Node 24.22.2),
Chromium from Playwright's bundled build. No server, Python, iOS or Hermes code changed.

## What main did on each delta

`useConversation`'s `patch` keeps every saved message object and swaps only the live row, but
`Conversation` keyed its derivations on the whole conversation object, so each delta re-ran over every
loaded message:

- `turns()`: `withMessageOrigins` (the origin regexes on user rows), then the grouping into turns. Every
  turn came back as a new object, so each `TurnView`'s `sameTurnProps` compared the turn field by field.
- `replyArtifacts` twice (the `candidates` flag and `windowReplyArtifacts`), each with its own
  `withMessageOrigins` and `conversationArtifacts`.
- `draftRevisions`: `replyCardsFromText` on every assistant row, which `JSON.parse`s every `agent-ui`
  block. It returned a new map, and that map is the `DraftRevisions` context, so every email card in
  the window re-rendered past the row memo.

No tool result is parsed on a delta. The brief's "a `JSON.parse` of every tool result" is not what main
does: the `JSON.parse` calls per delta were the reply-card blocks in `draftRevisions`.

## Change

`src/app/transcript-window.ts` splits the window at its first live row (`isLiveRow`, an ID ending in
`-inflight`). `useSettledWindow` returns the same `settled` array while it holds the same message objects
in the same order. The turns, the chips and the revisions are each read once over `settled`, and
`continueOrigins`, `continueReplyArtifacts` and `continueDraftRevisions` continue those reads over the
live rows. A turn that neither the live rows nor the running turn's calls change keeps its object, so
`TurnView`'s comparison ends at `a === b`. The revisions map keeps its identity while the live rows hold
no email card. A live row with files reads the whole window again, because its files can change which
files the conversation lists. `windowReplyArtifacts`' guard moved to `unknownEarlierFiles`, which both
use.

The cache key is the identity of each settled message object, position by position. A stale entry
cannot be served:

- An edit or redaction arrives in a read or a turn event. Both build new message objects (JSON), and
  nothing in the client changes a message in place (`grep` for writes to `.text`, `.messages` and
  `.toolCall` fields finds only the turn builder's own arrays). A new object at any position ends the reuse.
- A replacement after a reconnect is a read, so every object is new, even where the content is equal.
  That costs one full reading per read, which is what main paid on every delta.
- Two messages with the same text are two objects with two IDs. Text is never part of a key.

## Measurements

`.agents/tools/streaming-preview.ts` gained `SEED_TURNS`: 80 finished turns, each a prompt, a progress
line, three tool calls with 16 KB JSON results, and a reply; every fourth reply holds an email draft
revising the one before, and every sixth turn's tool makes a file. The probe, kept in
[`../evidence/2026-11-10-window-work/`](../evidence/2026-11-10-window-work/) and never committed to
`src`, aliases `react-dom/client` to `react-dom/profiling`, wraps `Conversation` in a `<Profiler>`, and
counts each derivation's calls and the messages it reads. `probe-before.patch` applies to `f0ae0a5`,
`probe-after.patch` to this commit; copy `probe.ts` to `src/probe.ts`, `PROBE=1 npm run build`, then
`run-measure.sh <label> <FULL> <CPU>`. Each run opens Ranch Hand, loads the whole history when `FULL=1`,
sends, waits for the answer to start, and records 5 seconds of streaming. A delta commit is one in which
`Conversation`'s own body ran; the other commits are the reveal pacing inside the live row. The server
batches deltas to about 4 a second. Raw output: `results.json`.

A first probe also timed each `sameTurnProps` call with `performance.now()`; under 4x throttling the
timer cost as much as the comparison, so that timer was removed and these numbers are from probes
without it.

Delta commit duration, median of each run (p95 in brackets), in ms:

| Window | CPU | Before (`f0ae0a5`) | After |
| --- | --- | --- | --- |
| 485 messages (241 rows shown) | 4x | 8.8, 9.6, 9.1 (12.1, 13.2, 11.6) | 3.7, 4.2, 4.5 (4.7, 5.9, 6.0) |
| 485 messages | 1x | 2.2, 2.2, 2.2 (3.6, 3.6, 3.2) | 0.9, 0.7, 0.8 (1.4, 1.1, 1.5) |
| 124 messages, first page (60 rows) | 4x | 4.8, 5.0, 4.6 (6.1, 6.5, 9.0) | 3.0, 2.7, 2.7 (4.7, 3.8, 3.7) |

After moving onto `3f8235d`, two more runs of the 485-message, 4x case: 3.9 and 3.9.

Per second while the reply streams, 485 messages (the counts do not depend on the throttle):

| | Before | After |
| --- | --- | --- |
| `Conversation` body runs | 4.2 | 4.2 |
| Messages read by `withMessageOrigins` | 5,820 | 12 |
| Messages read by the turn grouping | 1,940 | 4 |
| Messages read by `replyArtifacts` | 3,880 | 8 |
| Messages read by `draftRevisions` | 1,940 | 4 |
| `JSON.parse` calls (4 are the stream's own events) | 84 | 4 |
| Email cards re-rendered | 80 | 0 |
| Time in the derivations, ms (4x) | 8.0 to 8.7 | 1.2 to 1.5 |

The reveal-pacing commits are unchanged (median 1.3 to 1.6 ms at 4x). The settled readings did not run
again during any 5-second window. What is left of a delta commit is the live turn's own render and
React visiting each memoized turn.

## Application tests

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/transcript-window.test.ts tests/live-reply-ui.test.ts tests/reply-artifacts.test.ts
  tests/draft-diff.test.ts tests/message-origin.test.ts tests/transcript-ui.test.ts`: 6 files, 199 tests passed.
- `npm test`: 184 files, 3,060 tests passed.
- `npm run build` passed, then `npm run test:e2e`: 20 Chromium tests passed. The first attempt found
  ports 4173 and 4174 held by another worktree's run, so it ran again once they were free.

New tests:

- `tests/transcript-window.test.ts` holds each continuation to the whole window's answer at every split
  point: turns over a fixture with an agent message, a scheduled delivery, a running saved call, a reused
  tool ID and a new call, in Simple and Advanced; chips over every case in the shared
  `reply-artifacts.json` vectors, which put files in the live rows at some splits; revisions over every
  `draft-diff.json` lineage case. It also checks that untouched turns keep their objects, that a live
  call finishing a saved running call folds the work again, and that the revisions map is kept, or copied
  without changing the settled one.
- `tests/live-reply-ui.test.ts`, "the saved rows while a reply streams", runs the whole app against a
  fake `fetch` and event stream: ten deltas parse none of five saved email drafts; a read that edits the
  earlier draft under the same ID changes the live draft's mark from "Revises" to "Same as"; a read that
  redacts a reply removes its row and its file chip and keeps another reply with the same words.

## Mutants

Each line was broken by hand, its focused test file run, and the source restored.

| Mutation | Test | Result |
| --- | --- | --- |
| Revisions read over the whole window each render (main's behavior) | live-reply-ui "reads the saved drafts once" | failed: 50 card parses |
| Settled window compared by message ID, not object | live-reply-ui | 8 failed, including "marks a live draft…" and "drops a reply a read redacts…" |
| Live rows read without the settled provenance | transcript-window "turns … at every split" | failed |
| A live row with files continues instead of reading again | transcript-window "chips … at every split" | failed |
| Turns continued from the shown turns, not the read ones | transcript-window, 2 tests | failed |
| An untouched turn returned as read, not as shown | transcript-window "turns … at every split" | failed |
| Revisions written into the settled map | transcript-window "keep their map…" | failed |

## Not run

Safari, Firefox and a real phone: not run. CPU throttling in Chromium stands in for a slower device.
`useRoutineRuns`' `deliveredRuns` and App's per-delta work (`withEchoes`, `latestMessageAt`) still read
the window on each delta; the preview has no routine runs, so they were not measured, and they are
outside the conversation view this change covers.
