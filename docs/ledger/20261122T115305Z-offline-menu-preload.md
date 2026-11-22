# The assistant menu's code is not fetched while offline

Recorded 2026-11-22, on `t3/followups-459-462` after merging main at `4e8d0e63`.

## What failed

`e2e/smoke.spec.ts:40`, "the app opens offline from the service worker, then recovers when the network
returns", fails in WebKit. Chromium passes it.

- On this branch: 1 of 202 WebKit tests in `check-all` on `b5715913`.
- On main: both attempts in the Browser smoke job of runs 44884616821 (`f103ecfc`) and 44987114963
  (`4e8d0e63`). It passed on this branch at `6af90509`, before the merge, so it arrived with main's
  connection-states change, #466.

The page health check reports four uncaught errors and two console errors, all for
`assets/BotMenuPopup-*.js` and `assets/useOpenInteractionType-*.js`: "TypeError: Load failed" and
"FetchEvent.respondWith received an error".

## Cause

`BotMenu` loads the menu's popup code when the page goes idle after first paint. Those two files are on the
service worker's background list, so the worker keeps them only once it has fetched them. The test opens a
chat, goes offline and reloads. An offline cold open now draws home's rows from the device, so the rows mount
and ask for the menu code. The worker has not kept it, the fetch fails, and WebKit reports a failed module
load as an uncaught error. The app already handled the failure: the row keeps its stand-in and the next
gesture asks again.

## Fix

The idle load does not run while `navigator.onLine` is false. It runs when the `online` event fires. A
gesture still asks for the code at any time, as before.

## Red runs

`tests/bot-menu-ui.test.ts`, "leaves the menu code alone while offline and fetches it when the connection
returns". Each line was broken by hand in `src/app/BotMenu.tsx` and restored byte for byte.

| Mutant                                     | Result                     |
| ------------------------------------------ | -------------------------- |
| The idle load runs while offline           | Failed: expected 1 to be 0 |
| Nothing waits for the connection to return | Failed: expected 0 to be 1 |

## Checks

- `npx vitest run tests/bot-menu-ui.test.ts`: 7 tests passed.
- `e2e/smoke.spec.ts:40` in WebKit, in Playwright's container under podman, after a rebuild: 4 of 4 passed
  with `--repeat-each=4`.
- The full `check-all` on the commit that holds this change is recorded in the pull request.
