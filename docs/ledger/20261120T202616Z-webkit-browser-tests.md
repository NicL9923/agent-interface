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
