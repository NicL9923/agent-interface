# November 11 less work per keystroke and per streamed delta

Branch `t3/keystroke-delta-work` over `origin/main` at `08c8f96`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Web client only; no server, Hermes add-on or iOS code changed, and no file on `src/shared/qualification-inputs.json` is touched.

## What main did

The draft lives in `App`, so each keystroke renders `App`. Three things in it did work that a keystroke or a delta does not change:

- `ChatHeader` re-rendered each time, because it was not memoized and got a fresh inline `onDetails`.
- `latestMessageAt(...)` ran in `App`'s render body, parsing every message's time per render.
- `deliveredRuns` in `useRoutineRuns` (messages times runs) re-ran for every streamed delta, because a delta replaces the
  `messages` list its memo was keyed on, though only the live row changed.

## Change

- `src/app/use-saved-messages.ts` (new): `useSavedMessages` returns the saved rows (no `-inflight` row) and keeps the same list
  while no saved row is added, removed or replaced. A delta keeps every saved row's object, so the list survives it. Keyed on the
  rows themselves and not on the last saved ID, so an edit to a saved row still recomputes.
- `src/app/unread.ts`: `useLatestMessageAt(bot, messages)` computes the newest time over the saved rows in a memo; `App` uses it.
- `src/app/use-routine-runs.ts`: the delivered-run match and the oldest-message time read the saved list.
- `src/app/ChatHeader.tsx`: `memo`. `src/App.tsx`: `showDetails` is a `useStableCallback`.

## Measured

Same tests run on main's sources (the four changed files restored from `origin/main`) and on this branch. The app runs whole
through the real client against a fake fetch and event stream; `Date.parse` is counted per message time, and the header's renders
are counted at its 42 px avatar.

| | main | this branch |
| --- | --- | --- |
| header renders, 5 keystrokes | 5 | 0 |
| scans of the saved messages, 5 keystrokes | 5 | 0 |
| scans, 3 streamed deltas | 9 | 0 |
| scans, 1 delta under StrictMode | 6 | 0 |
| App commits, 5 keystrokes (React `Profiler`) | 5 | 5 |
| scans when a message is saved | at least 1 | at least 1, and the delivered run leaves the transcript |

The `Profiler` count stays at one commit per keystroke on both: it cannot show the header's saving, because a `Profiler` reports a commit
when its own parent re-renders even if the memo below bails out, so the header is counted at its leaf. The isolated header tests
(`does not render again for a parent render with the same props`) count the same way.

## Tests

- `tests/keystroke-delta-work.test.ts` (new): header renders and scans per keystroke; scans per delta, also under StrictMode; a
  saved message makes the scan run again and a delivered run leaves the transcript; the header's details still open after a
  draft change; the header re-renders when `avatarState`, `railOpen` or a callback changes.
- `tests/saved-messages.test.ts` (new): `useSavedMessages` keeps its list through live-row changes and returns a new one for an
  arrival, an edit, a removal, earlier messages loading and the live reply being saved; `useLatestMessageAt` reads each saved
  message once across renders and deltas and answers with the newest of preview and saved rows.

## Red runs

| Broken | Result |
| --- | --- |
| `memo` removed from `ChatHeader` | header test and the isolated "same props" test red |
| inline `onDetails` back in `App` | "does not render the chat header again" red (memo alone is not enough) |
| `useLatestMessageAt` without its `useMemo` | 4 red: both keystroke/delta scan tests, StrictMode, the hook's read count |
| `use-routine-runs` memo keyed on `messages` again | delta and StrictMode scan tests red |
| `sameRows` always false | 4 red: list identity, read count, delta, StrictMode |
| `sameRows` compares length only | "returns a new list when a saved message is edited" red |
| `useLatestMessageAt`'s `useMemo` dependencies cut to `[bot]` (review fix) | "moves when one arrives" red: `10:00` where `11:00` is expected. It survived before: each step built a fresh roster row, so the memo recomputed on `bot` alone |
| the same dependencies cut to `[saved]` | the same test red at its roster step: `10:30` where `10:00` is expected |

## Review fix (Claude Opus 5.5 on `18ad9c7`)

P3, `tests/saved-messages.test.ts`: the "moves when one arrives" case now keeps one roster row across its arrival and
live-reply steps, so the saved messages are the only input that changes there. Only the first step still swaps rows, which
is what the `bot` dependency is tested by. No production code changed.

## Checks

`.agents/tools/check-all` at the commit:

```
check      result   queued  run    counts
typecheck  pass     -       0.6s   -
lint       pass     -       0.3s   -
ruff       pass     -       0.0s   -
test       pass     -       15.5s  207 files, 3685 tests
build      pass     -       1.4s   893 modules
e2e        pass     -       1m14s  40 tests
py         skipped  -       -      no changes to Python or a file the Python tests read against origin/main

All 6 checks passed (1m32s total, 0.0s of it queued for heavy slots)
```

## Not exercised

No browser measurement of frame time; the counts are renders and parses in jsdom. A real streaming turn against Hermes was not run.
