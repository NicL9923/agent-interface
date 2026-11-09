# November 9 live Talk reads progress lines aloud

Branch `talk-progress-narration`, stacked on `assistant-progress-lines` (PR 1, head `2e9b344`, which
makes the progress lines this reads). Checks ran on NicolasLaptop (Linux, Node 24.22.2) at the commit
that carries this entry. No Python changed, so the Python suite from PR 1's entry stands. No iOS
build, simulator, physical device, real Realtime session, live Hermes turn or deployment ran.

## Web and server

- `npm run lint`, `npm run typecheck` and `npm run build` passed. `npx vitest run`: 168 files,
  2,460 tests passed.
- A `talk/ask` for a working request now returns as soon as a new progress line exists. The server
  tests drive the real Fastify app with the fake runtime: the early return when a structural change
  arrives mid-wait, the answer winning when it is already there, a new line at the first ask,
  `heard` lines left out, an approval outranking a line, a steered run that ended with no outcome
  returning nothing, and one `submit` however many asks follow. Bad input: a `heard` that is not a
  list, an object, null, holds a number, an empty or 513-character ID, 51 IDs, or an extra key is
  refused with 400 before anything is sent.

## Mutants

Each line below was broken by hand, its focused suites run, and the source restored (the runner is
not committed). 21 mutants and all 19 that remained after review failed their tests at once.
Two survived, and both were redundant code, not missing tests: dropping a held line when the
answer arrives, and clearing held lines on dispose, were each already done by the request's `finally`
and the disposed guard in `handle`. The duplicates were removed from the TypeScript and Swift loops,
and the two behaviors were mutated through the remaining line and killed.

Killed: the `heard` filter, progress-lines-only, naming every new ID, saying the newest line with words,
progress only while running, returning `progress` on the `working` answer, the 50 ID cap, the
non-empty ID rule, the request's own run selection, the 280 character cap, the sentence cut, flushing a
held line when a response ends, holding while a response is active, a request ending dropping its held
line, reporting lines as heard, the first line in the call output, sending `heard` from the browser, and
the disposed guard.

## iOS

Written and not compiled or run: `TalkProgress`, `TalkAnswer.progress`, the `heard` list, held lines and
`TalkController` sending `heard`, with four `TalkLoopTests` that mirror the web's. `TalkTransport.swift`
carries Realtime events only and needed no change. Pending on the Mac mini: the Swift build and
`TalkLoopTests`; and, on a physical iPhone, hearing a line said once while the assistant works.
