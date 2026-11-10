# November 9 a timed-out Hermes read fails alone

Branch `fix/read-timeout-keeps-socket`, from `origin/main` at `e479781`. Checks ran on NicolasLaptop
(Linux, Node 24.22.2) at the commit that carries this entry. No real Hermes, iOS build or deployment ran.

## Web and server

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/hermes-adapter.test.ts`: 215 tests passed.
- `npm test`: 169 files, 2,490 tests passed.

The transport tests drive `createHermesTransport` and the Hermes runtime against the fake socket in
`tests/hermes-adapter.test.ts`, on fake timers. Covered: a slow read rejects with
`Hermes profiles.describe timed out. Try again.` while a second request on the same socket succeeds
and `hooks.disconnected` is never called; the late answer to that read is dropped without error and
never reaches the session-frame hook; a timed-out heartbeat liveness probe drops the socket at
twenty quiet seconds; an unanswered mutation still drops the socket at 45 seconds and removes its
listeners; a timed-out image probe leaves capabilities and the connection usable and is probed again
on the next read; a socket closed during the image probe still disables every capability.

## Mutants

Each line was broken by hand, `tests/hermes-adapter.test.ts` run, and the source restored.

- Read timeouts drop the socket again (`drop ?? true`): 3 tests failed, including the slow-read test.
- The heartbeat probe no longer drops (`drop: false`): 2 tests failed, the new heartbeat test and the
  existing liveness test.
- A timed-out image probe is cached for the connection: 1 test failed.
- Survived: the handshake's contract check no longer dropping on its own timeout. The handshake
  deadline set at the start of the attempt fires at or before that request's ten seconds and drops the
  socket itself, so the explicit `drop` on that line is equivalent today. It stays so the handshake does
  not depend on that ordering.
- Not mutated: deleting the timed-out request from the pending map. Without it the late answer still
  settles nothing visible; the only effect is a leaked entry, which no public surface exposes.

## Review round 1

GPT-6.1 Sol reviewed `c0db735` and reproduced one finding: every incoming frame refreshes
`lastReceivedAt`, so a steady flow of token or status events suppressed the heartbeat probe. It saw
12 consecutive read timeouts over 120 simulated seconds with no probe and the socket still verified.
Before this branch a read timeout dropped the socket, so the branch introduced the gap.

The fix: a read timeout now asks for the liveness probe at once, whatever the event traffic. The probe
is one `agent-interface.capabilities` request per socket, held on the connection, sent with `rawRpc`
so it never joins a shared read, and its timeout drops the socket. The heartbeat asks for the same
probe, so a quiet-socket probe and a timeout probe never overlap.

New tests in `tests/hermes-adapter.test.ts` feed a `message.delta` event every second throughout:

- Two reads and a shared capabilities read time out; exactly one probe goes out, separate from the
  shared read; the socket is still open at 19 seconds and closed at 20, ten seconds after the first
  read timed out; `hooks.disconnected(true)` runs.
- An answered probe keeps the socket for 30 more seconds and a later read succeeds on it.

Both new tests failed on `c0db735` for the reviewer's reason (probe count 2 where 3 was expected, and
1 where 2 was expected): no probe followed the read timeout.

### Mutants, round 1

Each was applied by hand, `tests/hermes-adapter.test.ts` run, and the source restored.

- A read timeout no longer starts the probe: both new tests failed.
- A second probe may start while one is in flight: the steady-events drop test failed.
- The probe goes through the shared `rpc` path and joins the in-flight read: 3 tests failed, the new
  drop test and both existing heartbeat tests.
- The probe's timeout no longer drops the socket: the same 3 tests failed.
