# November 12 an earlier page reads only what comes before

Branch `t3/4fbe4b74` over `265f36d`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2, Python 3.14.10. Source
fingerprint of `src tests .agents/tools docs/native-api.md` with the change applied:
`sha256:44d79507dbd658a38a255f5d9c7d63782a15153df8794a9e2b5d1958d6ef0d53` (719 source files). No Hermes process ran
and nothing was deployed.

## Defect

Each earlier-page read on the web (`start=<oldest loaded>&turns=20`) returned everything from the new start to the
newest message: 2.2, 3.0 and 4.2 MB for `patch`'s first three pages, measured on production before this change. The
add-on cut the same tail and sent it over the Hermes socket.

## Change

- `GET /bots/:id/conversation?before=MESSAGE_ID&turns=N` answers only the `N` turns before that message, with their
  own files, each once, and `earlier` and `earlierFiles` counted from the page's start. The answer names the message
  in `before`. A message the history no longer has answers the latest page without `before`, as an unknown `start`
  does, and `before` with `start` is a 400. Without `before` nothing changed, so the iOS app and cached web bundles
  read as before.
- `history_window` in `src/hermes/extension.py` takes `before` and ends the window there, naming it in `app_window`;
  the open handler passes `window.get("before")` (a one-line change outside `history_window`). The server also sends
  `start`, so an add-on without this change cuts from the same place to the end and the server ends the page itself.
- The runtime gives a page no live reply, stores nothing live replies are built on, and never shares it as the read
  from its first message, which must reach the newest.
- The web client asks for `before` and puts the page in front of the message it was asked before (`prependPage`),
  keeping its own reads' live state, version and draft. The window's start moves to the page's first message, so
  later reads keep the whole window as before, and the reader's place is held as before. A page it cannot place,
  because the view no longer holds that message, is read again the old way, with everything after it.
- `earlierFiles` after a page counts files only messages before the page carry, which can include a file a later
  message the client already holds passes on again. The next read of the whole window corrects it.
- `docs/native-api.md` describes the query.

## Measurement

Real app and Hermes runtime over the fake socket, whose `history_window` mirror cuts as the add-on does, with 440
turns of about 30 KB each; a first page, then three earlier pages, each followed by a read of the whole window:

| Query | Page 1 | Page 2 | Page 3 |
| --- | --- | --- | --- |
| `start=&turns=20` (before) | 1.13 MB, 11 ms | 1.70 MB, 14 ms | 2.27 MB, 19 ms |
| `before=&turns=20` (after) | 0.57 MB, 7 ms | 0.57 MB, 7 ms | 0.57 MB, 7 ms |

The read of the whole window after each page is the same size either way (1.13, 1.70, 2.27 MB). A change notice or
the two-minute poll on a chat scrolled back still reads the whole loaded window; that is unchanged here, because each
such read refreshes redaction, sender attribution and retries across everything shown.

## Tests and red runs

- `tests/app.test.ts`: the window parity test answers `before` pages identically whether the runtime ends the page or
  the server does (four new shapes: mid-history, before a reply, reaching the first turn, a lost message), with each
  page's messages, files and counts; a `before` read over a whole history; `before` with `start` refused.
- `tests/live-turn-runtime.test.ts` "an earlier page": no live reply or snapshot from a page, the add-on asked with
  `start` beside `before`, and no sharing with the read from its first message.
- `tests/hermes_extension_journal_test.py`: `history_window` ends at `before` and names it, counts back from it
  rather than `start`, still names it when it reaches the first turn, ignores one the history lost; an open passes it.
- `tests/prepend-page.test.ts` (new), `tests/connection-ui.test.ts` (the earlier-page path and order, and the read
  made whole when the view lost the message), `tests/live-reply-ui.test.ts` (the fake server answers `before`).

Each mutation by hand, restored after, against the suites named above:

| Mutation | Result |
| --- | --- |
| start and before together allowed | failed: windows conversation history only when the web client asks |
| a runtime's own end ignored | failed: answers a window Hermes already cut exactly as it answers its own cut |
| page not ended | failed: answers a window Hermes already cut… (2 tests) |
| files counted past the page | failed: answers a window Hermes already cut… |
| every window file sent | failed: answers a window Hermes already cut… |
| a page's files repeated | failed: answers a window Hermes already cut… |
| live reply on a page | failed: ends just before the message the client holds, with no live reply… |
| a page stores the snapshot | failed: ends just before the message the client holds… |
| a page shared as the read from its start | failed: is never shared with a later read from its first message… |
| older add-on gets no start | failed: ends just before the message the client holds… |
| the add-on's end not reported | failed: ends just before the message the client holds… |
| earlier page reads everything after too | failed: loads recent turns first and holds the reader in place… (2 tests) |
| page shown as the whole window | failed: keeps the live node and its selection when an earlier page of history loads above (3 tests) |
| unplaceable page dropped | failed: reads an earlier page whole when what the view holds no longer starts at the message… |
| view's messages before the anchor kept | failed: drops whatever the view holds before that message… |
| page files repeated (client) | failed: puts the page's messages before the one it was read before… |
| view's earlier counts kept | failed: puts the page's messages before the one it was read before… (2 tests) |
| placed without the anchor | failed: places nothing when the view no longer holds that message (2 tests) |

`python3 .agents/tools/mutate-py.py --batch` against `python3 scripts/run-python-tests.py tests/hermes_extension_journal_test.py`:

| Mutation | Result |
| --- | --- |
| before ignored | failed: test_a_page_before_a_row_ends_there_and_says_so (exit 1) |
| counts back from start, not before | failed: test_a_page_before_a_row_ends_there_and_says_so (exit 1) |
| page not ended | failed: test_a_page_before_a_row_ends_there_and_says_so (exit 1) |
| a page from the first turn returns everything | failed: test_a_page_before_a_row_ends_there_and_says_so (exit 1) |
| the window does not name its end | failed: test_a_page_before_a_row_ends_there_and_says_so (exit 1) |
| open passes no before | failed: test_an_open_ends_a_page_where_the_server_asks (exit 1) |

## Checks

`npx vitest run`: 211 files, 3839 tests passed. The journal Python tests pass. The full battery runs once for the
branch. Not exercised: real Hermes, production, a browser, and iOS. The iOS app
(`ios/AgentInterface/AppStore+Conversation.swift` `loadEarlier`) reads `start=&turns=` the same way and would benefit
from the same change; it works unchanged against this server and is left as it is, since its validation needs the Mac.
