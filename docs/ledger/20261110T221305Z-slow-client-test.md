# November 10 the slow-client test's queue bound

Branch `t3/slow-client-test` over `origin/main` at `e7cd5ac`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
One test changed in `tests/conversation-events.test.ts`. No product code changed.

## What failed

`writes nothing more to a client that stops reading until it catches up, then sends all it missed as one delta`
came in with #323 and passed its four checks there. On the next pull request, #324, it failed on Node 26.13.0:
`expected 2621636 to be less than 589824`. #324 changes CSS and a CSS test only.

## Cause

The test asserted that the socket never queued more than one tick's growth, 512 KB, plus 64 KB. That holds only
when the kernel takes less than one update before the socket fills. When the kernel takes the first update whole, the
socket drains during the stall, and the next update carries everything the client missed, which is the designed
behavior. 2,621,636 bytes is one delta of five ticks' growth: 5 x 524,288, plus 186 bytes of frame and 10 of chunk
header. The server did what it should. The test counted on a buffer size that differs between machines.

Reproduced here by letting the paused client read three updates' worth at tick 10 and pausing it again: the peak
queue was 2,621,636 bytes, the same number, in one write of 2,621,626, with 8 reads over 40 ticks.

## The test now

It watches the response's `write` with a spy that calls through, and asserts what the rule promises on any machine:

- No live update is written while the socket still needs a drain.
- After every tick the socket holds no more than the largest single update written plus its high-water mark.
- Some ticks read nothing, so the stall happened.
- The resumed stream ends on the exact reply, as before.

With the reproduction above in place, all four hold.

## Red proof

`writable()` in `src/server/event-stream.ts` changed to always answer true, then restored: the test went red at the
second tick, `expected 1048966 to be less than or equal to 590010`.

## Checks

`npm run typecheck`, `npm run lint` passed; `ruff check .` with ruff 0.17.3: all checks passed; `npm test`: 192 files,
3,210 tests passed; the changed test alone: 10 runs, 10 passed. Node 26 was not run here; CI runs it.
