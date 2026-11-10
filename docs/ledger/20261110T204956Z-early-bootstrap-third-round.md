# November 10 the early bootstrap, third round: the new base, and the theme at the first draw

Branch `t3/early-bootstrap`, after merging `t3/account-transitions` at `58307d5`. Grok 4.7 reviewed
`6159132`. Checks ran on NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Chromium from Playwright)
on the branch's code as committed. No Python, iOS or Hermes code changed.

## Merge

Two files conflicted.

- `src/App.tsx`, the change effect: the base's wider address reset (search, fragment or path)
  is kept; this branch's theme step moved to a layout effect (below). The theme effect: this
  branch's rule (boot.js's theme stays until bootstrap answers, then the account's, and it is
  remembered) is kept, with the base's reset to `system` when the account's screens unmount.
- `tests/account-transitions-ui.test.ts`: both sides added blocks at the same place; both kept.

The base's test "shows neither member one's unread count, app badge nor theme while another tab's
sign-in is on its way" failed on the first merge: this branch put back the saved theme while
another tab's sign-in was marked under way, since the hint and theme key are still stored then.
That wait may end in another account, so the app now shows the system's theme during it, and
`boot.js` applies no saved theme while a mark under 65 seconds old is stored. The orchestrator's
brief said keeping the theme during that wait was right; this shows less of a previous account
and keeps the base's behavior, so it was chosen instead.

## Interactions checked

- Cover and theme. `pagehide` sets `system` and remembers the theme shown, `boot.js`'s included.
  Restored with the same account, the theme comes back with the screens, even before bootstrap
  answered (new test). Restored after another tab signed member two in, every theme the page takes
  from `pageshow` on is recorded, including ones a later commit replaces: none is member one's
  (new test).
- `boot.js` and the cover. A fresh load runs `boot.js` and has no cover. A restore does not run it:
  the page shows the cover with `system` until `pageshow`, then the account's theme if it is
  unchanged, or `system` until the next account's bootstrap. The back-forward-cache e2e cases now
  sign in with a saved dark theme and check the theme at `resume` (`system`, covered) and after.
- The worker. `boot.js` is still answered only from this release's cache, and the account cache is
  not a release cache. A new test installs and activates a next release over a worker that holds
  `wildbots-account`: the account cache stays, and a push for another account is still dropped.
  The older test "removes older releases when it activates" holds no account cache, so it passed
  with an activation that deleted every other cache; the new test does not. The `boot.js` and shell
  tests open only the release cache and still mean what they say.

## Findings and changes

1. P1, the previous member's theme on a page whose bundle mounts after a change finished. App
   sets `data-theme` in a layout effect at each generation's first draw: the saved theme while the
   hint names its account and no other tab's change is under way, otherwise `system`. Bootstrap's
   own answer replaces it, as before.
2. The post-send `accountStill` check in `api()`. It is reachable on its own: removing it fails
   "drops member one from a tab that shows them as soon as another tab starts signing member two
   in", which then shows member one's chat after another tab's mark was written and no event
   arrived. The case the reviewer tried passes without it because bootstrap's own account check
   refuses the answer too. A new test with a single held chat read and no event also passed
   without it, since another step of the chat's first load checks the record (not traced
   further); it added nothing and was not kept.

## Tests

- `tests/account-transitions-ui.test.ts`: the reviewer's sequence for a settled sign-in and a
  settled sign-out, each also with a bootstrap that fails; the saved theme kept when nothing
  changed; the two back-forward-cache theme cases.
- `tests/startup-read.test.ts`: `boot.js` applies no theme under a mark 64,999 ms old, and does
  at 65,000 ms.
- `tests/service-worker.test.ts`: the account cache across a release's activation.
- `e2e/smoke.spec.ts`: a sign-out between `boot.js` and the bundle; the theme at the app's first
  frame is read by a MutationObserver, which runs after React's layout effects and before its
  other effects and paint.
- `e2e/back-forward-cache.spec.ts`: the theme at `resume` and after, in both cases.

## Red runs

The reviewer's sequence, before the fix: both cases failed with `data-theme` still `dark` at the
connecting screen (`expected 'dark' to be 'system'`). `boot.js` under a fresh mark, before its
change: `dark`.

| Mutation | Result |
| --- | --- |
| The first-draw theme step removed | failed: both reviewer cases |
| Saved theme kept during another tab's change | failed: the base's "screen between two accounts" case |
| Saved theme never used at the first draw | failed: "stays on the first draw while the hint still names its account" |
| The first-draw step in `useEffect` instead of `useLayoutEffect` | jsdom passed (it runs both before the assertion); the e2e first-frame case failed with `dark` |
| `uncover` restores the theme after a change | failed: the restore after member two's sign-in recorded `system, dark, system` |
| `uncover` gives no theme back | failed: the base's restore case and the new one |
| Activation deletes every cache but its own | failed: the account cache across activation |
| `api()`'s post-send check removed | failed: "drops member one from a tab that shows them as soon as another tab starts signing member two in" |

## Checks

- `npm ci`, `npm run typecheck`, `npm run lint`, `ruff check .` (ruff 0.17.3) passed.
- The touched files, then `npm test`: 194 files, 3,283 tests passed.
- `npm run build`, then `npm run test:e2e`: 25 passed, the back-forward-cache file in full
  Chromium among them.

## Not run

Safari, Firefox, an installed home-screen app and a real phone: not run. Only Chromium runs here.

## Fourth round: the Grok 4.7 review, merged from `t3/account-transitions`

`t3/account-transitions` merged in without a conflict, bringing `origin/main` at `e7cd5ac` with it.
Its changes and red runs are in `20261110T191900Z-account-transitions.md`, third round: a push
shown after its account left closes with its badge, and the address belongs to the account the
record named when the generation started, so another tab's failed sign-in keeps it and a
connecting screen's address goes before the next account draws.

This branch needs nothing more for them. `public/boot.js` draws only the saved theme before the
app, never an address, and its bootstrap reaches the app through `accountNamed` like any other.
`tests/account-transitions-ui.test.ts` passes here as merged, 41 tests.

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .`: pass. `npm test`: 194 files, 3300 tests.
`npm run build`: pass. `npm run test:e2e`: 25 passed.
