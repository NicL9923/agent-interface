# November 15 phone Back navigation

Branch `t3/phone-back-navigation` from `origin/main` at `2144c0b8`, run on the Mac mini (Node 24.22.2, Playwright's full
Chromium). Nothing was deployed by this entry. Source state `sha256:b41cd171b28b504244e92682c019291c45cf31ac3c464a443e3fe2f2d879be4a`
before the e2e spec and README were added; the code under test is `src/app/history-nav.ts` and its use in `src/App.tsx` and
`src/app/view.ts`.

## Red runs

`e2e/back-navigation.spec.ts` (16 tests, 390px phone and 1280px two-pane). Each line below was broken by hand, the spec run,
and the line restored byte for byte; the restored spec passes 16 of 16.

| Broken line | Result |
| --- | --- |
| `window.addEventListener("popstate", popped)` in `useBackNavigation`, never registered | 12 failed, 4 passed: every test that presses Back from a chat, Today, Search, a link, a notification, a reload or a sheet. The 4 that pass need no popstate: the on-screen Back, resizing, two-pane choices. |
| `history.go(depth - landed)`, the pop when the screen steps back | 2 failed: "the on-screen Back leaves no entry behind", "a phone widened to two panes drops its entry". |
| `stepBack`'s sheet branch changed to `if (panel) return true;`, so Back never closes the sheet | 3 failed: sheet over home, sheet over a chat, edited sheet asks first. |
| `depth` without the `mobile &&` condition, so two panes push too | 1 failed: "choosing chats adds no entries, so one Back leaves the app". |

## Checks

- `.agents/tools/check-all --keep-going`: typecheck, lint, ruff, build pass. Vitest 3909 of 3912; the 3 failures are the
  tests that need the `127.0.0.2` loopback alias, which this Mac does not have. Python skipped by the tool: no Python change.
- e2e: 71 of 71 on a run alone, which includes `e2e/back-forward-cache.spec.ts`. In the `check-all` run, which shares
  the machine with Vitest, `smoke.spec.ts` "a reply keeps growing across a tool call" failed once on a console error
  (`<rect> attribute height: A negative value`) from an animation, and passed 6 of 6 alone afterwards. It does not touch navigation.

## Not exercised

- A physical phone's system Back gesture, and an installed Android app. Chromium's `page.goBack()` stands in for both.
- A group chat on a phone. It takes the same path as Today and Search (`selectRoom` closes the home list), but the e2e
  server hosts no group coordinator, so no spec opens one.
- The service worker's `client.navigate` fallback (rule 4 in `scripts/service-worker.js`), a full navigation that adds an
  entry of the old document.
