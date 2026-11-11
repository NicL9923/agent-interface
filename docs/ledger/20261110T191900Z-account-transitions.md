# November 10 an account change in one tab takes effect in every tab

Branch `t3/account-transitions`, from `origin/main` at `c2ee202`. Checks ran on NicolasLaptop
(Fedora, Linux x64, Node 24.22.2, Chromium from Playwright 1.64.1) on the branch's code as
committed with this entry. No server, Python, iOS or Hermes code changed.

## What `main` does

The reviewer found, in Chromium against the real Fastify app, that a tab showing member A keeps
A's rows after another tab signs member B in, until its next bootstrap. Tabs share the cookie and
learn of a change only from their own next answer. A sign-out also left the member's drafts,
uncertain sends, group drafts and form answers in localStorage.

## Change

- `src/app/account-epoch.ts`: one record, `agent-interface:auth-epoch`, that every tab compares
  with the one it acts under. It changes before a sign-in or sign-out request is sent (marked
  `changing`), when that request settles, at a refused session, when a bootstrap names another
  account, and when the sign-in hint's lapse time passes. A tab checks it on the storage event,
  `pageshow`, focus and becoming visible, and before and after every `api()` request, stream event
  and upload. The raw text is compared, so even an unreadable record counts when it changes. A
  failed sign-in puts the old record back. A `changing` mark older than 65 seconds (a write's 60 s
  timeout plus margin) no longer holds tabs back.
- The sign-in hint moved here from `linked-chat.ts`, so one module writes every account
  transition; `linked-chat.ts` keeps the early chat read and drops it through the same end of
  generation.
- `src/App.tsx`: `App` now draws one account generation at a time, keyed by the tab's generation.
  A change unmounts the generation in a commit of its own, while the tab still acts under the old
  record, so every request its cleanups make is refused; only then does the tab take the new
  record and mount the next generation. Meanwhile it shows the connecting screen, or sign-in after
  a sign-out. An address that named the last account's chat is reset.
- `src/client-api.ts`: requests, stream events and uploads are refused or discarded once the
  record changed (`AccountChanged`, an abort). The CSRF token and the response cache clear at
  every end of generation.
- Module memory keyed by chat alone clears at every end of generation: settled-request receipts,
  a declined approval's prompt, earlier-files lists. Presence and device-activity reports made for
  an ended generation never go.
- `src/app/account-change.ts`: sign-in and sign-out through the record. Sign-out removes the
  member's content records (`forgetAccountContent` in `src/app/storage.ts`) and closes shown
  notifications. A sign-in that names another account than the last ends the browser's push
  subscription, which the server keeps as the old account's and refuses to the new one.

## What outlives a change, and why it cannot leak

| Held | Handling |
| --- | --- |
| React state: boot, conversation, drafts in memory, uploads, panels, toast | Unmounted with the generation |
| Conversation cache, prefetched and linked chats | `clearResponseCache` at end of generation; `conversation-page` follows its scope |
| Reads in flight, a bootstrap that answers late | Discarded as `AccountChanged` |
| Live streams | Closed with the generation; an event after the change drops the stream |
| CSRF token | Cleared at end of generation; the server also checks it against the session |
| Settled receipts, declined prompts, earlier files | Cleared at end of generation |
| Presence and device-activity reports queued or sent at unmount | Fenced by generation |
| Draft saves, sends | Their live checks read the shared generation |
| Service worker messages | Carry only an address, opened under the account signed in now |
| Notifications on screen | Closed at sign-out, refusal and another account, by the page and by the service worker |
| A push on its way for the last account | The service worker shows a push only for the account its pages last named (second round) |
| `<html data-theme>`, tab title, app badge, favicon dot | Reset as the generation unmounts (second round; the first round's claim about the theme was wrong) |
| The address | Query, fragment and path reset to `/` when the last generation drew an account (second round) |

## Accepted limit

A transition the browser cannot observe, a session revoked from another device while this one is
offline or has not reached the server, shows what it shows until the first answer from the
server, which refuses the session and is then the refused-session transition.

## Application tests

- `npm ci`, `npm run typecheck`, `npm run lint` and `ruff check .` (ruff 0.17.3) passed.
- `tests/account-transitions-ui.test.ts`, new: two tabs, each the whole `App` with its own module
  copies, sharing one fake localStorage whose events the test delivers late, reversed or never,
  and one cookie the fake server reads per request. 11 tests: B signs in while A shows in another
  tab (the reviewer's case), A signs out elsewhere, a late bootstrap for A, `pageshow` with
  `persisted`, the hint's lapse, a stream event and a typed draft after an unheard sign-out, a
  refused sign-in, a stale mark, an unreadable record. Each asserts nothing of A is in the
  document afterwards and no request after the change used A's session or content.
- Changed: `tests/linked-chat-ui.test.ts` signals other tabs through the record, not the hint.
  Two tests that pinned a mocked `clearResponseCache` call now assert what the person sees.
- `npm test`: 193 files, 3,212 tests passed.
- `npm run build`, then `npm run test:e2e`: 21 Chromium tests passed, including the new two-tab
  case, which signs out and signs in member two in one page and checks the other without a reload.

## Red runs

- The new unit file against `origin/main`'s code: all 11 failed, the account cases at
  `not.toContain('Ranch Hand')`, member one still on screen.
- The new e2e case against `origin/main`'s build: failed at the first tab's sign-in screen, which
  never appeared.
- The first version of this change adopted the new record during render; the e2e case failed on
  a 401 from `/api/devices/activity`, the old generation's unmount report going out under the
  next account. That is why the unmount now has a commit of its own.

| Mutation, `tests/account-transitions-ui.test.ts` | Result |
| --- | --- |
| Answer check after a request removed | failed: B signs in while A shows |
| Check before a request removed | failed: a typed draft after an unheard sign-out |
| `pageshow` listener removed | failed: the back-forward cache case |
| Storage listener removed | failed: 4 cases |
| Hint lapse timer does nothing | failed: the lapse case |
| Content removal at sign-out removed | failed: A signs out elsewhere |
| No wait during another tab's change | failed: 2 cases |
| A stale mark still waited for | failed: the stale mark case |
| A failed sign-in keeps the mark | failed: the refused sign-in case |
| Stream events not checked | failed: the stream event case |
| Presence fence removed | failed: the typed draft case, a "left" report sent as nobody |
| Device-activity fence removed | survived, here and in the e2e case: jsdom never has focus, and in Chromium the separate unmount commit already refuses the report. Kept for a report queued behind a slow one. |

## Not exercised

- Safari, Firefox, a real back-forward-cache restore, an installed home-screen app and a real
  phone: not run. Only Chromium runs here; `pageshow` is exercised in jsdom.
- A tab of the release before this one writes no record; a bootstrap that names another account
  still catches its sign-in, at that tab's next answer.
- With storage that refuses writes, tabs cannot tell each other; each still drops on its own
  transitions and on a bootstrap that names another account.

## Second round: the cross-provider review of `148d8ef`

xAI's Grok 4.7 reviewed `148d8ef`: ready after fixes. This round fixes its findings. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright 1.64.1 with its headless shell and its
full Chromium, Chrome for Testing 158.0.8127.18). `src/server` changed: one additive push field.

### Changes

1. **Back-forward cache.** `pagehide` covers the account in place: `data-account-covered` on the
   root element hides every element with `visibility: hidden !important` (layout and scroll stay),
   and the title and theme go plain. Nothing unmounts. On the way back, `woke` uncovers at once
   when the generation is unchanged and restores title and theme; after a change the cover stays
   until App's layout effect sees a commit with nothing of the ended generation drawn.
2. **Address.** `end` sets `endedShown` only when an account was shown, and only the next start
   result reads and clears it, so the second end of another tab's change no longer forgets it.
   App resets the address to `/` when the search, fragment or path is anything else.
3. **Title, badge, theme.** `useAppBadge` clears the title, app badge and favicon dot as it
   unmounts; `AccountApp` resets `data-theme` to `system`, what a signed-out page has.
4. **Pushes on their way.** The server adds `account`, the APNs marker (`accountMarker`), to every
   web push; `accountPayload` is now shared by APNs and Web Push. The page posts `ACCOUNT` to the
   service worker at every settled record, at a bootstrap that names the account, and `null`
   while a change is under way or after sign-out. The worker hashes the ID and keeps
   `{ marker }` or `{ signedOut }` in a cache named `wildbots-account`, which activation's
   cleanup of `agent-interface-*` leaves alone. It drops a push for another account and any push
   while signed out, refuses Decline for another account, opens the app without the chat on a tap
   of one, and closes other accounts' notifications when the account changes. A push without
   `account` shows as before while signed in; a worker that never heard keeps today's rule.
   Each tab tells the worker once per generation for each account it names. An earlier draft
   told it once per tab, and a tab that had told it "one" stayed silent after another tab told
   it "none" and closed mid-sign-out; the worker then dropped member one's pushes for good.
5. **Stale mark on waking.** `woke` notifies when the tab waits and the mark it waits on is stale.
6. **Web Locks.** `beginAccountChange`, `settle` and `undo` run under `navigator.locks.request`
   on the record's key where the browser has it, and at once where it does not. They are now
   async; `signInWith` and `signOutOf` await them. The other writers stay unlocked: they write only
   while no change is under way, and only a settled record of the account the server named.
   Chromium copies localStorage between renderer processes a moment after a write, so the lock
   narrows the window for a read and cannot close it.
7. **Found by the new write-refusal test.** With storage refusing writes, a sign-out looped
   forever: refused session, a transition storage would not keep, bootstrap, refused again. The
   tab now keeps a refused write in memory while storage still holds what it held, so it acts
   under the record it meant to write.

### Does Chromium restore this app from the back-forward cache?

Yes, in full Chromium. Playwright's default browser cannot show it: Playwright launches every
Chromium with `--disable-back-forward-cache`, and its headless shell refuses the cache even
without that switch (CDP `Page.backForwardCacheNotUsed`: `BackForwardCacheDisabledForDelegate`,
for a plain static page too). Full Chromium in new headless mode, with that switch left out,
restored the app signed out, signed in with its event streams open, and signed in with the
service worker controlling it or blocked. The new `e2e/back-forward-cache.spec.ts` runs that
browser. On a restore Chromium fires `resume`, then `visibilitychange`, then `pageshow`, and the
storage events from the frozen time after those. At `resume` the page was covered with no row
visible in both cases. With the same account, the first frame showed the chat and the draft as
left; after a sign-out elsewhere, sign-in.

Against a build of `148d8ef`, both new e2e cases failed at `resume`: `covered: false,
rowsVisible: true`. Member one's rows were on screen in the restored page before any of its
script ran, which is the reviewer's P1 seen in a browser rather than read.

### Checks

- `npm ci`, `npm run typecheck`, `npm run lint`, `ruff check .` (ruff 0.17.3): passed.
- Touched files: `tests/account-transitions-ui.test.ts` 25 tests (15 new),
  `tests/service-worker.test.ts` 90 (5 new), `tests/push-actions.test.ts` 5 (1 new),
  `tests/native-api.test.ts` 21 (one changed: it pinned Web Push without `account`).
- `npm test`: 193 files, 3,233 tests passed.
- `npm run build`, then `npm run test:e2e` on port 4173: 23 Chromium tests passed, including the
  two new back-forward-cache cases. Two release-update cases now list only the releases' caches,
  since the worker keeps a cache that every release keeps.

### Red runs

The new tests against `148d8ef`'s `src` and `scripts`, with the new tests in place:

| Test | Failed at |
| --- | --- |
| Covers the account as the page is put away | `covered()` false after `pagehide` |
| Keeps it covered after a sign-out elsewhere | `{ covered: false, one: true }` at `pageshow` |
| Member two's own chat after another tab's sign-in | "Barn door sticks" missing: two's home chat opened from `?bot=home` |
| No address after a sign-out in another tab | search still `?bot=home` |
| No unread count, badge or theme between accounts | title still `(1) WildBots` |
| A stale mark on waking | no bootstrap after `focus` |
| A refused sign-in's undo beside another tab's settle | record lost `user: "two"`, kept the mark |
| Sign-out with storage refusing writes | timed out: the bootstrap loop |
| Upload and send in flight | two's home chat from the carried address (item 2) |
| Web push names its account (server) | `account` undefined |
| Worker: shows for the account, keeps whose it is | `data.account` missing |
| Worker: drops another account's push after a restart | shown |
| Worker: shows nothing signed out | shown |
| Worker: Decline for another account | `fetch` called |
| The worker told again after another tab told it none | written against this round's draft, which failed it: last word `null` |

The lock test first passed against `148d8ef` because its storage hook fired the other tab's
settle on every read (`??=` on the old `settle`, which returns nothing); with a one-shot flag it
fails for the reviewer's reason.

Mutations of this round's code, each run against the tests that cover it:

| Mutation | Result |
| --- | --- |
| `pagehide` cover not registered | failed: both cache tests |
| Same-account `woke` does not uncover | failed: the same-account case |
| App never uncovers after a change | failed: the change case |
| Cover keeps the title | failed: the same-account case |
| A later end forgets the shown account | failed: both address cases |
| Start does not clear the flag | survived: no flow writes an address between a clear and the next start |
| Fragment not checked | survived: `useUrlSync` writes a query whenever an account shows a chat, so a fragment alone never names one today |
| Badge not cleared at unmount | failed |
| Theme not reset at unmount | failed |
| Waking ignores a stale mark | failed |
| No Web Lock | failed: the lock test |
| Refused write not kept in memory | failed: the write-refusal test times out in the loop |
| Unreadable record left unwritten | failed: the newer-format test |
| A refused read throws | failed: the read-refusal test |
| Storage listener removed | failed: the three-tab test |
| Uploads not aborted at unmount | failed: the in-flight test |
| Send answer unchecked in `api` | survived; with `use-submission`'s generation check also removed, survived: the tree is gone, so a late answer has nothing to draw into and sends nothing |
| Worker shows every push / when signed out / declines for anyone / keeps others' notifications / drops pushes naming no account / keeps the account only in memory | each failed its test |
| The page's word to the worker not reset at a start | failed: the told-again test |
| A bootstrap does not tell the worker | failed: the told-again test |

The reviewer's pin of the separate unmount commit:

| Mutation | Result |
| --- | --- |
| `accountStart()` during the pending render | survived |
| Device-activity fence removed | survived |
| Presence fence removed | failed |
| Both of the first two | failed: an `inactive` report for member one |
| Pending render and presence fence | failed |

Every request today's tree makes from an unmount cleanup is also fenced by generation, so the
separate commit and the device-activity fence back each other up, and a test can see either only
when both are gone. The new test fails when both are broken, and it fails on the presence fence
alone. A future cleanup without a fence of its own is what the separate commit is there for.

### Not exercised

- Safari, Firefox, an installed home-screen app, a real push service and a real phone: not run.
  Safari's and Firefox's back-forward caches and their event order on a restore are not checked.
- Chrome on Android shows a screenshot taken before `pagehide` during a back gesture's animation;
  the cover cannot reach it.
- A dropped push shows no notification. Chrome may show its own "updated in the background"
  notice for one, and Safari revokes a subscription after three; outside a change under way, the
  subscription is one the browser already ended.

## Third round: the Grok 4.7 review of `58307d5`

`origin/main` at `e7cd5ac` merged in first, as `8b7e374`, with no conflict.

### Changes

- A push already inside `showNotification` when a page says another account, or none, is not
  listed yet, so `setAccount` closed nothing and member one's notification and badge stayed. The
  push handler now reads the account again once its notification is on screen; if that account
  left, it closes the notifications `mayShow` refuses and clears the badge the push set.
  `readAccount` follows a newer `ACCOUNT` message while it waits, instead of the promise it began
  with. The test fake lists a notification only once `showNotification` resolves, and can hold
  it on its way.
- The address belonged to "a generation a bootstrap drew", and was reset at the next start
  whatever came next. It now belongs to the account the record named when the generation
  started, or the account its bootstrap named since, and the next settled record resets it unless
  it names that same account.

| Case | Before | Now |
| --- | --- | --- |
| Same account put back by another tab's failed sign-in | reset to `/`, chat and fragment lost | kept |
| Another account settles | reset | reset |
| Sign-out, here or in another tab | reset | reset |
| Address opened while signed out, then a sign-in here or in another tab | kept | kept |
| Connecting screen, record names member one, then sign-out or another account | kept | reset |
| Page opened during another tab's change, which then settles elsewhere | kept | reset |

- Finding 4: on this branch the online sign-out already ends the push subscription, on the server
  and in the browser, through `notifications.disable()` before `signOutOf` (`src/App.tsx`, as on
  `main`). This branch has no offline sign-out, so nothing changes here; see the saved-roster
  ledger.

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .`: pass. `npm test`: 193 files, 3250 tests.
`npm run build`: pass. `npm run test:e2e`: 23 passed.

### Red runs

Each line broken by hand, the suite run, the line restored.

| Mutation | Result |
| --- | --- |
| Push not checked again once shown | failed: the held-show sign-out test |
| Badge not cleared for a late push | failed: the held-show sign-out test |
| Late push closes whatever the account | failed: the same-account held-show test and the badge test |
| `readAccount` returns the promise it began with | failed: the in-flight read test |
| Same-account comparison removed (`!!before`) | failed: the failed-sign-in test |
| A start takes no account from the record | failed: both connecting-screen tests |
| `location.hash ||` removed from the reset | failed: the fragment-alone test |
| The page that opens during a change takes no account | failed: the opened-during-a-change test |
| The waiting start overwrites a signed-out address (`??=`) | failed: the other-tab sign-in test |
| A bootstrap's account not recorded | failed: the unnamed-record test |
| This branch's account-epoch.ts before the change | five new tests failed |

The `??=` row was a bug in the first draft of this change, which the mutation found: a page on
sign-in would have lost an address opened while signed out when another tab signed in.

### Not exercised

- A real push service: the late notification is checked in the worker run in a vm, as before.
- A bootstrap that names another account than the record without a change this browser saw keeps
  its generation, and its address, as before. Only storage that refuses writes reaches it.

## Fourth round: the Grok 4.7 review of `ae7f13a`

`origin/main` at `145104f` merged in first, as `4375e95`, with no conflict.

Rounds three and four each found a new order of the same few asynchronous steps in the service
worker. This round puts every one of those steps under one discipline and checks it with a test
that enumerates orders instead of naming them.

### The worker's ordering discipline

Each `ACCOUNT` message takes a new generation as it arrives, and the latest word replaces the
in-memory account at once. Every step that writes the saved account, writes the badge's owner,
closes a notification or sets or clears the badge runs on one promise chain (`serially`), one at a
time, and stops after any await once a newer message has arrived; the newer message's own step is
queued behind it. The invariants, as written at the top of that code in
`scripts/service-worker.js`, once the chain is idle and relative to the latest `ACCOUNT` message:

- Cache Storage holds its word, so a worker started again judges pushes by it.
- No notification of another account is listed.
- No notification of its account was closed after it arrived.
- The badge is unset or was set by a push for that account. No push of a departed account can set
  the badge or clear the latest account's. The worker changes the badge only for a push; a badge
  the page set is the page's.

### Changes

- P1, a late account write: `setAccount` now queues `settleAccount` on the chain. It reads the
  latest word, and checks the generation after the reads, after opening the cache, after the
  write, after a badge clear and after `getNotifications`.
- P2, the badge: a push sets the badge only in its chain step, once `showNotification` settled,
  with no await between the account check and `setAppBadge`. A push whose account left meanwhile
  closes what that account showed and never sets its badge. A refused `showNotification` no longer
  rejects `waitUntil`: the push still runs its check, and sets its badge if its account is still
  signed in, since the server's count still stands.
- A step for a new account clears a badge a push of another account set. Whose push set the badge
  is recorded beside the account (`/badge` in `wildbots-account`), after the badge changes and in
  the same step, so a restarted worker knows it. The first draft guessed it from the saved account
  after a restart instead, which also cleared badges the page set, and crashed every e2e sign-in:
  Playwright's headless shell crashes the renderer on any Badging API call from a service worker.
  Full Chromium 156 (`channel: 'chromium'`) clears the badge without a crash in the same repro.
  With no badge from a push, the worker now makes no badge call at all.
- P3, the address: a changing mark now says whether it began signed out (`fromSignedOut`, set when
  nothing was stored or the record was a sign-out). Such a mark names no account, even when it
  carries the last account's name, so a page that opens during it keeps its address for the next
  sign-in, as one opened signed out does. The reviewer's smaller fix, null for a mark with no
  user, would still have dropped the address when the mark carried the last account's name after a
  sign-out, and would have kept an address for anyone under a mark that began with an account no
  record named.

How each nameless mark resolves for a page that opens during it:

| Mark | Began with | Address owner | Settles as another member | Put back |
| --- | --- | --- | --- | --- |
| `fromSignedOut`, no user | a fresh or signed-out browser | none | kept | kept |
| `fromSignedOut`, user one | a sign-out of member one | none | kept | kept |
| no flag, no user | an account no record named (a sign-in answer without an ID, before any bootstrap) | an unnamed account | dropped | dropped: the browser cannot tell it is the same account |
| either, gone stale | | the account it began with, or none | bootstrap decides | |

A sign-out begins from a tab that drew its account, whose bootstrap names the record first, so a
nameless sign-out mark needs storage that refused that write. It falls in the third row and drops
the address.

### The enumeration test

`tests/service-worker-orderings.test.ts` runs the real worker script, compiled once and started as
a function per worker, over fakes of Cache Storage, notifications, the badge and the hash. Each of
4000 seeded walks picks a saved account (none, member one, member two or signed out, with that
account's badge), a page order of three words from `one`, `two` and none with no word twice in a
row (12 orders), a push for each member and an idle restart at random places. Every cache read and
write, hash, `showNotification` (refused one time in four) and `getNotifications` is held, and the
walk releases a random ready step until none is left. Then it checks the invariants above, that
every `waitUntil` resolved, and that a worker started again shows only the latest account's push.
A failure prints its seed, the words and the order of steps; `SW_ORDER_SEED` and `SW_ORDER_RUNS`
replay it.

- Coverage: 220 ordered pairs of steps that were ready together. Every pair ready together at
  least 20 times ran both ways round; 2 pairs were ready together fewer times than that.
- Run time: 0.4 to 0.6 s on NicolasLaptop.
- Against the worker at `ae7f13a`, 2274 of the 4000 orders broke an invariant: the cache named an
  older word in 851, a restarted worker showed another account's push in 851, a departed account's
  push set the badge in 1024, `waitUntil` rejected in 809, the latest account's notification was
  closed after its word in 493, its badge was cleared after its word in 55, and another account's
  notification stayed on screen in 36.
- Against this round's worker: none.

### The page side

What a tab does with each record another tab can leave, by what the tab shows. Cells the UI tests
already covered keep those tests; `tests/account-epoch.test.ts` adds one case per branch for the
rest.

| This tab | Record another tab left | Address | Test |
| --- | --- | --- | --- |
| Opening | Mark from member one, then one put back | kept | account-epoch: "a mark that began with member one signed in, put back" |
| Opening | Mark from member one, then a sign-out | dropped | UI: "drops member one's address from a page that opened while another tab was signing them out" |
| Opening | Mark from member one, then member two | dropped | same branch as the sign-out row |
| Opening | Mark from signed out, no user, then member two | kept | UI: "keeps an address the person opened while another tab was signing in from signed out" (P3) |
| Opening | Mark from signed out after member one, then member two | kept | account-epoch: "a mark that began signed out after member one" |
| Opening | Mark from an unnamed account, then member two | dropped | account-epoch: "a mark that began with an unnamed account" |
| Opening | A mark gone stale, from member one or from signed out | kept; bootstrap decides | account-epoch: both stale rows |
| Opening | Settled, unreadable or nothing | kept: the page opened with it | every UI test that opens with an address |
| Connecting, record names member one | Mark, then a sign-out | dropped | UI: "drops an address member one opened while still connecting" and the fragment-alone test |
| Showing member one | Mark, then one put back | kept | UI: "keeps member one's address, open chat and fragment when another tab's sign-in fails" |
| Showing member one | Mark, then member two | dropped | UI: "opens member two's own chat, not the one member one was at" |
| Showing member one | Mark, then a sign-out | dropped | UI: "leaves no address of member one's on the sign-in screen" |
| Showing member one | Settled member two with no mark first | dropped | account-epoch |
| Showing member one | Settled with no account named | dropped | account-epoch |
| Showing member one | Storage cleared | dropped | account-epoch |
| Showing member one | Unreadable | dropped, and bootstrap asked | same branch as storage cleared; UI: "treats a record it cannot read as a change" |
| Showing member one | Same account, new ID (the hint lapsed) | kept | same branch as the put-back row; UI: the hint-lapse test |
| Showing member one | A mark from signed out, gone stale | dropped | account-epoch: "drops the address when a sign-in that began signed out goes stale" |
| Sign-in screen | Any record | kept | UI: both "keeps an address the person opened while signed out" tests |
| Any | A write storage refused | the old record stays, so other tabs see nothing; the writing tab acts alone | UI: "drops member one at its own sign-out when storage refuses every write" |

The mark's flag over each record a sign-in or sign-out can begin from (nothing, a sign-out, member
one, unreadable) is one table in account-epoch.test.ts.

### Red runs

The named tests against `ae7f13a`: the seven new worker tests and the five new page cases all
failed, each for the reason the review gave: the saved account was member one, or signed out,
instead of member two; the badge was 0 instead of member two's 4; `waitUntil` rejected with the
refused notification; the address went to `/` and the default chat.

Each line of this round's code broken by hand, both worker test files or both account test files
run, the line restored:

| Mutation | Result |
| --- | --- |
| No generation check after the reads | passed here, and wrongly called redundant: the fifth round found it protects the badge clear, see its red runs |
| No check after opening the cache | passed, for the same reason: the check after the write stops the step, and the next step writes the latest word over the stale one. Confirmed redundant in the fifth round |
| Neither of those two | passed here; the first of them is not redundant, so this row proved nothing about it |
| No check after the write | failed: enumeration, the latest account's badge cleared in 66 orders |
| No check after `getNotifications` | failed: enumeration, the latest account's notification closed in 36 orders |
| No check after the badge clear | passed: the check after `getNotifications` follows it. Confirmed redundant in the fifth round |
| None of the four checks in the account step | failed: the overtaken sign-out test, and 432 orders |
| No chain | failed: the overtaken sign-out test, and 280 orders (cache 234) |
| Push sets its badge without the second account check | failed: three named badge tests, and 505 orders |
| Push step goes on after a newer word arrived | failed: enumeration, 2 orders set a departed account's badge |
| A refused `showNotification` rejects `waitUntil` | failed: both refused-show tests, and 799 orders |
| No badge clear at a new account | failed: the restart badge test, and 854 orders |
| Badge owner kept only in memory | failed: the restart badge test, and 492 orders |
| Owner recorded before the badge is set | failed: enumeration, 19 orders (this round's first draft) |
| A mark that began signed out names its account | failed: the P3 UI test and both account-epoch rows that depend on it |
| The writer counts nothing stored as signed in | failed: the "nothing stored" writer row |
| The writer counts a sign-out as signed in | failed: the sign-out writer row |
| The writer counts an unreadable record as signed out | failed: the unreadable writer row |
| A mark begun over another tab's mark takes its `fromSignedOut` | not run in this round; the fifth round added its row and ran it |

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3): pass. `npm test`: 198 files, 3332
tests. `npm run build`: pass. `npm run test:e2e`: 27 passed.

### Not exercised

- A real push service and a real badge: the worker's badge is checked in the vm fakes, and e2e
  sends no push with a count. Playwright's headless shell cannot run a worker's Badging API call
  at all, so an e2e test of it would need `channel: 'chromium'`.
- The page and the worker both write the app badge, in no shared order. After a switch the
  worker's clear of the old account's badge can land after the new account's page set its count,
  which leaves no badge until the count next changes; it never shows the old account's.

## Fifth round: the review of `ad3b65b`

`origin/main` at `785f4f2` merged in first, as `0f120ae`, with no conflict. The review found one
order that undoes a tapped notification's account check, and several places where the enumeration
test could not have failed. The invariants were written for one worker instance; the last item says
where that stops.

### Changes

- P1, a tapped notification that comes back: `restore` checked no account. Its `showAgain` ran
  whenever no window came to the front, so a notification of member one came back, listed with the
  chain idle, after `ACCOUNT null`, or under member two after `ACCOUNT two`. `restore` now checks
  `mayShow` before each display, so a notification of a departed account never flashes, and chains
  `settlePush(notification.data?.account)` after it, so one whose account left while the display was
  on its way closes when it lands. A failed Decline's notice had the same hole and one more: it named
  no account, so after a switch it stayed listed under member two and a tap on it opened member one's
  chat. `decline` now puts the account in the notice's data, checks `mayShow` before showing it, and
  settles after. It also no longer rejects `waitUntil` when the browser refuses to store the notice,
  as a push never has.
- P3, the guard after the account step's reads is not redundant. A word that arrives during the
  reads leaves `state` the older word. When that word is also what the cache holds, the step skips
  the write and, without the check, judges the badge by it: `settleAccount` clears the badge of the
  latest account. The fourth round's row calling it redundant is corrected above. The guards after
  opening the cache and after the badge clear were run again with the new tests and are redundant;
  they stay, since each makes the order of checks read the same all the way down.
- P3, a refused cache write: the account step's write and its badge clear are wrapped, so the step
  goes on to close what the departed account has on screen. `saved` is only updated by a write that
  worked, so the next step writes again.
- P3, the badge: the page already clears the app badge on every start that draws no account, since
  `useAppBadge(0)` runs with the screen's other hooks, before `AccountApp` returns the sign-in
  screen (`src/app/badge.ts`). That is the reviewer's fix; it needed a test and no code.
- P3, the worker named after a sign-out: `accountStart` tells the worker no one is signed in at every
  start from a settled sign-out, and `accountRefused`'s early return tells it for a browser with
  nothing stored. `told` is cleared at each `accountStart`, so a repeat of the same word is sent once
  per generation, not once per bootstrap.
- P3, the writer table has a row for a mark begun over another tab's mark.
- Known limit, named in the invariants comment in `scripts/service-worker.js`: all of this holds for
  one worker instance. While a release updates, the old worker can still be running steps it held
  across the new worker's activation. The two share the saved account and the badge's owner but not
  the chain, the generation or the memory, so the old one can write a word the new one overtook or
  close a notification the new one allows, until the browser stops it. No ordering inside one
  instance can fix that; the page repeating its word at each start puts the newest back.

### The enumeration test

`tests/service-worker-orderings.test.ts` now also:

- takes a tap on a notification of one member and a Decline of one member, at random places, with
  `clients.matchAll`, `clients.openWindow` and the Decline's `fetch` held like every other step. A
  window the worker tries to open is refused three times in four, so the notification comes back; a
  request is lost one time in four.
- records every call the worker makes that the fakes refuse, and fails a run that has one. A throw
  inside a chain step is swallowed by the chain's `catch`, so before this the test passed over it.
- records every `showNotification` call with the word that was latest when the worker asked, and
  fails a run that asked for a notification of an account that word excludes. The final listing hides
  a display that flashed and was closed.
- takes `SW_ORDER_WORDS` for the number of account words, three by default. Four is a scratch run:
  24 page orders instead of 12.

### Red runs

Each protecting line broken by hand, the line restored. The named tests are in
`tests/service-worker.test.ts`; "orders" are the seeded walks, 4,000 from seed 1 unless it says
otherwise.

| Mutation | Result |
| --- | --- |
| No check after the account step's reads | failed: the named test "words two, one, two, one"; 4 of 40,000 four-word orders (badge cleared under the latest), none of 4,000 with three words |
| The chain without its `catch` | failed: the named test where a refused badge record ends a push and the next word still applies |
| `clearBadge` without `keepBadgeFor(null)` | failed: the named test with exactly one clear across a sign-out and two sign-ins |
| A refused cache write stops the step | failed: the named test where the sign-out's write is refused and the notification still closes |
| `restore` without the settle after its display | failed: two named tests (sign-out, and a switch, while the display is on its way); 2 orders (screen) |
| `restore` without the account check before its display | failed: the named "never displayed" test; 437 orders (shown after its word), none on the screen |
| `decline` with no account in its notice | failed: the named test; 1,145 orders (screen 744, shown after its word 925) |
| `decline` without the account check before its notice | failed: the named test; 329 orders (shown after its word) |
| `decline` without the settle after its notice | failed: the named test; 2 orders (screen) |
| An unscripted call inside the account step | failed: all 4,000 orders (the refused-call list); the chain swallowed every throw |
| `accountStart` does not tell a settled sign-out | failed: two UI tests (another tab's sign-out, and a page opened after one) |
| `accountRefused`'s early return does not tell | failed: the UI test of a page opened with nothing stored |
| The page does not clear the app badge at a count of zero | failed: the UI test of a page started signed out |
| A mark begun over a mark takes its `fromSignedOut` | failed: the new writer row |
| No check after opening the cache; no check after the badge clear | passed, with the named tests and 40,000 four-word orders each: redundant, as the fourth round said |

The first draft of `decline` kept a refused notice's rejection, and the new Decline events failed
363 of 4,000 orders on `waitUntil`. It is caught now.

### Checks on the final head

`npm run typecheck`, `npm run lint`, `ruff check .` (0.17.3): pass. `npm test`: 199 files, 3373
tests. `npm run build`: pass. `npm run test:e2e`: 27 passed. Ran on NicolasLaptop (Fedora, Node
24.22.2) after a real `npm ci`.

Orderings on the final worker, no order broke an invariant: three words, 20,000 orders each from seeds
1, 100001 and 200001; four words, 40,000 orders each from the same seeds. The default 4,000 orders run
in 0.6 s.

### Not exercised

- Two worker instances across an update, above. No test can show an old instance's step: it needs two
  scripts sharing one Cache Storage, and the browser does not say when it stops the old one.

## Sixth review: Claude Opus 5.5 on `6695309`

Same-provider review: the cross-provider reviewers were unavailable, so this branch's pull request carries the
`independent-review-owed` label. Ready after fixes, no P1. The orchestrator, Claude Opus 5.5, made the fixes.

- P2. Two lines in the account step had no test that went red. Removing the `try` around `clearBadge()` let a
  refused write of the badge's owner record stop the step before it closed the departed member's notifications.
  Moving `saved = Promise.resolve(state)` above `cache.put` made a repeated word skip a write the browser had
  refused, so the cache kept naming the member who left. Two tests in `tests/service-worker.test.ts` cover them:
  "closes the notification of the member who left even when the browser refuses to record the badge's owner" and
  "writes a refused sign-out when the page says the same word again". Each passed on the code and failed on its
  mutant, one failure each, and each mutant was restored.
- P3. The orderings test's `refuse` fake was an arrow function, so `new MessageChannel()` threw "is not a
  constructor" before the call was logged. It is now a plain function. No current order opens a window, so no
  result changed.
- P3. The invariants comment said Cache Storage holds the latest word once the chain is idle. After a refused write
  it holds the older word until a later step's write succeeds. The comment now says so.

The reviewer cleared `owesLogout` for every record shape, the merge resolution on `t3/saved-roster`, the signed-out
word against a sign-in in another tab, the wrapped write, and the tap and decline paths. Its own seeds, 424243 and
777001, at 3 words with 20,000 orders and 4 words with 40,000, found no failure. Of its 19 mutations, 16 went red;
the 3 survivors are the two P2 lines above and one on `t3/saved-roster`.
