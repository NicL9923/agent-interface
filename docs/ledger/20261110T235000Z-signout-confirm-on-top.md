# November 10 Settings opened at the sign-out question covers its confirmation

Branch `t3/signout-confirm-on-top` over `origin/main` at `2ce9a04`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2,
Chromium from the Playwright cache. Web client only.

## What changed

`Dialog` (`src/components/ui/dialog.tsx`) opens a dialog that sits inside another `<dialog>` only after that outer
dialog is open. React runs a child's effect before its parent's, so Settings opened at the sign-out step (its
confirmation is mounted with it) called `showModal` on the confirmation first and on the sheet second, which put
the sheet above it in the top layer. An inner dialog whose outer one is still closed now watches the outer dialog's
`open` attribute and opens when it changes. An inner dialog that mounts later, or whose outer dialog is already open,
opens at once as before.

`e2e/smoke.spec.ts` and `e2e/back-forward-cache.spec.ts` pressed the confirmation's Sign out button with
`dispatchEvent("click")`, because a real click found the sheet's rows in the way. Both now click.

## Tests and red proof

- `tests/ui-primitives.test.ts`: nested dialogs mounted together open outer then inner and the inner field holds focus;
  an inner dialog under an already open outer one opens at once; an inner one stays closed while the outer is closed;
  an inner one that unmounted while waiting is never shown afterward.
- `tests/preferences-dialog-ui.test.ts`, "opened at the sign-out question": with a top layer that records open order,
  the confirmation is last and its default answer holds focus; declining it leaves the sheet and focuses its Sign out
  row; any other destination opens the sheet alone.
- `e2e/smoke.spec.ts`, "the sign-out question opens above Settings and holds focus": in Chromium, the point at the
  middle of the question hits the question, focus is inside it, and declining returns focus to the Sign out row.

Each line broken by hand, the two vitest files run (or, for the browser, the build and `npx playwright test -g sign`), then restored:

- `if (outer && !outer.open)` replaced by `if (false)`: 3 vitest tests fail (nested order, closed outer, Settings order).
- replaced by `if (outer)`: 2 fail (outer already open; Settings declining a section delete).
- the `present()` call after the wait removed: 2 fail (nested order, Settings order).
- the observer's `disconnect()` in the cleanup removed: 1 fails (unmounted while waiting).
- the condition replaced by `... && Date.now() < 0` and rebuilt: in Chromium the new smoke test fails (`hit: false,
  focused: false`), and so do the two specs that now click Sign out for real (pointer events intercepted by the
  sheet's rows).

An earlier browser red run that replaced the condition with `if (false)` did not build (TypeScript flagged the unused
`waiting`), so Playwright ran against the stale fixed build and passed. It was discarded and redone as above.

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 199 files, 3382 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 28 passed.

## Review fixes: the observer's callback

Merged `origin/main` at `2f1670e` first, as its own commit. Review found two things in the callback of the observer an
inner dialog uses while it waits for its outer one (`src/components/ui/dialog.tsx`).

- Removing `waiting?.disconnect()` from the callback failed no test.
- The callback opened the inner dialog without checking `outer.open` again. An outer dialog that opened and closed before
  the callback ran (one notice for both changes) left the inner one open above nothing. It now returns when the outer
  dialog is closed, before it disconnects, so the inner dialog opens at the outer one's next opening.

### Tests and red proof

`tests/ui-primitives.test.ts`: "stops watching its outer dialog once it has opened, so a later change to it does not
open it again" (the outer dialog closes and opens again after the inner one opened; the inner one's `showModal` ran
once) and "waits for its outer dialog's next opening when that opened and closed before it could open" (opened and closed
in one change, then opened again). Each line broken by hand, the two vitest files run, then restored:

- `waiting?.disconnect()` removed from the callback: "stops watching" fails.
- `if (!outer.open) return;` removed: "waits for its outer dialog's next opening" fails.
- `disconnect()` moved before the guard (the inner dialog would then never open): the same test fails.

### Checks

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3), `npm run build` passed. `npm test`: 202 files, 3526 tests
passed. `npm run test:e2e` (`E2E_PORT=4580`): 39 passed.
