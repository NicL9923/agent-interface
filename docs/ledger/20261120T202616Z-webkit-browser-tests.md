# November 20 WebKit run of the new browser tests

Code state: the working tree on top of `fa5505be` on `t3/research-openbot-chat-bubbles`. The Fedora
laptop cannot start Playwright's WebKit, so the WebKit runs here used the Playwright container
`mcr.microsoft.com/playwright:v1.65.0-noble` under Podman with the worktree mounted, Node v26.13.1
inside it. That is the same Ubuntu WebKit build GitHub's runners install.

## What CI showed

The Checks workflow was run by hand on the branch so the Browser smoke job would run WebKit before
the merge. Run 44743751856 never reached a test: it spent its 20 minutes installing system packages
from a slow mirror. Run 44794549338 on `5e8fd12c` passed all 142 Chromium tests in 8 minutes and was
cancelled at the 20 minute limit partway through WebKit, with 20 failed attempts, most of them 30
second timeouts.

## What the container showed

| Test                                                                                                  | WebKit result                                                                       | Cause                                                                           |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `cascade-layers.spec.ts`, the four screens that give the chat or the assistant content through routes | Timed out waiting for the routed content                                            | The routes never reach the page in Playwright's WebKit                          |
| `cascade-layers.spec.ts`, the seven plain screens                                                     | Passed alone in all four views; one failed the page-health check once in a full run | Not determined                                                                  |
| `accessibility.spec.ts`, hovered routine cards and the selected avatar state                          | Timed out opening the assistant's settings                                          | The same route                                                                  |
| `accessibility.spec.ts`, both bubbles under forced colors                                             | The reply bubble's border read transparent                                          | Playwright's WebKit takes the forced-colors setting and draws as if it were off |
| `accessibility.spec.ts`, both bubbles under increased contrast, and the solid bubble while sending    | Passed                                                                              |                                                                                 |
| `phone-overlays.spec.ts`                                                                              | 2 passed                                                                            |                                                                                 |
| `stylesheet-order.spec.ts`, with the new layer order test                                             | 16 passed                                                                           |                                                                                 |

## What changed

- `e2e/cascade-layers.spec.ts` runs in Chromium only. Which rule wins between layers is the
  cascade's answer for these stylesheets, the same in every engine, and Chromium is the engine in
  which the guard can force hover, focus and press. `stylesheet-order.spec.ts` still reads the plain
  screens in WebKit.
- The hover contrast test runs in Chromium only, for the same route.
- The forced-colors case of the bubble edge test is skipped in WebKit. The increased-contrast case
  still runs there.

No assertion changed.

## Checks

| Check                                                          | Result                                                             | Evidence                                     |
| -------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| Typecheck, lint, format check                                  | Compiled and passed                                                |                                              |
| Whole suite, WebKit, in the container                          | Runtime-exercised: 90 passed, 51 skipped, 1 failed, in 3.3 minutes | `.private/webkit/full-webkit-1.log`          |
| `accessibility.spec.ts` and `cascade-layers.spec.ts`, Chromium | Runtime-exercised: 56 passed                                       | `.private/webkit/chromium-after-scoping.log` |

The one WebKit failure is `e2e/smoke.spec.ts:811`, "the message box floats over the transcript,
whose latest message rests just above it". It fails on main in CI at the same line with the same
message, on both pushes since #456. It waits for a routed long chat, so it looks like the same
cause as the timeouts above. Of the 51 skips, 48 are the ones scoped here and 3 are the worker badge
and back-forward cache tests WebKit already skipped.

## Not done

- Finding out why routes do not reach the page in Playwright's WebKit. It keeps two of main's smoke
  tests red and is recorded on issue #462.
- A browser-level check of the app in Safari itself.

## Later the same day: the scoping was replaced

An independent review of the commit above objected to the file-wide skip: the plain screens had
passed in WebKit, the skip would also cover any later test in the file, and a Chromium-only guard
leaves a layer-induced change in Safari unread. It also pointed at tests in this repository that
use the same route pattern in WebKit and pass, because they block the service worker. All three
skips are gone.

| Finding                                            | What the evidence showed                                                                                                                                              | Change                                                                                                                             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The routed screens timed out                       | With `serviceWorkers: "block"` the routed content arrived at once. Worker-owned requests bypass page routing in WebKit, as `e2e/bot-exchanges.spec.ts` already says   | The guard and the hover contrast tests block the worker                                                                            |
| Nine guard tests then failed the page-health check | Each reported "ResizeObserver loop completed with undelivered notifications." The same three screens opened without swapping the cascade raised none in 24 of 24 runs | A new `allowPageError` fixture, beside `allowConsoleError`; the guard allows that one message                                      |
| The forced-colors bubble edge                      | WebKit reports `(forced-colors: active)` as matching and does not recolor a transparent border, so the reply bubble's border stayed transparent                       | Both bubbles get an explicit `forced-colors` border in `CanvasText`. The test skips only when the page does not report the setting |

The first table's cause, "the routes never reach the page", was an inference. Blocking the worker restored page routing; it is the only change between the timeouts and the passes. The worker's own fetch handler returns early for `/api/`, so how a registered worker defeats routing in Playwright's WebKit is not established.

| Check                                                                            | Result                                                                | Evidence                               |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Guard in WebKit with the worker blocked and no allowance                         | 36 passed, 9 failed on the ResizeObserver message                     | `.private/webkit/guard-sw-blocked.log` |
| The three rich screens opened without the swap, WebKit, twice each in four views | 24 passed                                                             | `.private/webkit/guard-reach-only.log` |
| Whole suite, WebKit, before the forced-colors rule                               | 137 passed, 3 skipped, 2 failed: the forced-colors edge and smoke 811 | `.private/webkit/full-webkit-2.log`    |
| `accessibility.spec.ts` and `cascade-layers.spec.ts`, WebKit, with the rule      | Runtime-exercised: 56 passed                                          | `.private/webkit/webkit-3.log`         |
| Those two plus `phone-overlays` and `stylesheet-order`, Chromium                 | Runtime-exercised: 74 passed                                          | `.private/webkit/chromium-final.log`   |

The three skips that remain in WebKit are the worker badge and back-forward cache tests it skipped
before this branch. `e2e/smoke.spec.ts:811` still fails there as it does on main; it does not block
the worker, which is the likely fix and is noted on issue #462.

A last review pass asked for two tightenings, both made. The guard allows the ResizeObserver message
only in WebKit and only between its first cascade swap and the return to the built cascade; the
page has to be free of it while the screen opens and after the swap settles. And the bubble edge
test asserts that the page reports the contrast setting it asked for, where it used to skip when
the page did not.
