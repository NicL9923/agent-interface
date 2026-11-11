# November 11 a queued send's early thinking row waits for its own turn

Branch `t3/queued-send-row` over `origin/main` at `acec071`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Web client only: `src/app/sent-echo.ts` and `tests/sent-echo.test.ts`. No server, Hermes add-on or iOS code changed,
and no file on `src/shared/qualification-inputs.json` is touched.

## What main did

For an accepted send whose receipt says `turn: "queued"`, Hermes saves the queued row at accept
(`tui_gateway/session_auto_continue.py:439-443`, `_persist_queued_user_row`, "durable AT ACCEPT"), so Hermes's copy shows
in a read while the turn it queued behind still runs. `settledHere` (`src/app/sent-echo.ts`) gave a queued send the
fallback rule: a settled report from a read later than the one that brought the copy ended the early row. That report
is the settle of the turn it queued behind (usually `interrupted` under the default busy mode), or a re-read of it,
so the row left on the wrong turn, and the earlier turn's Retry row replaced it until the queued run opened.

## Change

`settledHere` returns false for `turn === "queued"`. A settled report carries no run ID, so nothing orders it as
this turn's. The row ends the ways it already did: a read that shows the run start (the echo leaves, Hermes's row takes
the same node), a reply after the copy, or `COPY_HANDOFF_MS` after the copy. The started rule, the unknown and
older-add-on fallback, and the copy's-read rule are unchanged.

## Decision: ignore every settled report, not only the first

The task named "the first settled report after `admittedVersion`". A second settled report without a read that showed
the run start between them is indistinguishable from a re-read of the first (the state persists and a version bump is
enough), and a read that shows the run start already ends the echo before any later settled report. So ignoring only
the first adds a state flag and no case it could end correctly. The cost: a queued turn that starts and settles
between two reads, or that Hermes merged away, holds the row for at most the five-second handoff bound.

## Tests

`tests/sent-echo.test.ts`, new describe "a send Hermes queued behind a turn the chat did not show":

- keeps the row through the settle in the copy's read and in reads at versions the started rule would end on
  (`b:0:7`, `b:0:8`, `b:0:9`), for `failed`, `interrupted` and `done`, also when the first read already follows the
  admission;
- ends when a read shows the run start, at the handoff bound (both sides of it), and on a reply after the copy.

The existing "falls back to the copy's read" case listed `queued` among the turns that keep the copy's-read rule; that
is the behavior this change removes, so `queued` left its loop and is asserted in the new describe. Every other
existing case is unchanged.

## Red runs

| Line broken by hand | Result |
| --- | --- |
| deleted `if (echo.turn === "queued") return false;` in `settledHere` | 2 failed, 60 passed: "keeps the row through the settle…" and "ends when a read shows the queued run start, or at the handoff bound". Restored. |

## Checks

`.agents/tools/check-all` at the commit, 1m36s total:

```
check      result   queued  run    counts
typecheck  pass     -       0.9s   -
lint       pass     -       0.2s   -
ruff       pass     -       0.0s   -
test       pass     -       17.7s  205 files, 3647 tests
build      pass     -       2.1s   891 modules
e2e        pass     -       1m15s  40 tests
py         skipped  -       -      no changes to Python or a file the Python tests read against origin/main
```

## Not exercised

No real Hermes run: the queue path was read from the upstream clone, not run. No browser or device check; the row logic
is pure and covered by the unit tests.
