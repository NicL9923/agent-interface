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

## November 9 review round

GPT-6.1 Sol reviewed the branch at `7ab32b2` and found it not ready: a 401, 403 or redirect on
the background probe unregistered the worker and reloaded every window, losing unsaved text in
another tab; a release waiting at load could be applied after the person had started an upload
or send; and a deploy whose worker could not install left every reload on the old shell. The
orchestrator chose one rule and the deletion of the rest. This round merged `origin/main` at
`0a5f28a` (merge commit `8f92004`) and changed the code at `0f57aac`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2, Playwright Chromium).

### Change

- The unregister and window-reload path is gone. A redirect, 401, 403, other non-200, failed
  fetch or broken body on the probe changes nothing.
- `src/app/use-browser.ts` and `tests/app-update.test.ts` are back to `origin/main`: a release
  waiting at load is offered, never applied.
- The worker opens the cached shell only while its cache holds no `/.shell-outdated` entry. A
  probe whose 200 body differs from the cached shell's writes that entry and runs
  `registration.update()`. With the entry, navigations are network-first with the cached shell
  as the offline fallback, as on `main`. The entry lives in the release's cache, so it survives a
  worker restart and is deleted with that cache when the next release activates.
- Shells are compared by body text. The server sends `index.html` with `@fastify/static` from
  `dist/client`, unmodified per request (`src/server/app.ts`); its CSP and cache headers are
  headers, which are not compared. The install fetch and the probe take the same path, so a proxy
  that rewrites the body the same way each time rewrites both. A proxy that changes the body on
  every request would make every probe differ, which only costs the cache-first open: the worker
  behaves as `main` does. An ETag was not used because `@fastify/static` derives it from the
  file's modification time, which changes on every deploy whether or not the text did.
- e2e: `POST /next-release` now also serves a shell with `<meta name="release" content="next">`,
  and `?install=fail` serves a worker that lists a missing file, which the server answers with the
  shell, so its install fails as a real incomplete deploy would.

### Red before the fix

On `7ab32b2` plus the new tests (`tests/service-worker.test.ts`, and `tests/app-update.test.ts`
as on `main`): 7 failed.

- "changes nothing when the check gets a redirect", "…a sign-in", "…a refusal": "expected
  vi.fn() to not be called at all, but actually been called 1 times", the unregister.
- "notes a changed shell…": "expected false to be true", no note; "keeps the note when the
  browser stops the worker…": the restarted worker answered with the cached shell.
- "shows a build already waiting and switches to it before reloading": "expected '' to contain
  'Update available'", the load had applied it.
- "changes nothing when the check gets a body that breaks off": the head did not catch it.

e2e on `7ab32b2`'s worker and `use-browser.ts`, rebuilt: "a new release whose worker cannot install
still reaches the person on their next load" failed at the poll for the note, which the head
never writes, so its next load kept the cached shell. "after a deploy, the next load opens the new
shell…" failed earlier, at its first reload, because the head applied the waiting release there.

### Mutants

| Mutation | Result |
| --- | --- |
| Note ignored on open | failed: "notes a changed shell…", "keeps the note when the browser stops the worker…" |
| Non-200 probe compared | failed: the 401, 403 and 500 cases |
| Probe errors not caught | failed: "no network", "a body that breaks off" and 2 older offline cases |
| Comparison inverted | failed: 3 cases |
| Note not written | failed: 2 cases |
| `update()` not run | failed: "notes a changed shell…" |
| No offline fallback once noted | failed: "opens the cached shell offline once the note is set" |
| Probe awaited before answering | failed: "opens from this release's cache without waiting on the network" |
| Note kept in a cache that outlives the release | failed: "starts a new release with no note…" |

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/service-worker.test.ts tests/app-update.test.ts`: 2 files, 56 tests passed.
- `npm test`: 171 files, 2,662 tests passed.
- `npm run build`, then `npm run test:e2e`: 5 Chromium tests passed, including the existing
  offline case.

### Not exercised

- Safari, Firefox and an installed iOS web app: not run. Only Playwright Chromium ran.
- A real proxy or CDN in front of the app.
