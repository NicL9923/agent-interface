# November 9 the app shell opens from the worker's cache

Branch `perf/cache-first-shell`, from `origin/main` at `0d205eb`. Checks ran on NicolasLaptop
(Fedora, Linux x64, Node 24.22.2, Playwright Chromium) at commit `57416d6`, which this entry follows.
No server, Python, iOS or Hermes code changed.

## Change

- `scripts/service-worker.js`: a navigation to `/` or `/index.html` gets the active release's
  cached shell. Only a cache without a shell falls back to the network. A background fetch of
  `/index.html` (`no-store`, `redirect: 'manual'`) then runs `registration.update()` when the
  shell differs, and unregisters the worker and reloads its windows on a redirect, 401 or 403.
  An error status or a failed fetch changes nothing. No navigation preload.
- `src/app/use-browser.ts`: a load whose registration already has a waiting worker sends it
  `SKIP_WAITING` and reloads on `controllerchange`, the same path as tapping Refresh. A worker
  that finishes installing during the visit is still offered with the notice.
- The e2e server answers `sw.js` as a next release's worker, with another cache name, after
  `POST /next-release` on its control port.

## Staleness rule

Cache-first, with a background shell check that triggers the existing update check. The page
moves to a release that was already waiting when it loaded. A person who never taps Refresh
reaches the new release on their next load after it installed.

A worker-side handover was tried first and dropped. On a navigation the old worker told the
waiting worker to skip waiting and answered with `Refresh: 0`. In Chromium, the old worker
stayed active for about a second after that. A newly active worker could still see itself in
`registration.waiting`. The reload repeated and then hung in the e2e run.

## Application tests

- `npm run typecheck` and `npm run lint` passed. `npm ci` ran once, on the first branch of this
  set, with the same lockfile.
- `npx vitest run tests/service-worker.test.ts tests/app-update.test.ts`: 2 files, 51 tests passed.
- `npm test`: 170 files, 2,563 tests passed.
- `npm run build` passed, including the precache-plan guards, then `npm run test:e2e`: 4 Chromium
  tests passed, including the existing offline case and the new release case.

## Mutants

Each line was broken by hand, the focused tests run, and the source restored.

| Mutation | Result |
| --- | --- |
| Network first again | failed: 6 shell tests, including "opens from this release's cache without waiting on the network" |
| No network fallback without a cached shell | failed: "opens from the network when this release holds no shell…" |
| Update check on a changed shell removed | failed: "checks the server's shell afterwards…" |
| Shell comparison inverted | failed: same |
| `redirect: 'manual'` dropped | failed: same |
| Served shell's body reused for the comparison | failed: same, "Body has already been consumed" |
| `unregister()` removed | failed: 3 "removes itself and reloads open windows…" cases |
| Window reload after unregister removed | failed: same 3 |
| 403 not treated as a gate | failed: the 403 case |
| Redirect not treated as a gate | failed: the redirect case |
| Error status not ignored | failed: "keeps opening from the cache through a server error" |
| A build waiting at load only offered | failed: "moves a load to a build that was already waiting…" |
| A build installed mid-visit applied without asking | failed: "finds a build deployed while the app stays open", "offers a build that finishes installing during the visit…" |
| e2e: a build waiting at load only offered, rebuilt | failed: "an open tab is offered a new release…" at the cache-name poll |

## Not exercised

- No browser use beyond the Playwright suite, and only Chromium. Safari and an installed iOS
  web app were not run.
- The unregister path on a redirect, 401 or 403 is covered only by the worker unit tests.
- The background shell check's own update trigger is covered only by unit tests. The e2e
  release changes `sw.js` alone, so its update came from the page's check.
