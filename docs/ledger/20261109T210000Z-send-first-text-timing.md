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
