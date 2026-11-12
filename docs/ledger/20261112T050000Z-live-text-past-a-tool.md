# November 12 live text keeps flowing after a tool

Branch `t3/4fbe4b74` over `265f36d`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2. Source fingerprint of
`src/server src/shared src/app tests .agents/tools` with the change applied:
`sha256:1c77cd7d125be72b8c6576a301c401ee8b9f9c53bca558456f55b50ebbcdf52e` (580 source files). No Hermes process ran
and nothing was deployed.

## Defect

On a `?inflight=3` turn stream, every structural frame deleted the turn snapshot live replies are built on
(`sessionFrame` in `src/server/hermes.ts`), and the stream sent nothing live until the server's turn read stored a
new one. That read costs up to about 2.8 s on `patch`, so streamed text froze after every tool.

## Change

A frame whose whole effect a turn event carries (`turnCovered`: `tool.complete`, `message.interim`) keeps the turn
snapshot, marked with a seam where the live text stood, until the turn read lands. The live reply goes on growing at
the snapshot's own version, so the protocol rule holds unchanged: a live reply shows only beside the read of its own
version. That read has no row for the segment Hermes saved before the tool, so the segment stays in the live reply
and the text after the seam starts a paragraph (`withSeams`), never changing text already sent, so growth stays an
append. The turn read lands with a newer version and its turn event replaces the reply whole. Every other structural
frame still drops the snapshot, and a turn read still runs while the kept one is marked (`freshTurn`).
`?inflight=1` and `?inflight=2` streams, the iOS app's, are unchanged. The client is unchanged: a newer read the
client takes meanwhile hides growth on the older version until its own turn arrives, as
`tests/app-ui.test.ts` "lets a newer read stand" already pins.

## Measurement

`READ_MS=2800 npx vitest run --config .agents/tools/measure-turn-freeze.config.ts --silent=false` (new tool): real
app and Hermes runtime over the fake socket, one word every 50 ms, two tools, every open answered after 2.8 s, a
client that reads on each change notice.

| Build | Word delay after each tool, p50 / p95 / max | Before any tool, p50 / max |
| --- | --- | --- |
| `265f36d` | 1005 / 2655 / 2805 ms and 1002 / 2651 / 2801 ms | 66 / 70 ms |
| this change | 53 / 62 / 64 ms and 53 / 63 / 64 ms | 22 / 72 ms |

`tests/live-turn-timing.test.ts` pins the virtual-time figures: the token after each tool now shows at 0 ms instead
of 61 ms (one Hermes read), with the same 10 and 18 opens.

## Tests and red runs

- `tests/live-turn-runtime.test.ts`: the first turn-read case now shows the reply growing at the last read's version,
  with the segment and a paragraph break, then the newer version after the read. New: a turn ending, an approval and
  an unknown frame drop a kept snapshot; `withSeams` cases.
- `tests/live-turn-stream.test.ts` "keeps growth coming at the last read's version while the server's turn read after
  a tool is on its way": deltas arrive while the read is held, then the turn event at a newer version.

Each mutation by hand against `npx vitest run tests/live-turn-runtime.test.ts tests/live-turn-stream.test.ts`, restored after:

| Mutation | Result |
| --- | --- |
| drop the turn snapshot on every structural frame | failed: keeps growth coming at the last read's version… (5 tests) |
| keep it past any frame | failed: keeps no live reply on the last read's version past a frame the runtime does not know… (7 tests) |
| a marked snapshot counts as read | failed: ?inflight=1 gets the same events and reads… (43 tests) |
| no seams applied | failed: reads the turn itself after a structural frame… (2 tests) |
| break even over a blank line | failed: starts a paragraph at each seam text follows… |
| a seam with no text after it | failed: adds nothing at a seam no text follows yet… (4 tests) |

## Checks

The live-turn, conversation-events, adapter, app and app-ui suites pass (599 tests); typecheck and lint pass. The
full battery runs once for the branch. Not exercised: real Hermes, a browser, and production.
`TURN_HOLD_MS` (1.5 s) still sends the change notice when the turn read is slower, which makes the client read too;
live text now flows through that wait, so it is left as it was.
