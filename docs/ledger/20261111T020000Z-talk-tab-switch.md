# November 11 Talk's ended notice on a tab switch with Talk idle

Branch `t3/talk-tab-switch` over `origin/main` at `23e758b`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2.
Web client only.

## What changed

`useTalk` (`src/app/use-talk.ts`) ran `end()` on every `visibilitychange` to hidden on a phone and on every `pagehide`,
whether or not Talk was running. On a phone with Talk idle, a tab switch set "Talk ended when the app went to the
background." for a call that never ran, and replaced any earlier notice, such as the five-quiet-minutes one. Both
handlers now return unless `parts.current.live` is set, which `start()` sets before it connects and `release()` clears,
so a tab switch during connecting still ends Talk.

## Tests and red proof

`tests/talk-ui.test.ts`, "when the page leaves": a table of idle Talk on a phone (no notice), live Talk on a desktop
(keeps going) and live Talk on a phone (ends, notice shown, resources released); a notice from an earlier end survives a
`pagehide` and a tab switch that find Talk idle; `pagehide` releases live Talk with no notice. Each line broken by
hand, `npx vitest run tests/talk-ui.test.ts`, then restored:

- `&& parts.current.live` removed from the `visibilitychange` handler: the idle-phone case fails (1 failed).
- `if (parts.current.live)` removed from `pagehide`: the earlier-notice case fails (1 failed).
- `&& phone()` removed from the `visibilitychange` handler: the desktop case fails (1 failed).
- `if (parts.current.live) end()` replaced by `if (false) end()` in `pagehide`: the release case fails.

## Not exercised

A real phone browser backgrounding a tab; jsdom dispatches the events.

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 201 files, 3433 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 29 passed.
