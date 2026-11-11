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

## Fourth round: the Grok 4.7 review

`t3/early-bootstrap` merged in without a conflict, bringing `t3/account-transitions`' third round
and `origin/main` at `e7cd5ac`. Their changes and red runs are in
`20261110T191900Z-account-transitions.md`.

### Changes on this branch

- The saved home counts as drawing the account its copy names (`drawingAccount` in
  `src/app/account-epoch.ts`, called from `AccountApp` before paint). The address belongs to that
  account even where no record names it, as on a browser signed in before the record existed, so
  the next sign-out or account clears it. A bootstrap that names another account than the saved
  home drew ends the generation, as one after an earlier bootstrap does; before, member two took
  over member one's saved-home generation with its address and any chat chosen there.
- The offline sign-out ends this browser's push subscription once its record has stuck
  (`signOutHere`, through `endPushSubscription`). It does not when storage refuses the record,
  since the person is still signed in.

How the address resolves on this branch, the saved home included:

| Case | Address |
| --- | --- |
| Same account put back by another tab's failed sign-in | kept, with its chat and fragment |
| Another account settles | reset before it draws |
| Sign-out, online or offline, from any screen | reset before sign-in draws |
| Address opened while signed out | kept for the next sign-in |
| Connecting screen under a record that names an account | reset at the next account or sign-out |
| Saved home, with or without a record naming its account | reset at the next account or sign-out |
| Saved home drawn, bootstrap names another account | the generation ends and the address resets |

### Finding 4, the push subscription at sign-out

- The server's `POST /api/auth/logout` deletes the session and nothing else
  (`src/server/auth.ts:218`). Subscriptions are keyed by endpoint and user
  (`src/server/store-notifications.ts:196-208`), so a sign-out the server takes leaves them.
- The online sign-out calls `notifications.disable()` before `signOutOf` (`src/App.tsx:281-284`;
  the same on `main`), which sends `DELETE /push/subscriptions` and unsubscribes the browser. That
  path already stops pushes.
- The app never subscribes without a person's action: `refresh` only reads
  (`src/components/use-device-notifications.ts:50-80`), and `pushManager.subscribe` runs only in
  `enable` (line 126), from the Settings switch or the one-time prompt. So unsubscribing turns notifications
  off until the person turns them on again, which the online sign-out already does today.
- Only the offline sign-out kept the subscription, with the server still sending member one's
  pushes to it. Ending it in the browser matches the online sign-out; the server drops the
  endpoint at its next push, when the push service answers that it is gone
  (`webPushDead` in `src/server/notifications.ts`).

### Tests

`tests/saved-roster-ui.test.ts` finds the rail by its label, rows and the sign-out confirmation by
their text, the connecting screen by its heading, sign-in by its button and the conversation by
its region label. Two class queries stay: `.home-scroll`, whose node identity is the check that
the swap keeps scroll, has no role or label; `order()` reads `.pinned-name, .bot-row-name strong`,
the names alone, which a row's text mixes with its description.

### Red runs

| Mutation | Result |
| --- | --- |
| The saved home does not mark its account | failed: the bootstrap-as-someone-else test and the no-record sign-out test |
| `accountNamed` ignores the saved home's account | failed: the bootstrap-as-someone-else test |
| The offline sign-out keeps the subscription | failed: the offline sign-out test; the next test failed after it, since the first stopped before ending the server's session |
| The subscription ends before the record sticks | failed: the refused-storage test |

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .`: pass. `npm test`: 195 files, 3378 tests.
`npm run build`: pass. `npm run test:e2e`: 34 passed.

### Not exercised

- A real push service answering for an ended subscription, and Chrome's background notice for a
  dropped push: not run.
- A session the server refuses leaves the subscription with the server and the browser, as before
  this change. Ending it there would turn notifications off at every lapsed session, since nothing
  subscribes again without the person; that is a follow-up, not this stack's.

## Fourth round: the account transitions' fourth review, merged from `t3/early-bootstrap`

`t3/early-bootstrap` at `147087c` merged in as `448d1f2`, bringing `t3/account-transitions` at
`ad3b65b` and `origin/main` at `145104f` (merged on `t3/account-transitions` as
`4375e9569a30d602d504c2d1b5fd449c8de34b67`). Two conflicts, both resolved by hand:

- `src/app/account-epoch.ts`: the base's new `accountOf`, which reads `fromSignedOut` on a
  changing mark, kept beside this branch's `drawnHere`.
- `README.md`, the address paragraph: this branch's sentences on the saved home kept, with the
  base's sentence on a page opened during another tab's sign-in from signed out.

The changes, the worker's ordering discipline, the enumeration test and the page-side table are in
`20261110T191900Z-account-transitions.md`, fourth round. The worker's account code and its tests
are the same here as on the base.

This branch adds one record to the page-side table, the offline sign-out's
`{ signedOut, logout, user }`:

| This tab | Record | Address | Test |
| --- | --- | --- | --- |
| The tab that signs out offline | its own `logout` record | dropped | saved-roster-ui: "leaves nothing of member one's for the next member: no address, fragment or push subscription" |
| Showing member one in another tab | `logout` record | dropped: it is a sign-out to `accountOf` | same branch as the logout-record rows of the base table |
| Opening during a sign-in that began from a `logout` record | the mark carries `fromSignedOut` | kept for the next sign-in, as after any sign-out | the writer's sign-out row in account-epoch.test.ts: `previous.signedOut` is the branch for both |

### Red runs on this branch

- The new tests against this branch's files at `9268927` (`scripts/service-worker.js` and
  `src/app/account-epoch.ts`): 13 failed, for the same reasons as on `t3/account-transitions`; the
  enumeration broke 2274 of 4000 orders with the same counts per invariant.
- Every mutation in the account-transitions table, run again here: the same result for each.

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3): pass. `npm test`: 200 files, 3460
tests. `npm run build`: pass. `npm run test:e2e`: 38 passed.

## Fifth round: the account transitions' fifth review, merged from `t3/early-bootstrap`, and an owed logout

`t3/early-bootstrap` at `8360a83` merged in as `bcf1de0`, bringing `t3/account-transitions` at
`6695309` (its fifth round, in `20261110T191900Z-account-transitions.md`) and `origin/main` at
`785f4f2`. One conflict, in `accountStart` of `src/app/account-epoch.ts`, resolved by hand: it keeps
the signed-out word to the worker that the base added, and this branch's rule that a sign-out whose
server session may be live shows sign-in on a fresh page.

### P1: an offline sign-out undone by a sign-in whose tab closed

Reproduced through the real `App` against the test server before the fix: member one signs out
offline (`{ signedOut, logout, user: one }`); a later page shows sign-in and its attempt to end the
server's session gets a 503, so the record stays; someone submits the sign-in form and the request
hangs, so `beginAccountChange` writes `{ changing, fromSignedOut, user: one }` and drops `logout`;
the tab closes; 66 seconds later a new page's `accountStart` returns `bootstrap` and
`pendingSignOut()` returns null, so it reads with the live cookie and draws member one's home, with
zero logout calls.

Changes, all in `src/app/account-epoch.ts`:

- A changing mark begun over a record that carries `logout` carries it too, whether that record is the
  settled sign-out or another tab's mark that inherited it. A mark over a mark inherits only this flag:
  `fromSignedOut` stays unset, as the base's writer table says, since the other tab's request may
  have signed an account in.
- `owesLogout(record)` is true for the settled `{ signedOut, logout }` and for a mark that carries
  `logout` once it is stale. `pendingSignOut`, `signOutFinished`, `accountOf` and `accountStart`'s
  signed-out rule all use it, so a stale mark is the pending sign-out: the page starts signed out,
  names no account for the address, tells the worker no one is signed in, reads nothing as member
  one, and the sign-in screen ends the server's session first (a 401 from that read counts as ended).
  A fresh mark that carries the flag still waits, since another tab's request is on its way.
- Nothing else about marks changes: a stale mark without the flag goes to bootstrap, as before.

The page-side table gains rows:

| This tab | Record | Address | Test |
| --- | --- | --- | --- |
| Opening | Fresh mark that carries `logout` | waits; owes nothing yet | account-epoch: "waits on a fresh mark that carries it" |
| Opening | The same mark, gone stale | none; signed-out start, logout owed | account-epoch: "starts signed out, and owes the logout, once a mark that carries it goes stale"; saved-roster-ui: "still reads nothing as member one when a sign-in begun over the offline sign-out hangs" |
| Opening | A stale mark begun over another tab's mark that carried it | none; signed-out start, logout owed | account-epoch: "owes it for a stale mark begun over another tab's mark too" |
| Opening | A stale mark without the flag | as before: bootstrap decides | account-epoch: "lets bootstrap decide for a stale mark that carries no flag" |

### Red runs

Each protecting line broken by hand, `tests/account-epoch.test.ts` and `tests/saved-roster-ui.test.ts`
run, the line restored:

| Mutation | Result |
| --- | --- |
| The mark drops `logout` (the reviewer's sequence) | failed: the UI sequence and both writer rows over a record that carries it |
| The mark carries it only over a settled sign-out | failed: the writer row over another tab's mark |
| The mark carries it over every record | failed: the writer rows over a server-taken sign-out and over member one signed in |
| `owesLogout` ignores a stale mark | failed: the stale-mark tests and the UI sequence |
| `owesLogout` counts a fresh mark | failed: the fresh-mark test |
| `accountStart`'s signed-out rule ignores a stale mark | failed: the stale-mark tests and the UI sequence |
| `pendingSignOut` ignores a stale mark | failed: the stale-mark tests and the UI sequence |
| `signOutFinished` ignores a stale mark | failed: the stale-mark test and the UI sequence |
| `accountStart` does not tell the worker for such a mark | failed: the new worker-word test |

Every mutation in the account-transitions fifth round's table, run again on this branch's merged
code: the same result for each, with the same counts in the enumeration (4,000 orders from seed 1:
restore without its settle 2, without its account check 437, a Decline notice without its account
1,145, without its check 329, without its settle 2, a refused notice that rejects 363; the guard after
the reads, 4 of 40,000 four-word orders).

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3): pass. `npm test`: 201 files, 3512
tests. `npm run build`: pass. `npm run test:e2e`: 38 passed. Orderings, no order broke an invariant:
three words, 20,000 orders each from seeds 1, 100001 and 200001; four words, 40,000 orders each from
the same seeds. Ran on the commit before this ledger entry, after a real `npm ci`.


## Sixth review: Claude Opus 5.5 on `e211c13`

Same-provider review: the cross-provider reviewers were unavailable, so this branch's pull request carries the
`independent-review-owed` label. Ready after fixes; the fixes are on `t3/account-transitions` and merged in here.
The reviewer cleared `owesLogout` for every record shape and the `bcf1de0` resolution of `accountStart`.

One line it could remove with every test green: `owesLogout(record)` in `accountOf`. It stays, on purpose. A mark
that owes a logout and began from a logout record already names no account through `fromSignedOut`; the only mark
that reaches this term is one begun over another tab's mark, which inherits `logout` but not `fromSignedOut`. For
that mark the term makes the address belong to no account, so the next sign-in drops it. Without it the address
belongs to the member named on the mark, which can only be the member who signed out, and it is still cleared
before any other account draws, because a different member's settle clears it. The reviewer traced both and found
no difference a person can see; the term keeps `accountOf` saying what `accountStart` already decides, that an
owed logout means nobody is signed in.
