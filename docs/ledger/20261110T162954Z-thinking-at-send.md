# November 10 the assistant thinking from the moment a message is sent

Branch `t3/thinking-at-send` over `origin/main` at `8281930`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores),
Node 24.22.2. Web client, the browser suite's scripted server and one measuring tool; no app server, Hermes or iOS
code changed.

## What main did

- `src/App.tsx:392` took the activity state only from the conversation Hermes reported, and
  `src/app/Conversation.tsx:302` drew the activity row only for that state. A sent message showed at once as an echo
  (`src/app/sent-echo.ts`), but the row with the avatar waited for the POST's answer, a change notice and a read.
- The activity row is not keyed by `src/app/reply-keys.ts`: it is one conditional child after the turns, so the
  early row and Hermes's row are the same node whenever the row stays mounted. Its status line is a
  `role="status" aria-atomic="true"` region whose words, "Shared is thinking...", are the same for both.

## What the admission answer can say

The client sees `accepted` (with `steered` when the add-on reports its decision), `uncertain`, `rejected` or
`interrupted` (`src/shared/types.ts:476`). Hermes's `prompt.submit` answers `streaming`, `queued` (busy, queued behind
the running turn) or `voice_stopped` (a bare stop phrase typed while the session's own Hermes voice mode is on,
`tui_gateway/methods_prompt.py`, read from a local upstream clone). The add-on folds all three into `accepted`
with `steering: false` (`src/hermes/extension.py:1909`), so the client cannot tell them apart. What a person sees:

| Answer | Row |
| --- | --- |
| Sending, chat idle, done, failed or interrupted | Thinking, at once |
| Sending while the chat shows work (a steer) | Only the work's row; nothing added |
| Accepted, new turn | Thinking until Hermes's report or copy takes over, same node |
| Accepted, steered | Nothing added |
| Accepted, queued behind another turn | That turn's working row takes over the node; nothing after it |
| Accepted, typed stop phrase | Thinking until the echo's own 30 s patience ends, then nothing (see below) |
| Rejected, interrupted, refused by the app (4xx) | Gone with the echo |
| Failed without an answer (5xx, network) or uncertain | Gone while unconfirmed; back while a Retry is on its way |
| Discarded | Gone |
| Read failed (#317) | Send is refused, so no echo and no row |

The typed stop phrase is the one case the client cannot see. WildBots never turns on Hermes's voice mode, so it can
happen only when someone ran `/voice on` in a Hermes terminal on the same session. Showing it correctly would take
the add-on passing `queued` and `voice_stopped` through its receipt; that is a Hermes add-on change, left out here.
Stop and the composer's interrupted-task review follow only Hermes's report, so Stop appears once the turn is real.

Group chats: the group composer shows no echo at all. The message appears after the server accepts it and the room
reloads, and "who is working" comes from the room driver, which picks the member. Not the same gap or the same
change, so not fixed here.

## Gap, before and after

`npm run build && node .agents/tools/measure-thinking-gap.mjs --runs 10 --delays 0,1500`, Chromium 1280 x 800,
`e2e/server.ts` on port 4183, Trail Cook "Echo: …" turns. Time from the echo row's insertion to the activity
row's, per a MutationObserver:

| Build | Admission | Echo to row, median (min, max) | Row nodes inserted, removed | Status words | Sent message moved |
| --- | --- | --- | --- | --- | --- |
| `main` at `8281930` | immediate | 34 ms (30, 49) | 1, 0 | thinking | 18 px |
| `main` at `8281930` | held 1,500 ms | 1,520 ms (1,514, 1,534) | 1, 0 | thinking | 18 px |
| This branch | immediate | 0 ms (0, 0) | 1, 0 | thinking | 18 px |
| This branch | held 1,500 ms | 0 ms (0, 0) | 1, 0 | thinking | 18 px |

On loopback the gap on `main` is one round trip; on a real network it adds the network's round trip and Hermes's
admission. The 18 px move of the sent message is the same before and after, so the send anchor is undisturbed.
The first `main` run timed out waiting for the sign-in button once; the rerun is the one recorded. An earlier
attempt hit another worktree's server on port 4173 and was discarded, which is why `e2e/ports.ts` now reads
`E2E_PORT` and the tool refuses a port that already answers.

## Checks

- `npm ci` once. `npm run typecheck`, `npm run lint` passed. `ruff check .` (ruff 0.17.3): all checks passed.
- `npx vitest run tests/thinking-at-send-ui.test.ts tests/sent-echo.test.ts`: 2 files, 40 tests passed.
- `npm test`: 191 files, 3,184 tests passed.
- `npm run build` passed. `npm run test:e2e`: 21 passed in Chromium (`E2E_PORT=4193` when 4173 was held by
  another worktree). The new e2e test holds admission 800 ms and checks the row showed while the message read
  "Sending…", one row node, one status text.
- Safari, Firefox, screen-reader speech and a real phone: not run. The accessibility claim rests on the status
  node staying the same with the same words, asserted in jsdom and Chromium.

## Red proof

Each line was broken by hand, the named tests went red, and the line was restored:

1. App ignores `awaitingTurn`: 8 UI tests, from "appears with the echo…" to the Retry tests. The e2e test also
   went red on a build with this break: `whileSending` false.
2. `!echo.steered` removed: "does not show when Hermes steered it into the running task".
3. `!echo.duringWork` removed, and separately `duringWork` never set: the unit case and "never adds a row for
   guidance sent while the assistant works…".
4. Unconfirmed echoes allowed: 8 tests, including "goes when the send fails…" and "goes when Hermes's answer is
   uncertain".
5. Retry not blocked by the early row: "keeps a failed turn's Retry away once Hermes accepts…".
6. `echoShown` check removed: "does not show when Hermes's copy is in the chat".
7. `active` on the shown state instead of Hermes's: "offers Stop only once Hermes reports the turn".
8. `!echo.ran` removed: "does not show when its turn already showed work".
9. Bot check removed: "does not show when the message went to another assistant".
10. Active conversation check removed: "does not show when Hermes reports the turn's own work".

## After merging main at `c2ee202` (#320)

`main` gained #320, which changed `src/App.tsx` and `src/app/use-conversation.ts`; the only conflict was the
tools index. On merge commit `068654a`: `npm run typecheck`, `npm run lint` and `ruff check .` passed;
`npm test`: 193 files, 3,224 tests passed; `npm run build` passed; `npm run test:e2e`: 21 passed in Chromium.
`measure-thinking-gap.mjs --runs 5`: 0 ms echo to row at both admission delays, one row node, none removed,
one status text, the sent message moved 18 px as on `main`.

## Review fix round: Grok 4.7's findings

Grok 4.7 reviewed `b40f057` and ran every check. Its findings and what changed:

1. A send whose request had not settled showed "thinking" with nothing running until the 60 s write timeout
   (`src/client-api.ts:71`). Now the early row shows at once as before, and a `sending` echo stops counting once its
   request has been out `SENDING_ROW_MS`, 5 s (`src/app/sent-echo.ts`). The message keeps its own "Sending…", as on
   `main`; when the admission then answers accepted, the row comes back by the normal path. A Retry starts the bound
   again. No cancel or abort was added. The bound: a healthy admission answered in 0.08 s in the idle-compaction
   probe on real Hermes, including sends that stopped a held compaction (under 0.1 s), and in 1.1 s once with the
   host's load average at 7.4 (`docs/ledger/20261109T152849Z-idle-compaction.md`). Loopback here answers in about
   35 ms. 5 s covers the slowest healthy admission seen several times over plus a slow phone round trip, and ends
   the claim long before the add-on's 30 s preempt bound (`src/hermes/compaction.py:30`) or the 60 s write timeout.
2. Hermes's copy arriving in one read and the turn's report in the next unmounted the early row and announced
   thinking twice. An accepted echo whose copy is in the chat now stays while the chat shows no work and the copy
   is still the last message (`handingOff`), so the report takes over the same row and status node. It ends with
   the report, with a reply after the copy, or `COPY_HANDOFF_MS`, 5 s, after the copy arrived. The report normally
   follows as the next change notice; 5 s is the same scale as the admission bound and keeps a stray copy without a
   turn from claiming work for long. Only an accepted message hands off; one still `sending` when its copy arrives
   leaves with it, as before (a narrow race, left as is).
3. The `!connectionShown &&` gate in `src/App.tsx` had no test. "shows the chat disconnected, not thinking, when the
   connection drops while a message is on its way" now fails without it.
4. What stays: Hermes's typed stop phrase would show thinking for the echo's 30 s. It acts only while Hermes's own
   voice mode is on for the session, and this app never enables it. Reviewer's citations, each read here:
   `src/server/hermes.ts:385` sends `voice_turn` only for a spoken Talk turn, never voice mode;
   `src/hermes/extension.py:1885` passes that mark to `prompt.submit`, and `:1909` folds every status but
   `rejected` into `accepted`. Upstream, in the Hermes checkout the reviewer used: `tui_gateway/methods_prompt.py:239`
   is `_consume_typed_stop_phrase`, which ends a session's voice chat for a bare stop phrase typed while its voice
   mode is on, and `tui_gateway/methods_voice.py:59` is `_session_voice_enabled`, that gate: the session's own
   `/voice on` or the voice sidecar's environment flag. README says so.

Tests written first and seen red for the reviewer's reason before the change: the bound test (row still there past
5 s), the split test (row unmounted after the copy), and the bounded-drop test (row already gone). The disconnected
test passed with the gate in place and went red with it removed.

Red proof, each line broken by hand and restored (`tests/thinking-at-send-ui.test.ts`, `tests/sent-echo.test.ts`):

| Break | Red |
| --- | --- |
| `awaitingTurn` ignores `slow` | "does not show when its request has been out longer than the bound", "leaves a send whose request has not answered…" |
| The bound timer in `useSentEchoes` never set | "leaves a send whose request has not answered…", "drops the row a bounded time after Hermes's copy arrives…" |
| `slow` never set | "marks a request out for the bound as slow…", "leaves a send whose request has not answered…" |
| A retry keeps the old `sendingSince` | "marks a request out for the bound as slow, and starts the bound again when a retry goes out" |
| `awaitingTurn` ignores `handingOff` | the unit handoff test, "keeps one row and one announcement…", "drops the row a bounded time…" |
| `nextEcho` drops a shown echo at once | the same three |
| A reply after the copy ignored | "does not show when Hermes's copy is in the chat with a reply after it", "drops the row at once when Hermes's copy arrives with the turn's reply already after it" |
| The handoff never ends | the unit handoff test, "drops the row a bounded time…" |
| `!connectionShown &&` removed | "shows the chat disconnected, not thinking…" only |

The first run of the gate break also failed four later tests: the offline stub leaked when the assertion threw.
Its cleanup moved to `afterEach`, and the rerun failed only the gate's test.

`node .agents/tools/measure-thinking-gap.mjs --runs 5 --delays 0,1500,7000`, Chromium 1280 x 800, `E2E_PORT=4271`:

| Admission | Echo to row | Row nodes inserted, removed | Sent message moved |
| --- | --- | --- | --- |
| immediate | 0 ms in 5 of 5 | 1, 0 | 18 px |
| held 1,500 ms | 0 ms in 5 of 5 | 1, 0 | 18 px |
| held 7,000 ms | 0 ms in 5 of 5 | 2, 1: gone at the bound, back on acceptance | 65 px |

The 7 s case is the trade the bound makes: the row leaves while the message reads "Sending…", and returns when
Hermes accepts it, announced again. The tool reads positions in a MutationObserver, before the transcript's
ResizeObserver places the sent message, so the 65 px may include a frame that is never painted; not separated here.

Checks at this commit: `npm ci` once; `npm run typecheck`, `npm run lint` passed; `ruff check .` with ruff 0.17.3:
all checks passed; `npx vitest run tests/thinking-at-send-ui.test.ts tests/sent-echo.test.ts`: 2 files, 48 tests
passed; `npm test`: 193 files, 3,232 tests passed; `npm run build` passed; `npm run test:e2e` (`E2E_PORT=4261`):
21 passed in Chromium. Safari, Firefox, screen-reader speech and a real phone: not run.

## Second review fix round: Grok 4.7's re-review of `b7d347a`

Grok 4.7 found no P1 and every check passing. Its findings and what changed:

1. P2: a finished, failed or interrupted report kept the early row on "thinking" until the 5 s handoff bound, with no
   Stop and no Retry, when it came with Hermes's copy still the last message. A settled report for the turn now ends
   the handoff (`settledHere` in `src/app/sent-echo.ts`), so the reported row, with its Retry, is the one on screen.
   What tells this turn's outcome from the last one's: the add-on takes a message out of `admitting` and records its
   row in the same journal transaction, before the POST answers (`src/hermes/extension.py:1911` to `1919`), and a
   read computes the run (`SHOWN_RUN`, which skips admissions still in progress) before it attributes rows. So only a
   read that began during admission can show the copy with the previous turn's outcome, and that outcome is the one
   the chat showed when the message was sent. The echo keeps that report (`before`: state and run ID). A settled
   report counts as this turn's when it differs from `before` in state or run ID, or when it comes from a read whose
   structural version is newer than the read that first brought the copy (`copiedVersion`, `compareVersions`). A
   settled activity carries no run ID (`src/server/hermes.ts:521`), except an interruption by restart, so the run ID
   rarely decides it; the copy's position cannot, since both reads show it last. What stays: the same outcome as
   `before`, in the very read that first brings the copy, cannot be told from the last turn's. That case keeps
   thinking until the next read or the 5 s bound. It takes a turn that ends before any read sees it running and ends
   the same way as the one before: a failure right after a failure, or a finished turn with no reply text.
2. P3: the handoff clock did not run while another chat was open. `nextEcho` now checks the handoff bound before it
   checks which chat is open, so the bound's timer drops the echo while the person is elsewhere; and `awaitingTurn`
   takes `now` and treats `copiedAt` and `sendingSince` plus their bounds as over, so a render never paints a row
   whose bound passed before a timer stepped the echo. `src/App.tsx` passes `Date.now()`.
3. P3: the 47 px one-frame move after a 7 s admission is `main`'s too. Measured below; left as is.

### Item 3: the sent message's largest move between two frames

`.agents/tools/measure-thinking-gap.mjs` now samples the sent message's top every animation frame, in
`requestAnimationFrame`, and again in a task posted from that callback, which runs after the frame paints, until a
second after the reply's first words. The earlier version stopped at the reply's first words, where the move happens.
`node .agents/tools/measure-thinking-gap.mjs --runs 5 --delays 7000`, Chromium 1280 x 800. `origin/main` at
`caeeb7f` (no web client change since this branch's base `c2ee202`) ran from its own checkout with this branch's
`e2e/server.ts` and `e2e/ports.ts` copied in for the admission delay, uncommitted there.

| Build | Largest step, per frame | Largest step, after paint | When | Row nodes inserted, removed |
| --- | --- | --- | --- | --- |
| `origin/main` | 47 px, 165 to 118, 5 of 5 | 47 px, 5 of 5 | 7,322 to 7,327 ms after the send, 290 to 309 ms after the row first appeared | 1, 0 |
| This branch | 47 px, 165 to 118, 5 of 5 | 51 px, 165 to 114, 5 of 5 | 7,286 to 7,291 ms after the send, 306 to 309 ms after the row returned | 2, 1 |

The move is the arrival that saves the copy and starts the reply, on both builds, at the same place. The after-paint
sample on this branch read 4 px more in the same step: the run's other 4 px move, which both builds make near the send,
fell into the same sample. Since `main` moves the message the same way, this branch leaves the anchor as it is.

### Tests and red proof

Written first and seen red for the reviewer's reasons: "ends at once when Hermes reports this turn finished, failed or
interrupted", "keeps the row through the outcome the chat showed when the message was sent, until a later read or a
different outcome" and "treats a bound as over by the clock alone…" (`tests/sent-echo.test.ts`); "shows the turn
failed, with its Retry / interrupted / finished when Hermes reports it with the copy, instead of thinking" (thinking
was on screen in each), "keeps thinking through the last turn's failure in the read that brings the copy, and shows
this turn's failure from a later read" (thinking stayed on the later read), and "never paints thinking on returning to
the chat after the handoff bound passed in another chat" (one thinking status drawn on return)
(`tests/thinking-at-send-ui.test.ts`). The return test records every status line inserted, so a frame that is
replaced at once still counts. The settled reports in these tests carry no run ID, as Hermes sends them.

| Break | Red |
| --- | --- |
| `settledHere` never true | the unit settled test and stale test, the three UI outcome tests, the UI stale test |
| No rule for an outcome other than `before` | the unit settled and stale tests, the three UI outcome tests |
| No rule for a later read | the unit stale test, the UI stale test |
| Every settled report counts as this turn's | the unit stale test, the UI stale test |
| Handoff bound checked only in its own chat | "stays while Hermes's copy is in the chat…", "treats a bound as over by the clock alone…", "drops the row a bounded time…" |
| `awaitingTurn` ignores the handoff clock | "treats a bound as over by the clock alone…" |
| `awaitingTurn` ignores the sending clock | "treats a bound as over by the clock alone…" |
| Both handoff clock fixes removed together | "never paints thinking on returning to the chat…" |

The return UI test is held by either clock fix alone, so it went red only with both removed; each fix has its own unit
case.

### Checks

`npm ci` once; `npm run typecheck`, `npm run lint` passed; `ruff check .` with ruff 0.17.3: all checks passed;
`npx vitest run tests/thinking-at-send-ui.test.ts tests/sent-echo.test.ts`: 2 files, 56 tests passed; `npm test`:
193 files, 3,240 tests passed; `npm run build` passed; `npm run test:e2e` (`E2E_PORT=4321`): 21 passed in Chromium.
Safari, Firefox, screen-reader speech and a real phone: not run.

## Third review fix round: Grok 4.7's re-review of `848bc91`

One P2, fixed by the orchestrator (Claude Fable 5.2). The image and avatar branches had no findings.

**The finding.** `settledHere` counted a finished, failed or interrupted report as this turn's when its state or run
ID differed from what the chat showed at the send. While Hermes admits a message it has saved the copy and not opened
the run (`src/hermes/extension.py`, `SHOWN_RUN` skips a receipt still in `admitting`), so the read that brings the
copy can report the turn before. What the chat showed at the send is not a reliable record of that turn: a cached chat
can show `done` where the last turn failed, and a chat not yet loaded shows nothing. The reviewer ran `nextEcho`,
`awaitingTurn` and `retryTarget`: sent from `done`, `interrupted`, `idle`, no conversation or another chat, a `failed`
report on the copy's read removed the row and put Retry on the new message.

**The fix.** A settled report counts as this turn's only from a read the server's version orders after the one that
brought the copy. The read that brings the copy never ends the row. `before` is gone from the echo. A settled report
carries no run ID (`SHOWN_RUN` reads only receipts with `terminal=0`), so nothing in the report can name its turn.

**What it costs.** A turn that fails or is interrupted before any read sees it running, with no reply, shows thinking
until the next read or the 5 seconds, where it showed the outcome on the copy's read before. A finished turn has its
reply after the copy, which ends the row at once as before.

**What remains.** Two reads inside one admission, the second ordered after the first, would still end the row on the
last turn's report. `main` shows the last turn's Retry on the new message through that whole window today. Closing it
needs the server to say whether a send's turn has opened, which the admission answer's `turn` field allows once the
server reads it; that is a separate change.

### Tests and red proof

`tests/sent-echo.test.ts`: the row stays through `failed`, `interrupted` and `done` on the copy's read, for a message
sent from an idle chat, a finished turn, the same failure, no conversation and another chat; a later read ends it; the
same version, an older one, another process's and a missing one do not; a copy read without a version ends only at the
bound. `tests/thinking-at-send-ui.test.ts`: the three outcome cases now keep thinking without Retry on the copy's
read and show the outcome from the next read.

Written first against `848bc91`'s rule: 9 failed. Then each line broken by hand and restored, 60 tests in the 2 files:

| Break | Red |
| --- | --- |
| Every settled report ends the row | 10: the five copy-read cases, the later-read case, the three UI outcomes, the UI stale test |
| `>= 0`, so the copy's own read counts as later | the same 10 |
| An unordered version counts as later | the same 10 |
| A later read never ends the row | 5: the later-read case, the three UI outcomes, the UI stale test |
| The copy's version is not stored | the same 10 as the first |
