# November 8 bounded connection shutdown

Base `298c02dfb0e4ca99b77f26be50f21ad43fa48700`. Final source fingerprint
`sha256:7646b89981c3cddd5aa19e51c778eb493ebe2836d0ae8c3b9a12e58b96cd4522`.
NicolasLaptop, Fedora Linux, Node 24.22.2, Fastify 5.12.8,
@fastify/websocket 11.3.6, ws 8.22.1, Vitest 5.1.0.

The real Fastify app and real TCP connections reproduced issue #203. With only
the new tests added, shutdown stayed pending after the virtual 25-second grace
period for a silent TCP peer, a hung HTTP response, an unresponsive WebSocket,
and a keep-alive response that had already finished. Those 4 tests failed.

The server now tracks accepted sockets, stops response reuse during shutdown,
and destroys connections that remain after 25 seconds. Tracking raw sockets
also covers upgrades, which Node's closeAllConnections skips. An onResponse
hook closes newly idle connections whose headers preceded shutdown. The
30-second process watchdog shares its budget with the connection deadline.

Validation:

- `npm test -- tests/shutdown-connections.test.ts tests/index-shutdown.test.ts tests/conversation-events.test.ts tests/direct-routes.test.ts tests/computer-api.test.ts`
  unit-passed 77 tests across 5 files at fingerprint
  `sha256:b1b7320d57ea71bf8591d8e2e7199afa439872bf4e8076a04c17e76e045d21b6`.
- After the hosting note and repeated-close assertion, the final shutdown suite
  unit-passed all 6 tests. The production implementation was unchanged.
- `npm run typecheck` compiled the final state, and `npm run lint` passed.
- Five hand mutations failed for the expected reason, then were restored:
  replacing raw-socket destruction with closeAllConnections left the upgraded
  peer pending; removing idle cleanup left the streamed response pending;
  omitting socket removal counted a closed peer; omitting close headers kept
  the active response reusable; and omitting timer cleanup left a pending timer.

Timers are virtual, with checks at 24,999 and 25,000 milliseconds. Connections,
HTTP parsing, response streams, WebSocket upgrade and teardown all run for real.
Bounded real-time waits let socket events settle without moving the virtual
clock. The fake runtime configures only close and throws on unexpected calls.

Claude Opus 5.5 at high effort pressure-tested the design against the real pinned
dependencies. Its two findings, upgraded sockets and finished keep-alive
responses, have dedicated regression tests. Its suggestion to inject a short
production deadline was not used: existing event-stream tests already combine
real I/O with virtual clocks, and the new tests preserve the exact production
boundary without adding a runtime option.

Other paths checked were signal handling, app.close without a listener, repeated
close, active responses, already-streaming responses, SSE, both computer
WebSocket routes and separate direct-route listeners. Direct listeners already
force-close their own connections and have no upgrade handler. No API, auth,
environment variable or wire-format change is required. No browser, iOS build,
production deployment, Apple action or live Hermes session ran.

## CI integration corrections

The first PR CI run, 42514661708, found a qualification import-coverage failure
on both Node versions and an incorrect silent-peer assertion on Node 26. The
qualification suite passes on the base and failed on the new unbound shutdown
module. The module is now included in qualification-inputs.json, so the receipt
binds its source rather than adding another exception.

The silent-peer assertion wrongly required shutdown to remain pending before
the deadline. A real-timer probe of the unfixed base showed the version difference:
after 200 milliseconds, Node 24.22.2 still waited with its peer open, while Node
26.13.0 had already completed close and destroyed the peer. Both used the real
createApp, a real TCP peer and the same fake-runtime close boundary.

Commit f9c6583 corrects that test separately. Silent peers must finish no later
than the deadline and may finish sooner. Active responses still assert both
sides of 25 seconds on both versions. The closed-peer tracking assertion moved
to the hung-response case, which necessarily reaches the deadline. Removing
tracking cleanup there still fails with a count of 2 instead of 1 on Node 26.

At the final fingerprint above:

- Both Node 24.22.2 and Node 26.13.0 unit-passed all 6 shutdown tests.
- Node 24.22.2 unit-passed 14 tests across shutdown, signal handling and Hermes
  qualification.
- Node 26.13.0 unit-passed the full 2,114 tests across 153 files.
- Typecheck and lint passed.

The early-deadline, active-response, stream, upgrade and cleanup checks remain
strict. No production shutdown behavior changed after the original review.
