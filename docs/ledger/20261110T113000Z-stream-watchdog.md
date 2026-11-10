# November 10 a silently dead event stream is replaced within 25 seconds

Branch `t3/stream-watchdog`, from `origin/main` at `39e35a6`. Checks ran on NicolasLaptop (Fedora,
Linux x86_64, Node 24.22.2) in Chromium only. No real Hermes, iOS build, deployment, Safari, Firefox or
phone ran.

## What main did

- The server pinged every stream with `event: ping`, `data: ping`, every 25 seconds
  (`src/server/event-stream.ts`). It sent no comment lines.
- The client recorded the time of each event, ping included. It judged a stream dead only when a
  caller called `open` and 60 seconds had passed without an event (`src/client-api.ts`, `STREAM_SILENCE`).
  Callers call `open` from the chat's 30-second poll and from the household and room streams'
  45-second timers, so a dead stream went unnoticed for up to 90 or 105 seconds.

## What changed

- `?ping=10` makes the server ping as the stream opens and every 10 seconds, with `data: 10` naming the
  interval. Any other value, or none, keeps `data: ping` every 25 seconds.
- The web client adds `ping=10` to every stream. Each stream has one watchdog timer. A stream with no
  event for two ping intervals plus 5 seconds is replaced. That is 25 seconds at a 10-second interval,
  and 55 seconds for a server that names none. The client learns the interval from each connection's
  pings, so a server that ignores the parameter is never mistaken for a dead one.
- A replacement that hears nothing doubles the next wait, up to 5 minutes. Any event resets it. A
  refused stream, which `EventSource` never retries, is retried the same way.
- A hidden page replaces nothing; showing it calls `open`, which checks at once. A device waking from
  sleep fires each stream's single timer once, so each stream reconnects once.
- Events from a stream that has been replaced are ignored.

Why 25 seconds: one ping can be lost or arrive up to 15 seconds late without a reconnect. A stream that
died just after a ping is found within 25 seconds, and one that died just before the next within 15.

## What old clients see

- The iOS app opens `/api/bots/:id/events?inflight=2` and `/api/events` without `ping`. It receives
  the same bytes as before. Its chat parser ignores `data: ping` and treats any other unknown data as
  a change. Its household parser acts only on `data: roster` and `data: groups`. No new event exists.
- Cached web bundles and `?inflight=1` and `?inflight=2` streams do not send `ping` and are unchanged.

## Measurements

`node .agents/tools/measure-dead-stream.mjs` runs real Chromium against `e2e/server.ts` through a TCP
proxy. At the cut, the proxy stops forwarding every open connection without closing it. The tool reports
seconds from the cut until each stream's next request.

| | Household stream | Chat stream |
| --- | --- | --- |
| `main` 39e35a6, 2 runs | 82.0, 82.0 s | 82.0, 82.0 s |
| This branch, 2 runs | 17.0, 17.0 s | 17.0, 17.0 s |

Request counts from `node .agents/tools/count-stream-requests.mjs`, same method as the stream open
reads entry:

| Scenario | `main` 39e35a6 | This branch |
| --- | --- | --- |
| Cold load | 10 | 10 |
| Wake after 70 s hidden | 12 | 12 |
| Idle chat, 10 min | 113 | 113 |
| Idle home, 10 min | 113 | 113 |

The watchdog adds no request. Neither tab reopened a stream in 10 idle minutes, so no live stream was
taken for a dead one.

## Checks

- `npm run typecheck`, `npm run lint`: passed.
- Touched test files: `stream-watchdog` (new, 13), `group-watch`, `connection-ui`, `app-ui`,
  `collaboration-ui` and `home-groups-ui` passed.
- `npm test`: 183 files, 3,052 tests passed. The known flaky transcript test did not fail.
- `npm run build`: passed.
- `npm run test:e2e`: 19 passed.

## Red proofs

A scratch script broke each line by hand, ran the protecting tests, and restored the source. All 15
mutations went red. One stayed green on the first run, because the test counted timers only after the
leftover timer had fired harmlessly. The test now checks right after closing.

- Server: any `ping` value made fast; no ping at open; a fast stream at the old interval.
- Client: silence without the 5-second slack; no backoff ceiling; an event not resetting the backoff;
  an event never bringing the timer closer; replacing while hidden; a replaced stream's events
  counting; any number taken as an interval; the interval kept across connections; `open` replacing a
  fresh stream; a refused stream never retried; `close` leaving the timer; no `ping=10` in the URL.

## Not exercised

- The iOS app, real phone radios and sleeping laptops. A sleep was simulated with a pinned clock jump.
- Battery or data cost of 10-second pings on web clients: 24 bytes per stream every 10 seconds.
