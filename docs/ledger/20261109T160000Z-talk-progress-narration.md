# November 9 live Talk reads progress lines aloud

Branch `talk-progress-narration`, stacked on `assistant-progress-lines` (PR 1, head `a1ae5ae`, which
makes the progress lines this reads). Checks ran on NicolasLaptop (Linux, Node 24.22.2) at the commit
that carries this entry. No Python changed, so the Python suite from PR 1's entry stands. No iOS
build, simulator, physical device, real Realtime session, live Hermes turn or deployment ran.

## Web and server

- `npm run lint`, `npm run typecheck` and `npm run build` passed. `npx vitest run`: 169 files,
  2,475 tests passed.
- A `talk/ask` for a working request now returns as soon as a new progress line exists. The server
  tests drive the real Fastify app with the fake runtime: the early return when a structural change
  arrives mid-wait, the answer winning when it is already there, a new line at the first ask,
  `heard` lines left out, an approval outranking a line, a steered run that ended with no outcome
  returning nothing, and one `submit` however many asks follow. Bad input: a `heard` that is not a
  list, an object, null, holds a number, an empty or 513-character ID, 51 IDs, or an extra key is
  refused with 400 before anything is sent.

## Independent review

GPT-6.1 Sol (`gpt-6.1-sol`, high effort, read-only) reviewed PR 1's fix commit and this PR at `f8b4f1f`.
Of its three findings, one belongs to PR 1 (a saved-history progress line could be bookmarked, and the
bookmark could never reopen; fixed there). The two for this PR, each reproduced by the reviewer and fixed:

- A burst of more than 50 lines made the client's accumulated `heard` list exceed the server's cap, so
  the next ask was refused with 400 and Talk announced a lost connection. The cap is now 500, and both
  clients keep only the newest 500. Tested through the loop, the route's bounds, and the Swift mirror.
- Two requests sharing a steered run were each given the same later line, so it could be said twice.
  The server now ends a request's lines at the next person's message in its run, and each loop keeps one
  `heard` set for the whole Talk. Both are tested and mutated, and the Swift loop mirrors the shared set.

## Mutants

Each line below was broken by hand, its focused suites run, and the source restored (the runner is
not committed). 25 mutants. 23 failed their tests at once. Two survived, and both were redundant code,
not missing tests: dropping a held line when the answer arrives, and clearing held lines on dispose, were
each already done by the request's `finally` and the disposed guard in `handle`. The duplicates were
removed from the TypeScript and Swift loops, and the two behaviors were mutated through the remaining
line and killed.

Killed: the `heard` filter, progress-lines-only, naming every new ID, saying the newest line with words,
progress only while running, returning `progress` on the `working` answer, the 50 ID cap, the
non-empty ID rule, the request's own run selection, the 280 character cap, the sentence cut, flushing a
held line when a response ends, holding while a response is active, a request ending dropping its held
line, reporting lines as heard, the first line in the call output, sending `heard` from the browser, and
the disposed guard. Six more covered the review fixes: the turn boundary, the server's 500 cap, the client trim,
the shared set, and the saved-line refusal on the server and in the view; all were killed.

## iOS

Written and not compiled or run: `TalkProgress`, `TalkAnswer.progress`, the `heard` list, held lines and
`TalkController` sending `heard`, with four `TalkLoopTests` that mirror the web's. `TalkTransport.swift`
carries Realtime events only and needed no change. Pending on the Mac mini: the Swift build and
`TalkLoopTests`; and, on a physical iPhone, hearing a line said once while the assistant works.
