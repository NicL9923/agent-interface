# November 10 one writer for the app badge: the page asks the service worker

Branch `t3/one-badge-writer` over `origin/main` at `2f1670e`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Node 24.22.2 after a real
`npm ci`, Playwright 1.64.1 with full Chromium, ruff 0.17.3. It shares no line with `t3/refused-session-push` (server) or
`t3/stale-record-address` (`accountNamed`); `src/app/account-epoch.ts` changes only in `tellWorker`'s neighbourhood, so all three are
independent. Line numbers are this branch's.

## Defect

`src/app/badge.ts` set and cleared the app badge from the page, and `scripts/service-worker.js` set it for pushes and cleared a badge a
departed account's push set. Nothing ordered the two. At an account switch the worker's clear (its step reads Cache Storage first) could
land after the page's count for the new account, leaving no badge until the next change. It could never show a departed member's count,
but it dropped the right one.

## Change

- The page posts `{ type: "BADGE", user, count }` to the active worker (`src/app/badge.ts:77`, `writeBadge`), through the same promise
  chain that posts the `ACCOUNT` words (`post`, `src/app/account-epoch.ts:463`; `tellWorkerInOrder`, line 486), so the worker hears
  words and counts in the order the page said them. `user` is the account the page's screens show, or null before bootstrap names it
  (`useAppBadge(count, user)`, `src/App.tsx`). The unmount clear names the account whose screens leave.
- The worker handles it on its serial chain (`setPageBadge`, `scripts/service-worker.js:279`):
  - a count is set only while the latest word names the account the page sent, and the badge's owner becomes that account;
  - a clear is made unless the badge on screen is the latest account's and a different account asks: a tab of another account, or a tab
    that shows none, cannot wipe the latest account's count. A badge the latest word does not allow is cleared by whoever asks, which
    is how a page that opens signed out removes a count a stopped worker left;
  - the word that was latest when the message arrived is its word, so a write sent before a newer word is dropped, even one for the same
    account that came back. This was the one the orderings walk found (below);
  - an answer goes back on the port the page sent, after the step ends, whether it changed the badge or not.
- Fallback: a page no worker controls writes the badge itself, as before. So does a page whose worker does not answer within three
  seconds (`BADGE_ANSWER_MS`), which is the case of a new page on a worker from before this message, as after a release whose worker
  cannot install (smoke.spec covers that release). Without it the badge would silently stop updating. Only the newest write waits on
  its answer, since the next replaces it.
- The invariants comment at the top of the worker and the README paragraph on the badge now say the page's writes are the worker's.

## Orderings

`tests/service-worker-orderings.test.ts` takes the page's writes. After each word the page says, in its own order, a clear for the
account it left and the count of the account it shows (a sign-out clears). Per seed, one count and one clear from a tab of an account
other than the latest, and a clear from a tab that shows none, land at random places among everything else. The invariant: once the
worker is idle the badge is the latest account's count, or none after a sign-out, and nothing sets another account's count or clears the
latest account's after the latest word arrived.

My first version took the word when the step began and failed 157 of 4,000 orders: a clear a page sent to an older generation of the
account that then came back ran after the newest word and wiped the count; the page then set it again, so the end state was right and
the invariant "nothing clears the latest account's count" caught the transient. The word is now taken at arrival.

No order broke an invariant: three words, 20,000 orders each from seeds 1, 100001 and 200001; four words, 40,000 orders each from the same
seeds. The default 4,000 orders still run in under a second.

## Other tests

- `tests/service-worker.test.ts` ("service worker app badge for the page", 21 cases): the count for the latest account, kept across a
  restart; a count refused for another account, after a sign-out and for no account; seven malformed inputs; each clear rule; the old
  account's clear after the word and before the new count; a count a newer word overtook; a clear of an older generation after the
  account came back; the answer on the port, for a refused write and without the badge API; a refused record of the badge.
- `tests/app-badge.test.ts` (10 cases, jsdom, a fake service worker container and message channel): each count and clear reaches the
  worker with its account and a port and the page writes none itself; the clear names the account that leaves; the message waits behind
  an account word when the browser is slow to find the worker; an answer ends the wait and closes the port; no answer means the page writes
  once at three seconds; only the newest write waits and a late answer for an older one forgets nothing; no active worker; no controller;
  no message channel. The existing UI tests of the page's own badge (no worker in jsdom) pass unchanged.
- `e2e/badge.spec.ts`, a real service worker in full Chromium: with Ranch Hand waiting, a reload under the worker's control sets the badge
  to 1 through the worker; member one signs out and member two signs in, and the worker's last call is the clear and then `setAppBadge(1)`;
  the page's own calls are empty throughout; then nothing waiting and the last call is a clear. The page and worker's badge calls are
  recorded and passed to the real API, and the page does not crash. `e2e/server.ts` has a control route, `POST /activity`, that gives an
  assistant a roster activity, reset with the rest.

## The browser project

Every spec crashed in the headless shell once a worker controls the page. The first full run with `badge.spec.ts` as a second project
(`channel: "chromium"`) and the rest in the shell: 24 failed, 15 passed, each failing with "Target crashed" at the first `signIn`. The
worker now clears the badge on every page start with a count of zero, and the headless shell crashes the page when a service worker calls
the badge API. A probe in the shell confirmed it: the page crashed on the badge test and not before it, when only the page called the API.

So the whole suite runs in full Chromium (`playwright.config.ts`, one project, `channel: "chromium"`); a second project could not leave the
other specs in the shell. `back-forward-cache.spec.ts` already depended on full Chromium and keeps its launch option. CI can run it: the
`browser` job runs `npx playwright install --with-deps chromium`, which installs the full build, and `npm run test:e2e`, and the
back-forward-cache spec already ran on that build there. I could not run GitHub Actions from here. Locally the whole suite passed in
full Chromium four times (39 tests each), and `badge.spec.ts` alone eight times. It is part of `npm run test:e2e`.

## Red runs

Each protecting line broken by hand, the file restored. "Orders" are the seeded walks, 4,000 from seed 1.

| Mutation | Result |
| --- | --- |
| Page badge steps off the chain | failed: 3 tests; 211 orders (badge not the latest's 151, cleared under the latest 211) |
| The word taken at the step's start | failed: 157 orders (cleared under the latest); no named test, only the walk, then the older-generation test was added |
| No newer-word check | failed: the older-generation test; 306 orders (cleared 221, set by a departed account 88) |
| A count set for any account | failed: 2 named tests; 1,321 orders |
| Any clear applies | failed: the two stale-tab tests; 816 orders |
| A clear refused when the latest word does not allow the badge | failed: the stopped-worker test |
| A clear refused for the badge's own account | failed: the own-page clear test |
| The page's count not recorded as owned | failed: 2 named tests; 450 orders |
| Count not validated | failed: 4 cases |
| A count with no account accepted | survived the table, which signs one in first; the "before any word" test was added and it went red |
| No guard for a browser without the badge API | survived; the test only set a count; it now also clears, and went red |
| No answer on the port | failed: 2 named tests |
| The page always writes the badge itself | failed: 7 page tests; the end-to-end test |
| No fallback after the answer timeout | failed: 4 page tests |
| An older count keeps waiting after a newer one | failed: 2 page tests |
| A late answer forgets the newest wait | failed: the late-answer test |
| The port is not closed | failed: the answered test |
| The unmount clear names no account | failed: the clear test |
| A badge message does not wait behind the account words | failed: the slow-registration test |
| No controller check | failed: 4 tests |
| The worker ignores `BADGE` | failed: the end-to-end test |
| `user` out of the hook's dependency list | survived: equivalent; a change of `user` alone for the same count needs no new write, and the list stays for the lint rule |
| The `setAppBadge` existence check before a count | removed, not tested: a browser without `setAppBadge` throws into a chain that swallows it, the same outcome |

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` pass. `npm test`: 203 files, 3,548 tests. `npm run build` passes. `npm run test:e2e`:
39 passed in full Chromium.

## Not exercised

An installed app's badge on a real device: the recorded calls reach Chromium's real API, but nothing reads the operating system's badge.
Safari and Firefox. Two worker instances across a release (the invariants comment's known limit); the answer timeout is what protects the
badge in the mixed case of a new page on an old worker, and is tested only with fakes.
