# November 10 the saved home, third round: the new base, the offline sign-out's record, bounds

Branch `t3/saved-roster`, after merging `t3/early-bootstrap` at `b5b79ec`, which carries
`t3/account-transitions` at `58307d5` and the early bootstrap's own third round (see
`20261110T204956Z-early-bootstrap-third-round.md`). Grok 4.7 reviewed `d73864b`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Chromium from Playwright) on the branch's code as
committed. No server, Python, iOS or Hermes code changed.

## Merge

- `src/app/account-epoch.ts`: the start of a generation keeps both sides: the base clears
  `endedShown` and what the service worker was told, and this branch shows sign-in for a sign-out
  whose server session may still be live. `settle` and `undo` take this branch's `logout` field
  under the base's Web Lock. The base's `tellWorker` and this branch's `pendingSignOut` and
  `signOutFinished` both stay.
- `src/App.tsx`: both imports.
- `src/app/account-change.ts` merged without a conflict but did not compile: `signOutHere` called
  the now-async `beginAccountChange` as if it returned the change. It awaits each step, and the
  saved home's button handles the refusal a tab gets when another tab already changed the account.

## Interactions checked

- The saved home is drawn before bootstrap answers, so it is the screen a page can leave with. It
  is covered on `pagehide` with the plain title and theme, and on `pageshow` with the same account
  comes back as it was, the same row elements and the saved theme, with no new bootstrap read. After
  another tab signed out meanwhile, it was still in the document and covered when the page showed,
  then sign-in replaced it and the cover went.
- Its title is `WildBots` and it sets no app badge, even from a copy that holds unread marks and
  activity it should not.
- "Sign out of this device" in a tab that has not heard another tab's sign-in of member two is
  refused before it writes anything; member two's record and hint stand and the tab draws member
  two. Without the refusal it wrote its own record over member two's.

## Findings and changes

3. P2, the offline sign-out could lose its mark after the copies were gone. The logout record is
   now written and read back before the hint, the roster and the theme are removed
   (`settleKept` in `src/app/account-epoch.ts`). If the write throws, or does not stick, the record
   goes back to member one's, the copies stay, the saved home stays, and it says "Couldn't sign out
   of this device. This browser didn't save the change, so you're still signed in here." in its
   waiting panel, as an alert. The same button works once storage keeps the record.
4. The CSS-class locators: the unit tests read the saved home's state from the main landmark's
   text, and the e2e cases read the rail's connection word from the `Assistants` complementary
   landmark by its text.
5. Today stays enabled on the saved home: `TodayPanel` mounts only with bootstrap's answer, so a tap
   reads nothing before it, as a chosen chat opens only then. A new test checks that the tap sends
   nothing and that `GET /today` follows bootstrap. Names now take the server's bounds where it has
   one: an assistant's name 1 to 100 (`botInput`), a section's up to 100 (preferences), a group's
   1 to 100 after trimming (the group route). The account's name, from the sign-in provider, and a
   group member's, from Hermes, have no server bound and keep 255.

## Red runs

Item 3 before the fix: both cases failed at `showsSavedHome()`: the page showed sign-in with the
copies deleted.

| Mutation | Result |
| --- | --- |
| The write not read back | failed: the case where storage silently drops it |
| No `undo` when the record was not kept | failed: both cases, the record left as the under-way mark |
| No word to the person | failed: both cases |
| `signOutHere` without `ownTree` | failed: the case where another tab already signed member two in |
| The button without its refusal handler | the run failed on an unhandled rejection |
| No cover on `pagehide` | failed: both saved-home cache cases |
| The saved home counts the copy's unread marks | failed: `(3) WildBots` |
| A read for Today at the tap | failed: `GET /today` before bootstrap |
| Assistant, section or group name bound back at 255; empty assistant or blank group name allowed | each failed its own case |

## Checks

- `npm ci` (once, on the first branch), `npm run typecheck`, `npm run lint`, `ruff check .` (ruff
  0.17.3) passed.
- The touched test files: 233 passed. `npm test`: 195 files, 3,358 tests passed.
- `npm run build`, then `npm run test:e2e`: 34 passed, the back-forward-cache file in full Chromium
  among them.

## Not run

Safari, Firefox, an installed home-screen app and a real phone: not run. Only Chromium runs here.
The first-load measurement was not repeated; on the load path only the theme step and `boot.js`'s
reading of the account record changed.
