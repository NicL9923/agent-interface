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

Run: `--runs 5 --rounds 6`, 30 loads per build per load kind, three builds: `base`, `t3/account-
transitions` at `148d8ef` (what this branch merges, without `boot.js`); `branch`, this branch at
`700efda`; and `roster`, `t3/saved-roster` at `cd32bfb`, for that branch's ledger. Chromium, Slow 4G
(150 ms, 1.6 Mbps down) and 4x CPU, dark theme on a light system. Started 18:43 UTC after waiting
for the 1-minute load average to drop below 8.

**Not a result, by the tool's own rule.** The load average was 7.1 at the start and 13.2 at the end:
other agents' compilers on this shared machine came back during the run. The quartiles are narrow
(a cold load's roster spread 30 to 60 ms), which suggests the pinned cores were not badly contended,
but the comparison below is reported as what this machine measured, not as a settled figure. The
quietest window available today did not last 15 minutes.

Medians (first to third quartile), ms from navigation start, n = 30 each:

| Load | Build | Bootstrap sent | First paint | Theme | Roster painted | Light shown |
| --- | --- | --- | --- | --- | --- | --- |
| No worker, cold cache | base | 5609 (5601 to 5628) | 2460 (2456 to 2468) | 5963 | 5968 (5951 to 6009) | 3502 |
| | branch | 3292 (3285 to 3302) | 2388 (2380 to 2392) | 452 | 5862 (5843 to 5877) | 0 |
| No worker, warm cache | base | 494 (478 to 509) | 218 (212 to 227) | 857 | 858 (826 to 890) | 635 |
| | branch | 331 (329 to 338) | 342 (340 to 352) | 332 | 836 (821 to 849) | 0 |
| Worker's cached shell | base | 338 (324 to 352) | 64 (57 to 75) | 688 | 694 (680 to 713) | 625 |
| | branch | 55 (51 to 58) | 78 (61 to 84) | 55 | 566 (547 to 612) | 0 |

Branch minus base, difference of medians with its 95% interval:

| Load | Roster painted | First paint | Light shown |
| --- | --- | --- | --- |
| No worker, cold cache | -106 (-144 to -91) | -72 (-80 to -68) | -3502 |
| No worker, warm cache | -22 (-38 to 5), within noise | +124 (116 to 132), later | -635 |
| Worker's cached shell | -128 (-151 to -88) | +14 (0 to 20), within noise | -625 |

What this supports, with the caveat above:

- The theme without a flash, clearly: the light page a dark-theme member saw shrinks from 3.5 s,
  0.6 s and 0.6 s to none in every load kind.
- Bootstrap starts earlier in every kind, by 0.2 to 2.3 s.
- Time to roster: within noise on a warm load without the worker; about 0.1 s sooner cold and under
  the worker, intervals clear of zero, but measured on a machine past the tool's load bound, so this
  branch should be described as the theme without a flash and bootstrap started earlier, with no
  settled gain in time to roster.
- The cost: the blocking script delays first paint by 124 ms (116 to 132) on a warm load without
  the worker, where `boot.js` is revalidated; the earlier ledger's 84 ms was a single-run median on
  a loaded machine. Under the worker it costs nothing measurable. Cold, the page painted 72 ms
  sooner; the cause was not established.

For `t3/saved-roster`, from the same run: roster painted 5651 cold, 577 warm and 293 under the
worker, 317, 281 and 401 ms sooner than base, intervals clear of zero, with the same caveat.

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
