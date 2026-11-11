# November 11 the page's own badge write stays inside the worker's order, and a worker without the badge API hands the write back

Branch `t3/one-badge-writer` from `4e33455`, merged with `origin/main` at `16c96a8` first, on NicolasLaptop (Fedora 44, Linux x64),
Node 24.22.2 after a real `npm ci`, Playwright 1.64.1 with full Chromium, ruff 0.17.3. Line numbers are this branch's.

## Defects

1. The three-second fallback in `writeBadge` (`src/app/badge.ts`) wrote the badge directly even when this page's account generation had
   ended since the post, and kept arming itself for a worker that had already answered an earlier write. Either write lands outside
   the order the worker keeps for account words and counts.
2. A worker without the badge API still answered `{ badge: true }` (`scripts/service-worker.js`, the `BADGE` handler), so the page
   concluded the worker had written the badge and never wrote it. No badge showed in such a browser.

## Change

- `src/app/badge.ts:59` `workerAnswered`: set when a worker answers a write with anything but `{ badge: false }`. From then on no
  timeout is armed (line 91), since a worker that answers once answers always, and the page takes over only where it asked and got
  nothing.
- `src/app/badge.ts:90` `writeHere`: every write the page makes itself, from the timeout or from a `{ badge: false }` answer, runs only
  if `accountGeneration()` is the one the write was asked in. The next account's page says its own count.
- `scripts/service-worker.js:117`: a worker with neither `setAppBadge` nor `clearAppBadge` answers `{ badge: false }` at once, and the
  page writes the badge itself. The check moved out of `setPageBadge` into the handler; the badge steps are otherwise unchanged. A
  `{ badge: false }` answer does not set `workerAnswered`, so the next write has the timeout.
- The README paragraph on the badge says both.

## Tests

`tests/app-badge.test.ts` (jsdom, fake service worker container and message channel; the fake now delivers an answer only to an open
port, as a browser does):

- After one answer, a later write that is never answered is not taken over, however long it takes.
- A write asked in an account generation that has since ended is dropped at the timeout, and a write asked in the new generation
  still falls back.
- `{ badge: false }` writes the count and the clear at once and closes the port; the next write still has the timeout.
- `{ badge: false }` that arrives after the generation ended writes nothing.

`tests/service-worker.test.ts`: a worker without the badge API answers `{ badge: false }` for a count and a clear, and keeps no record
of a badge. This replaces the case that expected `{ badge: true }`.

### Red runs

Each protecting line broken by hand, the file restored, over `tests/app-badge.test.ts` and `tests/service-worker.test.ts`.

| Mutation | Result |
| --- | --- |
| Timeout always armed | failed: the after-an-answer test (1) |
| An answer never recorded | failed: the after-an-answer test (1) |
| No generation check on either path | failed: the timeout drop and the late `{ badge: false }` tests (2) |
| No generation check on the `{ badge: false }` path only | failed: the late `{ badge: false }` test (1) |
| `{ badge: false }` ignored | failed: the write-at-once test (1) |
| `{ badge: false }` counted as an answer | failed: the write-at-once test, on its last assertion (1) |
| Worker answers `{ badge: true }` without the API | failed: the worker test (1) |

### Orderings

`tests/service-worker-orderings.test.ts`, zero failures in all six runs: 3 account words, 20,000 orders each from seeds 1, 100001 and
200001; 4 account words, 40,000 orders each from the same seeds. The worker's badge steps did not change, so this confirms that moving
the API check out of `setPageBadge` changed none.

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` pass. `npm test`: 204 files, 3,614 tests. `npm run build` passes. `npm run test:e2e`:
40 passed in full Chromium.

## Not exercised

A browser whose worker lacks the badge API while its page has it. The worker case is a fake with no `navigator.setAppBadge`; no real
browser was found with that split. An installed app's badge on a real device, as in the entry for the previous head.
