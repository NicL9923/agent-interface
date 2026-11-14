# November 14 request and event-loop logging

Branch `t3/request-observability` from `origin/main` at `65ed9eb4`, run on the Mac mini (Node 24.22.2). Nothing was
deployed by this entry.

## Change

An `onResponse` hook logs one warn line for a response of 400 or above or one over a second, with the method, route
pattern, status, `durationMs` and `reqId`. The error handler marks the 5xx it logged so the hook does not repeat it, event
streams opened through `eventStreamConnection` are exempt from the slow check, and a failure that repeats logs once and then
every 10 minutes. `EventLoopMonitor` samples `monitorEventLoopDelay` in 10 second windows, warns at most once a minute when
the p99 passes 50 ms, and its last p99 appears in the readiness details only for a direct loopback caller.

## Application tests

`tests/request-log.test.ts` and `tests/ops.test.ts` run the real Fastify app with a captured log stream, and the monitor
tests block the real event loop. `.agents/tools/check-all` ran typecheck, lint, ruff and the full Vitest suite; the only
failures were the three tests that need the `127.0.0.2` loopback alias, which this machine lacks.

## Red runs

Each broke one line by hand, ran `tests/request-log.test.ts` and `tests/ops.test.ts`, then restored it with `git checkout`.

| Break | Test that failed |
| --- | --- |
| drop the skip for a 5xx the error handler already logged | `logs a thrown 5xx once, through the error handler, and not again here` |
| drop `markStream` from `eventStreamConnection` | `keeps an open event stream out of the slow log but still logs a slow ordinary request` |
| log `req.url` instead of the route pattern | `logs a refused request with its method, route pattern, status, duration and request id, never the URL or query` |
| drop the once-a-minute throttle | `warns at most once a minute` |
| log only slow requests, not 400 and above | five tests, including `logs a reply sent directly with a 503, which the error handler never sees` |
| show the p99 to every caller | `shows the event loop's last p99 to direct loopback callers only` |
| drop the `repeats` count from the reminder line | `logs a repeating failure once with its count at the reminder, so a polling client cannot flood journald` |

## Not exercised

Production journald, a real stalled loop under load, and the iOS and web clients, which read no log line.
