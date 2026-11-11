# November 11 drop a change notice a turn event already covers

Branch `t3/turn-event-notice` over `origin/main` at `08c8f96`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2, Playwright's
full Chromium. Server (`src/server/hermes.ts`, `src/server/conversation-routes.ts`), the shared `withTurn`, the e2e runtime
double, one tool and the native API doc. No Hermes add-on or iOS code changed. `src/server/hermes.ts`, `conversation-routes.ts`
and now `src/shared/inflight.ts` are on `src/shared/qualification-inputs.json` (this branch adds the last, because the route
imports it and `tests/hermes-qualification.test.ts` binds every module a bound module imports), so the host needs a new
qualification receipt (see "Ops").

## What main did

A non-delta Hermes frame sent every watcher a change notice and, with a `?inflight=3` stream open, started the server's own turn
read (`readTurn`). A web client then got the `turn` event and, up to a second later, the notice that made it read the
conversation again for the same messages, tools and activity (#313, #323: `docs/ledger/20261110T060000Z-turn-stream.md`, which
kept the notice "for approvals, requests, files, the draft and the read position").

## Change

- `hermes.ts`: `changed(botId, kind, turnVersion)` tells watchers, for `tool.complete` and `message.interim` only, the structural
  version the turn read after that frame reaches (`watch`'s listener gets `(kind, turnVersion)`; `types.ts`). Other watchers
  (`?inflight=1`, `?inflight=2`, iOS, Talk, the group streams) ignore the second argument and send the notice as before.
- `conversation-routes.ts`: a `?inflight=3` stream on a runtime that reads turns holds that notice instead of sending it.
  The turn event it sends releases the hold when its version reaches the change's (`compareVersions`, so a version from
  another process or an older one never does). The hold ends in the notice when a read lands and no turn event goes out for it,
  or after `TURN_HOLD_MS` (1.5 s) when no read lands. Nothing is held for a frame that names no version, so a write's own notice,
  approvals, requests, errors, a turn's start and end go at once, as before.
- `shared/inflight.ts`: `withTurn` adds the files a turn's rows carry to the conversation's file list, which a read builds from
  the saved rows (`files: rows.flatMap(row => row.files)`), so a file a tool made still shows with its reply without the read.

## Decisions

- Covered frames are `tool.complete` and `message.interim` only. Hermes saves a reply segment before the tool after it and
  announces a progress line after saving it, so a read after either finds its rows. `message.start` is left out: a native turn's
  prompt can be saved after the frame, and the client's read after the start is what heals a turn read that came first (the
  "accepted gap" cases in `tests/live-turn-stream.test.ts` fail with it covered). `message.complete` is left out: its turn event
  has no live reply to carry the finished turn's approvals and files.
- Fail safe by construction: every path that is not "a turn event reached this version" ends in the notice, and an unknown frame
  type is never covered.
- The existing "the change notice still goes, for approvals, files…" assertion in `tests/live-turn-stream.test.ts` described the
  behavior this removes for a tool's finish; it now asserts the notice does not go, and the approvals case has its own test.
  The native-turn cases' helper waits for the turn event instead of the notice after a tool, and reads only after a notice, as the app does.

## Measured

| | main | this branch |
| --- | --- | --- |
| `tests/live-turn-timing.test.ts`, ten-tool turn, Hermes opens on `?inflight=3` | 26 | 18 |
| same, two-tool turn | 10 | 10 (too short for the notice throttle to have sent more) |
| browser, `count-stream-requests.mjs --only turn` (Trail Cook, one tool), conversation reads after the first | 3 | 2 |
| same, all `/api` requests | 10 | 9 |

The browser figure is one run each: this branch against `e2e/server.ts` with `conversation-routes.ts` from `origin/main`, then with
this branch's. The scenario is new in the tool; `e2e/server.ts` now names the version for the tool's finish, as the runtime does.
Reads saved per turn are one per covered frame the notice throttle would not already have merged.

## Tests

- `tests/conversation-events.test.ts`, route against a scripted runtime: the event releases the hold and no notice goes; a read
  that lands with no live reply sends the notice at once, once; a turn event from before the change, or another process's, does
  not release it; one hold for several changes; the notice after `TURN_HOLD_MS` and not before; a frame naming no version goes at
  once; a runtime without turn reads, and `?inflight=1` and `?inflight=2`, never wait; closing the stream leaves no timer.
- `tests/live-turn-stream.test.ts`, real runtime over a fake socket: a mixed `?inflight=1`, `2` and `3` set of streams after a
  tool (the two legacy ones get the notice, the turn stream does not); an approval, a cancelled request, an error, a turn's start
  and an unknown frame each send the notice at once; the notice goes after `TURN_HOLD_MS` when the read is held.
- `tests/live-turn-runtime.test.ts`: which frames name a version, table-driven, and that the turn read after one reaches it.
- `tests/live-turn-client.test.ts`: `withTurn` adds the turn rows' files once, keeps the list when none is new, and invents none.

## Red runs

| Broken | Result |
| --- | --- |
| the hold never taken (`changed()` always) | 8 red across stream, route and timing tests |
| the hold released by any turn event | "keeps waiting through a turn event from before the change…" red |
| the fallback after a read with no turn event removed | "sends the change notice the moment a read lands…" red |
| `holds` true for every opted-in stream | 6 red, incl. both legacy streams and a runtime without turn reads |
| the hold timer not cleared on teardown | "stops waiting when the stream closes…" red |
| `message.start` covered | 20 red: the runtime table, the native-turn cases, the timing figures |
| `message.complete` covered | the runtime table and the settling test red |
| `withTurn` not merging files | "gains the files a turn's rows carry…" red |
| `restoredRead` consumed before the `writable()` check (review fix) | only the new "sends the change notice when the read that landed during a stalled client's backlog is answered" red: no notice written after the client catches up. It survived every other test before |

## Review fixes (Claude Opus 5.5 on `fa11cc9`)

- P3, `tests/conversation-events.test.ts`: the backpressure-plus-hold path. A real client socket stops reading, the reply
  grows until the socket holds an update the client has not taken, a change naming a version is held, and the server's read
  lands with no live reply. Nothing is written while the client stalls; once it catches up the stalled tick's read is
  answered and the held notice goes at once, before the hold's 1.5 s would have ended and once only. Run six times in a row
  without a failure.
- P3, `docs/native-api.md`: the released notice goes through the stream's one-a-second limit, so the worst case, no read
  landing, is about 2.5 s after the change (1.5 s hold, then up to 1 s of throttle). The paragraph says so.

## Checks

`.agents/tools/check-all` at the commit (py ran because the diff touches a file the Python tests read):

```
check      result  queued  run    counts
typecheck  pass    -       0.7s   -
lint       pass    -       0.2s   -
ruff       pass    -       0.0s   -
test       pass    -       15.2s  205 files, 3693 tests
build      pass    -       1.5s   892 modules
e2e        pass    -       1m14s  40 tests
py         pass    -       4m07s  46 files

All 7 checks passed (5m40s total, 0.0s of it queued for heavy slots)
```

## Ops and compatibility

`src/server/hermes.ts`, `conversation-routes.ts` and `shared/inflight.ts` are qualification inputs, so a release needs a new Hermes qualification receipt as for #313 and #323. Wire
format is unchanged: the `watch` listener gains an optional second argument that other listeners ignore. A web bundle from before
this change keeps working against a new server (it reads on the notice it still gets, or on the turn event), and a new bundle
against an old server gets every notice. iOS, on `?inflight=1` and `?inflight=2`, is untouched.

## Not exercised

No real Hermes run: the 1.5 s hold and the saved-before-the-tool ordering come from the add-on's documented behavior and the
existing ledgers, and the browser figure is from the scripted runtime. A file produced by a tool and shown before the turn ends was
checked at the client function (`withTurn`), not in a browser.
