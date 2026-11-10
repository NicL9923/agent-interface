# November 9 capability reads stop waiting on the live-voice probe

Branch `fix/capabilities-skip-voice-wait`, from `origin/main` at `e479781`. Checks ran on NicolasLaptop
(Linux, Node 24.22.2) at the commit that carries this entry. No real Hermes, iOS build or deployment ran.

## Web and server

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/hermes-adapter.test.ts`: 215 tests passed.
- `npm test`, four runs: two passed all 2,490 tests in 169 files. Two failed one test,
  `tests/transcript-ui.test.ts` "names a required field left empty and sends nothing", a React form
  test that imports no server code. That file passed alone three times, and `origin/main` passed the
  full suite twice. It is a load-timing flake outside this change and is not fixed here.

The tests drive the Hermes runtime against the fake socket in `tests/hermes-adapter.test.ts`, with
`fetch` faked at the voice status route and only `Date` virtual. Covered: the first read on a
connection waits for the probe; a read with a 30 second old value answers within 50 ms while the
refresh is still unanswered, a second read joins that refresh, and the refreshed value is served after
it lands; a refresh whose fetch rejects reports `Hermes could not report live voice.` and the next
successful refresh restores the value; a disconnect drops the value, the next read waits on a fresh
probe, and a refresh from the old connection that answers last does not replace it.

## Mutants

Each line was broken by hand, the live voice tests run, and the source restored. All six were killed.

- A stale value waits on the probe again: 3 tests failed.
- A refresh from an older connection stores its value: 1 failed.
- A pending read survives a disconnect: 1 failed.
- The value survives a disconnect: 1 failed.
- A failed refresh keeps the old value: 1 failed.
- A read during a refresh starts another probe: 1 failed.

Not mutated: the `.catch` on the background refresh. The read settles every error itself and never
rejects, so the guard is equivalent today; it stays so a later change cannot crash the process with an
unhandled rejection.
