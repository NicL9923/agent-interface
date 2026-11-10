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
