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
- The web client adds `ping=10` to every stream. Each stream has one timer. A stream with no event for
  two ping intervals plus 5 seconds counts as dead. That is 25 seconds at a 10-second interval, and 55
  seconds for a server that names none or a connection that has not pinged yet. The client learns the
  interval from each connection's pings, so a server that ignores the parameter is never mistaken for a
  dead one. This health deadline never grows; the retry delay below is separate.
- Events from a stream that has been replaced are ignored, and the replaced connection is closed.

Why 25 seconds: one ping can be lost or arrive up to 15 seconds late without a reconnect. A stream that
died just after a ping is found within 25 seconds, and one that died just before the next within 15.

### One retry deadline (review fix, item 1)

The first round let the owners' periodic `open` calls, every 45 seconds for the household and room
streams and every 30 for the chat, replace a refused stream at once, and left a dropped stream to
EventSource's own `retry: 3000`. Now every new connection after a failure waits for one deadline.

- A refusal, a drop and a silent stream all close the connection and wait `retryDelay(failures)`: a
  ceiling of 2 seconds doubling to 5 minutes, of which a random half or more is waited ("equal jitter",
  AWS Architecture Blog, "Exponential Backoff And Jitter"). The first retry waits 1 to 2 seconds.
- `open` never starts an attempt before that deadline, so the owners' timers add none.
- The count resets only when a connection is heard at least half a ping interval after its headers
  arrived, which only a ping after the greeting can be; the half allows for delivery jitter. A greeting
  and the household `groups` notice arrive at open and prove nothing, so a server that greets and then
  stalls keeps backing off instead of retrying every 25 seconds. The clock starts at the headers, not
  the request: found while fixing the idle polling branch, a replacement whose headers took 28 seconds
  counted its greeting as recovery.
- Decision: the browser's own reconnects come under the policy. A drop closes the stream and retries in
  1 to 2 seconds, faster than the 3 seconds before, so a brief blip costs nothing. A server that stays
  down sees the same backoff as one that refuses.
- `close` ends the episode, so a page shown again connects at once. The third round replaced this for a
  hidden page, which now suspends its stream and keeps the budget. `reconnect`, which the owners call
  for the browser's `online` event and for the manual reconnect, drops the backoff and connects unless a
  stream is open. Both are evidence that the old failures are stale. Without it, a phone back from a
  long offline stretch could wait up to 5 minutes for a stream while its polls ran.
- The random source is injected (`changeStream(..., { random })`), so tests pin the jitter.

Attempt times in a ten-minute outage, at the middle of the jitter (each wait three quarters of its
ceiling), from a stream that was healthy at second 0. The test runs each with the owner calling `open`
every 45 and every 30 seconds, and the times do not change.

| Server | Attempts, seconds after the outage began | Count |
| --- | --- | --- |
| Refuses | 1.5, 4.5, 10.5, 22.5, 46.5, 94.5, 190.5, 382.5 (next 607.5) | 8 |
| Accepts and stays silent | 26.5, 84.5, 145.5, 212.5, 291.5, 394.5, 545.5 | 7 |
| Greets, then stalls | 26.5, 54.5, 85.5, 122.5, 171.5, 244.5, 365.5, 582.5 | 8 |

The first round, for comparison: refusing, 0, 25, 45, 90, 135 and every 45 seconds to 585, 14 attempts;
greeting then stalling, every 25 seconds, 24 attempts. With jitter at its extremes each wait is half
or all of its ceiling, so a refusing server sees 10 attempts in 10 minutes at the lowest draw
(1, 3, 7, 15, 31, 63, 127, 255, 405, 555) and 8 at the highest (2, 6, 14, 30, 62, 126, 254, 510).

### Late timers (review fix, item 10)

- When the timer fires, the stream's already queued events run before the verdict: the check yields
  one zero-delay task. A busy main thread or a proxy that delivers pings in a burst can queue a ping
  behind the timer.
- A timer that fires more than 10 seconds late, as after a laptop sleeps or a page is frozen, restarts
  the deadline once instead of replacing the stream. An event clears that grace. A second late timer
  with no event between replaces it.
- A hidden page replaces nothing. Owners suspend a hidden page's stream anyway.

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
| First round 2e95e56, 2 runs | 17.0, 17.0 s | 17.0, 17.0 s |
| After the review fixes, 2 runs | 18.4, 18.8 s | 18.1, 18.4 s |
| After the recovery fix 0bc4adb, 2 runs | 18.5, 18.0 s | 19.0, 18.8 s |

The second round adds the first retry's 1 to 2 seconds after the watchdog's verdict.

Request counts from `node .agents/tools/count-stream-requests.mjs`, same method as the stream open
reads entry:

| Scenario | `main` 39e35a6 | First round | After the review fixes |
| --- | --- | --- | --- |
| Cold load | 10 | 10 | 10 |
| Wake after 70 s hidden | 12 | 12 | 12 |
| Idle chat, 10 min | 113 | 113 | 113 |
| Idle home, 10 min | 113 | 113 | 113 |

The watchdog and the retry policy add no request. Neither tab reopened a stream in 10 idle minutes,
so no live stream was taken for a dead one.

## Checks

First round: typecheck, lint, touched files, `npm test` (183 files, 3,052 tests), build and e2e (19)
passed.

After the review fixes, on the commit that adds this section:

- `npm run typecheck`, `npm run lint`: passed.
- Touched test files: `stream-watchdog` (32 after the recovery fix), `event-stream-ping` (new, 13, real Fastify app over a
  socket), `group-watch` (13), `connection-ui` (34), `session-preferences-ui`, `app-ui`,
  `collaboration-ui`, `home-groups-ui` and `draft-sync-ui` passed.
- `npm test`: 184 files, 3,077 tests passed. The known flaky transcript test did not fail.
- `npm run build`: passed.
- `npm run test:e2e`: 19 passed.

### Review fixes, items 2 to 4

- The ping table now runs through the real app and Fastify's query parser over a socket, with only
  `setInterval` virtual. Empty, zero, negative, fractional, `1e1`, `010`, huge, a word, 5, 25 and a
  repeated `ping` all get `retry: 3000` alone at open, nothing at 24.999 seconds and `data: ping` at 25.
  Exactly `ping=10` gets the greeting at open and a ping at 10 and 20 seconds, not at 9.999.
- A fast ping, `event: ping\ndata: 10\n\n`, is 22 bytes, not 24. The test asserts it.
- The assertion that checked elapsed fake time right after advancing it is gone. The watchdog suite
  now asserts the replaced connection is closed, so "old source is never closed" fails there.

## Red proofs

First round: a scratch script broke each line by hand, ran the protecting tests, and restored the
source. All 15 mutations went red. One stayed green on the first run, because the test counted timers only after the
leftover timer had fired harmlessly. The test now checks right after closing.

- Server: any `ping` value made fast; no ping at open; a fast stream at the old interval.
- Client: silence without the 5-second slack; no backoff ceiling; an event not resetting the backoff;
  an event never bringing the timer closer; replacing while hidden; a replaced stream's events
  counting; any number taken as an interval; the interval kept across connections; `open` replacing a
  fresh stream; a refused stream never retried; `close` leaving the timer; no `ping=10` in the URL.

A later commit, 0bc4adb, measured recovery from the headers with half an interval of slack. On it,
typecheck, lint, `npm test` (184 files, 3,079 tests), build and e2e (19) passed; request counts were not
rerun, since nothing they count changed. It ran 4 more mutations:
recovery measured from the request (1 red), a whole interval required (1), exactly half refused (1),
the greeting counted (5). All went red.

After the review fixes, the same script ran 23 mutations against `stream-watchdog` and
`event-stream-ping`. All 23 went red. One stayed green on the first run: `close` keeping the retry
deadline, because the hidden-page test closed a stream that had never failed. A new test closes a
stream mid-backoff and expects it to connect at once when shown.

- Retry: no jitter (5 red); no ceiling (2); `open` ignoring the deadline (3); a drop left to
  EventSource's own retry (1); the greeting counted as recovery (3); `reconnect` keeping the backoff (1);
  `close` keeping the deadline (1, after the new test); an unappliable growth notice counted as a
  failure (1).
- Watchdog: the old source never closed (13); judging without a zero-delay yield (10); no grace after a
  wake (2); grace for every late timer (1); a timer late by exactly 10 seconds forgiven (1); a replaced
  stream's events counting (1); the interval kept across connections (3); any number taken as an
  interval (2); a hidden page replacing (1); silence without the 5-second slack (13); no `ping=10` in
  the URL (1).
- Server, through the real app: a value numerically equal to 10 made fast (2); no ping at open (1); a
  fast stream at the old interval (1); fallback pings saying 10 (12).

## Second review round: repeated revival signals (P2)

GPT-6.1 Sol found that `reconnect` cleared the retry deadline whenever no stream was open. Through the
real conversation hook, a refused stream and 100 `online` events at a standing clock made 101 attempts.
A manual retry could not overlap another check but had no gap between finished ones.

- The first signal of an outage, the network returning or a manual retry that reached the server, still
  drops the backoff and connects at once.
- Later signals in the same outage are coalesced. The next forced attempt starts no sooner than 2 to 4
  seconds after the last one (`FORCED_GAP_MS` 4 seconds, equal jitter as `retryDelay`), and never later
  than the ordinary retry: an attempt already set sooner answers the signal, and one set later is brought
  forward to the gap's end. A signal after the gap has passed connects at once.
- The outage ends, and the next signal connects at once again, when a stream proves itself by the rule
  that resets the backoff, or when the owner closes the stream.
- Why 4 seconds: twice the first retry's ceiling, so a person who presses Retry twice waits at most 4
  seconds, and a flapping network interface forces at most one attempt per stream every 2 to 4 seconds.
  The gap does not grow, so the ordinary backoff still governs a long outage between signals.

Attempts, from `tests/stream-revival-ui.test.ts` through the real `useConversation`, with the clock pinned
at 2026-11-10T12:00:00Z and `Math.random` at 0.5:

| Scenario | Before | After |
| --- | --- | --- |
| Stream refused, 100 `online` events, clock standing | 101 | 2: the opening and the first signal's |
| 100 `online` events 0.1 s apart, each attempt refused | 100 in 10 s | 5 in 10 s after the opening, at 0.1, 1.6, 3.1, 6.1, 9.1 s |

The household and room owners call the same `reconnect`, so the rule covers all three streams.

### Checks, second round

On the commit that adds this section, NicolasLaptop, Chromium only:

- `npm run typecheck`, `npm run lint`: passed.
- Touched and related test files: `stream-revival-ui` (new, 5), `stream-watchdog` (33), `connection-ui`,
  `group-watch`, `app-ui`, `home-groups-ui`, `collaboration-ui`: 214 passed.
- `npm test`: 185 files, 3,085 tests passed. Neither known flaky test failed.
- `npm run build`: passed.
- `npm run test:e2e`: 19 passed.

### Red proofs, second round

The new hook tests ran first against the old `reconnect`: all 4 then written failed, the first with
"expected 101 to be 2", the reviewer's count. A scratch script then broke each protected line by hand,
ran `stream-revival-ui` and `stream-watchdog`, and restored the source. All 9 went red.

- Recovery keeping the gap (1 red, after the test moved proof inside the gap: a 10-second ping takes
  5 seconds to prove a stream, longer than any gap, so the first version could not fail); `close`
  keeping the gap (1, new `stream-watchdog` test); no jitter in the gap (2); every signal connecting at
  once (4); the first signal keeping the backoff count (3); a later signal never bringing the attempt
  forward (1); a later signal pushing back a sooner ordinary retry (2); a signal after the gap waiting a
  tick (1, after a case was added for it); a greeting counted as recovery (1).

## Third review round: hiding the page reset the budget (P2)

GPT-6.1 Sol found that a hidden page's owner called `close`, which cleared `failures`, the retry deadline
and the forced gap, so showing the page connected at once. Through the real conversation hook, a refused
stream hidden and shown 100 times at a standing clock made 101 attempts. Through the real `App` the
household, chat and room streams did the same.

- `changeStream` now returns `suspend` beside `close`. `suspend` closes the connection and its timer and
  keeps the failures, the retry deadline and the forced gap. `close` also clears them, for an owner that
  is done with the stream: the chat's hook on unmount or a chat switch, the session hook on unmount or an
  account change, the room view on unmount. Each of those builds a new stream next anyway.
- The chat, household and room owners suspend on hide, and the household and room owners suspend when
  offline. They close only in their cleanup.
- `open` after a suspension obeys the budget: it connects at once if the deadline passed while hidden,
  or arms a timer for it. A stream that never failed has no deadline and connects at once.
- A stream that proves itself now clears the retry deadline as well as the count. A forced attempt can
  start before the retry it beat was due, and without this a page hidden after it proved itself would
  wait for that stale deadline when shown. The growth-notice path's `drop` and `open` had the same trap.
- `reconnect` inside the forced gap restores the ordinary retry before comparing it with the gap's end,
  because a suspension cleared its timer. Without this, a signal right after a show waited for the gap
  when the ordinary retry was due sooner. The unit test written for the suspension found it.
- Decision: a revival signal that arrives while the page is hidden or the device offline is held, not
  dropped. The household and room owners used to `close` the stream when `online` arrived on a hidden
  page, which cleared the budget, so showing it connected at once; that was the one other caller that
  relied on `close` clearing it. With `suspend` the signal would be lost, and a phone that switched apps
  while its network came back could wait out several minutes of backoff. `reconnect` now checks the page
  itself: on a hidden page or an offline device it suspends and records the signal, and the next `open`
  answers it as `reconnect` would, once. The owners call `reconnect` unconditionally.

Attempts, from `tests/stream-hide-ui.test.ts` through the real `App` (household and chat streams) and the
real `GroupRoomView` (room stream), with the clock pinned at 2026-11-10T12:00:00Z and `Math.random` at
0.5. Each cell is household, chat, room. Before is `af63bd5` with the same tests.

| Scenario | Before | After |
| --- | --- | --- |
| Opening refused, then 100 hide and show cycles, clock standing | 101, 101, 101 | 1, 1, 1 |
| Then 100 `online` events, each attempt refused | 102, 102, 102 | 2, 2, 2 |
| Then 100 more hide and show cycles | 202, 202, 202 | 2, 2, 2 |
| 100 cycles over 100 seconds, hidden half of each second, every attempt refused | 101, 101, 101 | 7, 7, 7 |
| `online` while hidden, shown, refused, hidden and shown again | 3, 3, 3 | 2, 2, 2 |

Seven in 100 seconds is the same as a page left open: attempts at 0, 1.5, 4.5, 10.5, 22.5, 46.5 and
94.5 seconds. Real Chromium request counts, `node .agents/tools/count-stream-requests.mjs --only
cold,wake`: cold load 10 and wake after 70 seconds hidden 12, unchanged; the idle scenarios were not
rerun, since nothing they count changed.

### The three cases

- A tab hidden for a long time during an outage connects at once when shown. The deadline is measured
  from the failure that set it, not from the show, so after an hour hidden it passed long ago. The test
  refuses a chat 10 times, hides it for an hour, shows it and sees the attempt at once; refused again, it
  waits 3.75 minutes from that refusal, because the count is still 11. Before, the count reset and the
  next attempt came 1.5 seconds later.
- A tab hidden and shown rapidly with a healthy server is not slowed. A stream with no failures has no
  deadline, so each show connects at once; the test does it 100 times on all three streams and sees one
  new connection per show. A stream that proved itself has no deadline either, including one forced
  ahead of its retry. Request counts for waking a tab are unchanged.
- Time spent hidden does not count toward the backoff. A hidden page makes no attempt, so hiding is no
  evidence about the server, and growing the ceiling with hidden time would hold a tab back from a
  server that came back while it was hidden. The hour-long outage is still covered: each tab makes one
  attempt when shown and then waits the full backoff its kept count earned. Tabs come back when people
  show them, which spreads them out, and the equal jitter spreads every retry after that. The chat also
  reloads its transcript when shown, so the stream adds at most one request to the one the show
  already makes.

### Checks, third round

On the commit that adds this section, NicolasLaptop, Chromium only:

- `npm run typecheck`, `npm run lint`: passed.
- Touched and related test files: `stream-hide-ui` (new, 11), `stream-watchdog` (35),
  `stream-revival-ui`, `connection-ui`, `app-ui`, `collaboration-ui`, `home-groups-ui`,
  `session-preferences-ui`, `group-watch`: 9 files, 228 tests passed.
- `npm test`: 186 files, 3,098 tests passed.
- `npm run build`: passed.
- `npm run test:e2e`: 19 passed.

### Red proofs, third round

The new tests ran first against `af63bd5`'s source: 5 of the 10 then written failed, the first with
"expected [ 101, 101, 101 ] to deeply equal [ 1, 1, 1 ]", the reviewer's count. The five that passed
protect behavior the old code already had: a healthy stream connecting at once, a forced attempt that
proved itself, the deadline passing while hidden, and the two unmount cases. A scratch script then broke
each protected line by hand, ran `stream-hide-ui`, `stream-watchdog` and `stream-revival-ui`, and
restored the source. All 15 went red.

- `suspend` clearing the budget (7 red); recovery keeping the retry deadline (1, after the test was moved
  to a forced attempt inside the gap: the first signal already zeroes the deadline, so the first version
  could not fail); `reconnect` not restoring the retry after a suspension (1); `open` ignoring the
  deadline (6); a signal while hidden dropped (1); a held signal not answered by `open` (1); a signal
  while hidden connecting anyway (1); a held signal never cleared (red through unbounded recursion, a
  stack overflow that fails the run); the chat, household and room owners closing on hide (6, 3 and 3);
  the chat ignoring a signal while hidden (1); the chat and room views leaving their stream open on
  unmount (1 each); `close` keeping the retry deadline (1).

## Not exercised

- The iOS app, Safari, Firefox, real phone radios, sleeping laptops and real Hermes: not run. A sleep
  and a long task were simulated with a pinned clock.
- Battery or data cost of 10-second pings on web clients: 22 bytes per stream every 10 seconds.
