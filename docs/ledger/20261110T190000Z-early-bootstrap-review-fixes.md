# November 10 the early bootstrap after review: account binding, honest timing, a bounded boot.js

Branch `t3/early-bootstrap`, after merging `origin/main` at `c2ee202` and then
`t3/account-transitions` at `148d8ef`. Checks ran on NicolasLaptop (Fedora, Linux x64, Node 24.22.2,
Chromium from Playwright 1.64.1) on the branch's code as committed. No Python, iOS or Hermes code
changed.

## Merge

The sign-in hint moved to `src/app/account-epoch.ts`, so the saved theme's removal moved with it.
The end of an account generation drops `boot.js`'s read; a tab that has not drawn yet now takes the
stored record without ending a generation, or every page load would drop its own early read.

## Findings and changes

1. An early response could show the page as the previous member. `boot.js` now records the account
   record's text with its read (startup read version 2) and starts none while another tab's
   sign-in or sign-out is marked as under way less than 65 seconds ago. The app takes the read only
   if the stored record is still that text and is the one the tab acts under; otherwise it aborts
   it and reads for itself. An answer that arrives after the record changed is discarded, as any
   request's is. The last account's theme also goes the moment the account changes.
2. The measurement: see below.
3. A stalled `/boot.js`: it is a blocking script in `<head>`, so a stall leaves a blank page with no
   title and no theme until the browser gives up, before any of the app's code or deadlines exist.
   The service worker now answers it from this release's cache at once whenever it holds a copy,
   even after the shell is noted as out of date. A `boot.js` of another release is safe: the app
   takes its read only when the version, path and account record match, so the worst case is one
   extra bootstrap read. A first visit, or a browser without the worker, still fetches it; a stall
   there looks as a stalled shell or bundle did before, a blank page. The script also moved after
   `<title>`, so the tab is named during such a stall.

## Measurement

`.agents/tools/measure-first-load.mjs` now shuffles the builds afresh every round (seeded, the order
printed), reports each figure as a true median with its quartiles and count, pins the browser and
the server to their own cores (`taskset`, browser on P-cores 0-7, server on 8-11 of this machine's 32
logical cores), records the load average at the start and end, and gives each build's difference of
medians from the first with a 95% bootstrap interval. Above a quarter of the logical cores (8 here)
it refuses to call a comparison a result unless `--allow-busy` says otherwise.

Two runs, each `--runs 5 --rounds 6`: 30 loads per build per load kind, three builds. `base` is
`t3/account-transitions` at `148d8ef` (what this branch merges, without `boot.js`); `branch` is this
branch at `700efda`; `roster` is `t3/saved-roster` at `cd32bfb`, for that branch's ledger. Chromium,
Slow 4G (150 ms, 1.6 Mbps down) and 4x CPU, dark theme on a light system.

- Run 1, 18:43 UTC: load average 7.1 at the start and 13.2 at the end, as other agents' work on this
  shared machine came back. The tool refused to call it a result.
- Run 2, 19:03 UTC, seed 1188585740: load average 4.7 at the start and 3.2 at the end, below the
  bound of 8. This is the result below. It agrees with run 1 within 25 ms on every figure quoted.

Run 2, medians (first to third quartile), ms from navigation start, n = 30 each:

| Load | Build | Bootstrap sent | First paint | Theme | Roster painted | Light shown |
| --- | --- | --- | --- | --- | --- | --- |
| No worker, cold cache | base | 5596 (5593 to 5617) | 2454 (2452 to 2460) | 5953 | 5956 (5946 to 5989) | 3501 |
| | branch | 3296 (3286 to 3304) | 2384 (2369 to 2399) | 453 | 5852 (5840 to 6070) | 0 |
| No worker, warm cache | base | 484 (476 to 498) | 216 (212 to 231) | 836 | 837 (826 to 854) | 619 |
| | branch | 333 (331 to 337) | 344 (340 to 356) | 333 | 836 (816 to 853) | 0 |
| Worker's cached shell | base | 326 (319 to 334) | 60 (56 to 71) | 679 | 681 (668 to 694) | 618 |
| | branch | 57 (53 to 66) | 78 (64 to 88) | 57 | 561 (544 to 666) | 0 |

Branch minus base, difference of medians with its 95% bootstrap interval:

| Load | Roster painted | First paint | Light shown |
| --- | --- | --- | --- |
| No worker, cold cache | -104 (-125 to -13) | -70 (-80 to -60) | -3501 |
| No worker, warm cache | -1 (-23 to 12), within noise | +128 (116 to 136), later | -619 |
| Worker's cached shell | -120 (-129 to -77) | +18 (6 to 28), later | -618 |

What this supports:

- The theme without a flash: the light page a dark-theme member saw, 3.5 s cold and 0.6 s warm or
  under the worker, is gone in every load kind.
- Bootstrap starts earlier in every kind, by 0.15 to 2.3 s.
- Time to roster: no gain on a warm load without the worker (within noise). About 0.1 s sooner cold
  and under the worker; the cold interval reaches -13 ms, so that gain is real here but small and
  not tight. On this machine and network model the branch is the theme without a flash and an
  earlier bootstrap, with a modest roster gain on cold and worker loads and none on warm ones.
- The cost: the blocking script delays first paint by 128 ms (116 to 136) on a warm load without
  the worker, where `boot.js` is revalidated, and by 18 ms (6 to 28) under the worker. The earlier
  ledger's 84 ms was a single-run median on a loaded machine. Cold, the page painted 70 ms sooner;
  the cause was not established.

For `t3/saved-roster`, from run 2: roster painted 5648 cold, 567 warm and 300 under the worker,
308, 271 and 381 ms sooner than base, each interval clear of zero.

Every load in every build counted two bootstrap reads within 800 ms after bootstrap answered: the
first, and the one the household stream makes as it connects, by design. None counted more.


## Application tests

- `npm ci`, `npm run typecheck`, `npm run lint` and `ruff check .` (ruff 0.17.3) passed.
- New in `tests/account-transitions-ui.test.ts`: the reviewer's two-tab case (member one's early
  read on its way, member two signs in in another tab, then the first page's bundle arrives and
  member one's answer lands), a read taken and then outrun by another tab's sign-in, no read while
  another tab's sign-in is under way and a read once its mark is 65 seconds old, and the theme
  leaving with member one while member two's bootstrap is on its way.
- `tests/service-worker.test.ts`: `boot.js` from this release's copy with a network that never
  answers, once the shell is noted as out of date; from the network only without a copy.
- `npm test`: 194 files, 3,254 tests passed.
- `npm run build`, then `npm run test:e2e` twice on this head: 22 passed both times. The
  deploy-cache case the reviewer saw fail once passed in both runs.

## Red runs

- The new cases against the merge commit's code: the reviewer's case failed because the first tab
  took member one's read instead of asking (`one held GET /bootstrap sent as two: got 0`); with that
  line removed it showed member one, `AO` and member one's home, while the server's session was
  member two. The changing-mark case failed (a read started) and the theme case failed (`dark`
  stayed while member two's bootstrap was on its way).
- The worker case against the old rule: timed out on the network that never answers.

| Mutation | Result |
| --- | --- |
| The claim check on the record removed | failed: the reviewer's case |
| `boot.js` ignores a changing mark | failed: the changing-mark case |
| `boot.js` stale bound moved by 1 ms | failed: the 65-second case |
| `boot.js` records no record text | failed: the read taken and then outrun |
| `api()`'s answer check removed | failed: the two-tab sign-in case; the read taken and then outrun still passed, because bootstrap's own account check refuses the answer too |
| Theme not reset at a change | failed: the theme case |
| Worker back to the network once the shell is out of date | failed: the never-answering network case |

A completion check on the record inside `src/startup-read.ts` survived, since `api()` makes the same
check for every answer; it was removed as dead code. So was a `typeof epoch` parse check, which the
claim check makes redundant.

## Not exercised

- Safari, Firefox, a real back-forward-cache restore, an installed home-screen app and a real phone:
  not run. Only Chromium runs here.
- HTTP/2 and production compression: not measured; the local server speaks HTTP/1.1.
