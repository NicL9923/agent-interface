# November 10 the saved home after review: account changes, validation, rooms, offline sign-out

Branch `t3/saved-roster`, after merging `t3/early-bootstrap` (which now carries `origin/main` at
`c2ee202` and `t3/account-transitions`). Checks ran on NicolasLaptop (Fedora, Linux x64, Node
24.22.2, Chromium from Playwright 1.64.1) on the branch's code as committed with this entry. No
server, Python, iOS or Hermes code changed.

## Merge

`src/app/Sidebar.tsx` conflicted with #320, which made one `ConnectionAnnouncer` the only connection
live region. The saved home keeps its disabled Account, Search, New and row menus and its rail text
("Connecting", "Offline", "Can't connect") without a status role, and its waiting panel's text is no
longer a live region. The saved home draws the one announcer in the same place as the full app, or
bootstrap's answer would remount the rail instead of redrawing it in place; the in-place test caught
that.

## Findings and changes

1. Accepted limit: a session revoked elsewhere while this browser is offline shows the saved home
   until the first answer from the server. That answer, a 401, removes the copy, the sign-in hint
   and the theme, writes a signed-out account record and shows sign-in. Stated in README.
2. The saved home in memory outlived its hint. It is now read once per account generation, which
   every account change in any tab, cleared storage, a refused session and the hint's lapse end
   (timer at the lapse, rechecked on `pageshow`, visibility and focus). The old storage listener
   is gone. An old bootstrap answer after the change is discarded by the request guard.
3. Validation: every field of every avatar kind is checked as `src/server/schemas.ts` accepts it
   (shape, family, eyes, accessory, `#rrggbb` color, eye scales 0.6 to 1.5, portrait address and
   origin); every ID (1 to 200), name (255), address (2048, the picture `https://`) and list
   (300 assistants, 100 rooms, 50 members, 30 sections of 100, 100 pinned) has a bound; the stored
   text is not parsed past 200,000 characters; a copy that would fail is never written. No
   catch-all around rendering.
4. Saved rooms whose assistant left the roster bootstrap just verified go at once and stay gone on
   disk when the catalog fails.
5. Offline sign-out: with the first bootstrap failed, the saved home offers **Sign out of this
   device**. It writes a signed-out record with `logout: true`, removes the copy, hint and theme,
   and every tab shows sign-in. While the mark stands, nothing reads bootstrap as that account,
   even on a fresh page; the sign-in screen reads bootstrap only for the CSRF token the server's
   sign-out needs, posts it, and clears the mark, or keeps it for the next focus, return or network.
6. The two class-based assertions now read what a person or screen reader gets: the row's
   "Unread" word, its activity label and its date text.

## Layout shift of the swap

`e2e/smoke.spec.ts`, Chromium against the real server, bootstrap held until the saved home shows,
the page's own `layout-shift` entries summed from release to 500 ms after:

| Bootstrap's roster against the saved one | Desktop 1280×720 | Phone 390×844 |
| --- | --- | --- |
| An assistant removed, at the top | 0.0034 | 0.0239 |
| An assistant new, at the top | 0.0023 | 0.0159 |
| Assistants reordered | 0.0023 | 0.0159 |
| An assistant renamed | 0 | 0 |

All are far below the 0.1 that Web Vitals call good, and each shift is a row really moving because
the roster changed. Nothing was changed for them; the test holds each below 0.1.

## Red runs

- The memory and refusal probes against `2445bc5`, the branch before any merge: 6 of 7 failed for
  the reviewer's reason, the saved home still on screen (`expected true to be false`) after cleared
  storage with a late answer, the hint's lapse, `pageshow` and visibility after an unheard sign-out,
  and a late bootstrap; the refusal case kept no signed-out record. They pass at the merge commit,
  since the account generation from `t3/account-transitions` already drops the copy.
- Validation, rooms and offline sign-out against the merge commit `5b8a849`: 30 of the new cases
  failed, every validation case drawing the copy, the room case still showing Supper plans, and both
  sign-out cases without the button or the mark.

| Mutation, `tests/saved-roster-ui.test.ts` | Result |
| --- | --- |
| Face fields not checked on a geometric avatar | failed: 6 cases |
| Eye scale range not checked | failed: 2 cases |
| Portrait origin not checked | failed: 1 case |
| Picture not required to be https | failed: 1 case |
| Stored size bound removed | failed: 1 case |
| List bound removed | failed: 4 cases |
| String bound `<=` made `<` | failed: the limit case |
| Rooms not pruned on screen | failed: the room case |
| Rooms not pruned on disk | failed: the room case |
| Refresh reads during a pending sign-out | failed: the offline sign-out case (focus while pending) |
| A fresh page reads during a pending sign-out | failed: the later-page case, once it ran in its own module copy; it survived while the file's earlier tests left the generation above zero |
| Offline sign-out without the mark | failed: 1 case |
| The saved copy shows activity | failed: 2 cases |

## Measurement

From the same first-load run as `t3/early-bootstrap`'s ledger, 30 loads per build per load kind,
this branch at `cd32bfb` against `t3/account-transitions` at `148d8ef`: roster painted at 5651, 577
and 293 ms (cold, warm, worker), 317, 281 and 401 ms sooner, each interval clear of zero. The tool
refused to call it a result: the load average rose from 7.1 to 13.2 during the run, from other
agents' work on this shared machine. See `20261110T190000Z-early-bootstrap-review-fixes.md`.

## Application tests

- `npm ci`, `npm run typecheck`, `npm run lint` and `ruff check .` (ruff 0.17.3) passed.
- `tests/saved-roster-ui.test.ts`: 66 tests passed.
- `npm test`: 195 files, 3,320 tests passed.
- `npm run build`, then `npm run test:e2e`: 31 Chromium tests passed, including the eight layout
  shift cases. The first run failed one case, "the app opens offline from the service worker",
  which still looked for the rail's old status role; it now reads the rail's text and the one
  announcer, and the second run passed whole.

## Not exercised

- Safari, Firefox, a real back-forward-cache restore, an installed home-screen app and a real phone:
  not run. Only Chromium runs here; `pageshow` and visibility are exercised in jsdom.
- The accepted limit itself: a session revoked from another device while this one is offline shows
  the saved home until the server answers. Not closed, by decision.
