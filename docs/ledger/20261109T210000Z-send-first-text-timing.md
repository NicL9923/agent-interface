# November 9 send timing to the first live text

Branch `feat/send-first-text-timing`, from `origin/main` at `e479781`. Checks ran on NicolasLaptop
(Linux, Node 24.22.2) at the commit that carries this entry. No real Hermes, iOS build or deployment ran,
so no production number exists yet.

## Web and server

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/send-timing.test.ts tests/hermes-adapter.test.ts tests/conversation-events.test.ts tests/talk-api.test.ts`:
  4 files, 287 tests passed. `tests/send-timing.test.ts` alone passed five runs in a row (17 tests),
  since its route cases use real timers.
- `npm test`: 170 files, 2,505 tests passed. The first full run failed 20 tests, which this branch then
  fixed: the bot-access test double answers every unknown runtime method with an async function, so it
  needed a real `watchStreamedText` subscription, and the qualification test needed `send-timing.ts`
  listed as plumbing that never reaches Hermes.

`tests/send-timing.test.ts` drives `SendTimings` with a recording log and an injected clock, and the
real Fastify app with the fake runtime, a real listener and a real `?inflight=2` event stream. Covered:
the log line's exact fields and that it carries no message text; frames before admission not counted;
two turns of one assistant each getting their own first frame; the two-minute give-up line, once; close
clearing every deadline; the per-token path reading nothing but its map once framed; `Server-Timing`
for an admitted send, a steer, a rejected send (header, no log line), and a repeated request ID
(`total` only); an `inflight-delta` as a turn's first live event; a live event refused because the
session ended not being counted; the streamed-text listener removed on close. `tests/hermes-adapter.test.ts`
covers the Hermes hook: text and reasoning frames reported by assistant, a frame during a first open
reported for the opening assistant, other live frames and another client's session ignored, a throwing
listener not stopping frame processing, and unsubscribe.

## Mutants

Each line was broken by hand, the focused file run, and the source restored. 20 mutants, all killed
after two test fixes:

- Hermes hook: every live frame counted as text; the listener's try/catch removed; frames while opening
  dropped; unsubscribe doing nothing.
- `SendTimings`: the framed shortcut removed; a new turn keeping the old framed flag; written leaving the
  turn waiting; give-up logging nothing; give-up leaving the turn listed; close keeping deadlines (first
  survived, since a cleared map already silences the timers; the test now asserts no timer is pending).
- Header: a `hermes` phase without an answer.
- Routes: a rejected send timed; admission not recorded; a steer labelled as a message; the text
  listener kept after close; a whole and a delta write not counted.
- Refused writes: a refused whole write counted, and `EventStream.send` reporting a refused write as
  written. Both first survived because the send's own change notice was the refused write; the test now
  waits for that notice before ending the session.

Not tested: the `talk` route label (the same code path, labelled by the `voice` flag), and arrival
being taken from `reply.elapsedTime` rather than the handler's start, which only moves `prepare` by
the sign-in and parsing time and has no observable boundary in a test.

## Review round 1

GPT-6.1 Sol reviewed `4ac72d0` and reproduced four findings, all from the record's identity and
lifetime:

- B1: a text frame for a session no assistant owned yet was reported for every assistant opening, so
  one assistant's frame gave another's send a `firstFrameMs`.
- B2: waiting records were keyed only by assistant and never learned their turn ended, so a send whose
  turn finished without text took the next turn's time.
- B3: tracking began after `runtime.submit()` resolved, so text Hermes streamed before answering was
  lost.
- B4: the first live event ended the record, so a tool-first turn logged no `firstFrameMs`.

The redesign, stated at the top of `src/server/send-timing.ts`: a record is one send bound to one
assistant turn. `begin()` creates it before Hermes is asked. A steer, or a send while a turn runs, joins
that turn; any other send binds to the next `message.start`. Hermes's answer confirms it or `discard()`
drops it. A joined send moves to the next turn when Hermes did not steer it or when the running turn gives
way first. It ends, with one line and an `ended` reason, when both moments are recorded (`measured`), its
turn ends (`turn`), a newer turn starts without its end (`next-turn`), or two minutes pass after admission
(`deadline`). The runtime hook is now `watchTurns(botId, start|text|end, at?)`. `hermes.ts` holds the
turn events of a session with no owner by session ID, keeping only the latest turn for the 16 newest such
sessions, and replays them, with the first text frame's arrival time, once an open names the owner. After a
turn's first text, a token still costs one map lookup and no clock read.

### Red runs on `4ac72d0`

The four new tests were written first and run against the branch head before any fix. The hook was then
still `watchStreamedText`, so the B1 test used that name and the route tests' fake runtime exposed both
hooks; both were renamed with the fix.

- B1, `tests/hermes-adapter.test.ts`, two assistants open at once: expected `['shared']`, received
  `['shared', 'other']`.
- B2, `tests/send-timing.test.ts`, a send whose turn ends without text: `firstFrameMs` was 24.8, taken
  from the routine turn that followed, where `undefined` was expected.
- B3, text streamed only while Hermes was answering: `firstFrameMs` was `undefined`.
- B4, a tool event written before the first text: `firstFrameMs` was `undefined`.

### Checks, round 1

Run on NicolasLaptop (Linux, Node 24.22.2) at the commit that carries this section.

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/send-timing.test.ts tests/hermes-adapter.test.ts tests/conversation-events.test.ts tests/talk-api.test.ts tests/bot-access.test.ts`:
  5 files, 326 tests passed. `tests/send-timing.test.ts` alone passed five runs in a row.
- `npx vitest run tests/hermes-qualification.test.ts`: 5 tests passed.
- `npm test`: 170 files, 2,518 tests passed.

### Mutants, round 1

Each was applied by hand, `tests/send-timing.test.ts` and `tests/hermes-adapter.test.ts` run, and the
source restored. 20 killed in the two modules:

- `hermes.ts`: unowned text reported to every opening assistant; an open never claiming held events; no
  hold limit; the claimed text losing its arrival time; a held turn start keeping an earlier turn's text.
- `SendTimings`: a steer not joining the running turn; an unsteered joined send staying on the running turn;
  a waiting joined send not moving to a newer turn; an admitted send not ended by a newer turn or by its
  turn's end; a waiting send's turn not marked ended at its end or at a newer start (these two first
  survived, each covering the other in one test, which is now split per branch); the provisional end
  reason ignored at the answer; a frame held from before the send arrived counted; the framed shortcut
  removed; the first live event ending the record; the answer not ending a record whose turn already
  ended; no deadline; text completing a record not finishing it; both moments recorded before the answer
  not finishing it at the answer.
- Routes: starting the record after Hermes answers was tried, but the mutant left the record unset and
  crashed the route rather than measuring late, so it proves nothing. The B3 red run on `4ac72d0`, where
  tracking did start after the answer, is the evidence for that line.

Survived: `discard()` leaving the record in the assistant's list. A record without an answer never logs,
so the only effect is memory held until the app closes, which no log or route exposes. Not tested: the
held-session map cleared on disconnect and when the last listener leaves.
