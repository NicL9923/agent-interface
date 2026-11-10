# November 10 bootstrap starts before the bundle

Branch `t3/early-bootstrap`, from `origin/main` at `d6909e4`. Checks ran on NicolasLaptop (Fedora,
Linux x64, Node 24.22.2, Chromium from Playwright 1.64.1) on the branch's code as committed. No
Python, iOS, Hermes or server API code changed. The server change is static-file handling only.

## What `main` does

- `/api/bootstrap?roster=lean` is the first read, made by `useSession` in
  `src/app/use-session.ts` from a `useEffect`, so it waits for the whole bundle to download, parse
  and run.
- The theme is a server preference (`Preferences.theme`). `src/App.tsx` sets
  `<html data-theme>` from it only after bootstrap, and to `system` before. A person who chose dark
  on a light system sees light until bootstrap answers.
- The CSP (`src/server/security-headers.ts`) has `script-src 'self' …`: an external same-origin
  script at `/boot.js` runs, an inline one does not. The policy is unchanged.

## Change

- `public/boot.js`, loaded first in `index.html`'s `<head>` as a classic blocking script, applies
  the saved theme and starts the bootstrap read, left on `window.__wildbotsStartup` with a version
  and its path. It is hand-written and served as written: Vite does not bundle classic scripts, a
  module script would run after first paint, and the theme must land before it.
- `src/startup-read.ts`: `api()` takes that read for the same path, once, on a GET it holds no copy
  of, and runs its Response through every check its own response gets. A read that fails or is
  aborted hands over to `api()`'s own request. Another version or shape is dropped. An account
  change (`clearResponseCache`) drops it. The caller's deadline aborts it.
- `src/app/saved-theme.ts` keeps `{ v: 1, user, theme }` in `agent-interface:theme`. It is saved
  only for the account the sign-in hint names and removed with the hint at sign-out, refusal and a
  new sign-in (`accountKeys` in `src/app/storage.ts`). `App.tsx` leaves `boot.js`'s theme in place
  until bootstrap answers and sets `system` on the sign-in screen.
- `src/server/static-cache.ts`: `boot.js` is revalidated (`no-cache`) like the shell, and
  `src/server/app.ts` answers a missing `/boot.js` with the uncached 404 that a missing asset gets.
- `scripts/service-worker.js`: `boot.js` follows the shell's rule from #301, so the two come from one
  release. `scripts/build-worker.mjs` fails the build if `boot.js` is not installed with the shell.
- `.agents/tools/measure-first-load.mjs` measures the load.

## Measurements

`node .agents/tools/measure-first-load.mjs --runs 4 --rounds 3 --compare main=DIR,sync=DIR,async=DIR`
with three saved builds: `main` at `d6909e4`, this branch, and this branch with `async` on the
script tag. Chromium, Slow 4G (150 ms, 1.6 Mbps down, 750 kbps up) and a 4x CPU slowdown, the
member's theme dark on a light system. Medians of 12 loads each, in ms from navigation start, rounds
alternated because the machine was loaded (load average 18 to 31).

| Build, load | Bootstrap sent | Answered | First paint | Theme | Roster | Light shown |
| --- | --- | --- | --- | --- | --- | --- |
| main, no worker, cold cache | 5571 | 5736 | 2404 | 5919 | 5919 | 3514 |
| main, no worker, warm cache | 496 | 658 | 252 | 850 | 851 | 610 |
| main, worker's cached shell | 317 | 478 | 52 | 661 | 662 | 613 |
| branch, no worker, cold cache | 3340 | 3554 | 2348 | 455 | 5831 | 0 |
| branch, no worker, warm cache | 328 | 489 | 336 | 327 | 810 | 0 |
| branch, worker's cached shell | 40 | 203 | 48 | 40 | 513 | 0 |
| async tag, no worker, cold cache | 3483 | 3688 | 2340 | 3483 | 5832 | 1141 |
| async tag, no worker, warm cache | 439 | 601 | 204 | 451 | 785 | 244 |
| async tag, worker's cached shell | 46 | 210 | 48 | 46 | 511 | 0 |

- Every load counted one bootstrap read before the roster painted, except one of the 12 async-tag
  loads under the worker, which counted two. An async script can run after the bundle has made its
  own read, and it then starts a second; a blocking one cannot. That, and the light page an async
  script leaves on cold and warm loads, is why the tag stays blocking.
- The blocking script costs first paint about 84 ms with a warm HTTP cache and no worker, where
  `boot.js` is revalidated. That first paint is an empty page; the roster still paints 41 ms sooner.
- Cold, the request is sent at 3.3 s although `boot.js` ran at about 455 ms: the local server speaks
  HTTP/1.1, and the request waits for one of six connections behind the bundle's 60 files. Over
  HTTP/2, as Caddy serves production, it would not wait. The roster stays bound by the bundle, about
  434 KB of uncompressed JavaScript at 1.6 Mbps.
- Sequential runs before the interleaved one showed the branch's roster at 1.4 s; interleaved, that
  was the machine's load, not the change.

## Application tests

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- Focused: `tests/startup-read.test.ts`, `tests/linked-chat-ui.test.ts`, `tests/static-cache.test.ts`,
  `tests/service-worker.test.ts`, `tests/precache-plan.test.ts`, `tests/client-api.test.ts`: 6 files,
  196 tests passed.
- `npm test`: 187 files, 3,135 tests passed.
- `npm run build` passed: 65 installed files, `boot.js` among them.
- `npm run test:e2e`: 21 Chromium tests passed, including the new "a returning member's load…" case.

## Mutants

Each line was broken by hand, the focused tests run, and the source restored. All 29 went red.

| Mutation | Failed |
| --- | --- |
| `api()` never takes the startup read | "is the page's only bootstrap read on a normal load", "answers the app's first bootstrap, so the page reads it once" and 2 more |
| `clearResponseCache` keeps it | "is dropped when the account changes before the app asks for it" |
| Path check removed | "is left for its own path…" |
| Version check removed | "is dropped, and aborted, when it has a version from the future" |
| Response shape check removed | "…when it has no response" |
| A failed read not handed to `api()`'s own | "is read again by the app when it fails…", "hands over to the app's own read after a network failure", "…after an abort" |
| A deadline falls back instead of failing | "counts toward the app's deadline, which aborts it without a second read" |
| The deadline does not abort the read | same |
| A taken read stays on `window` | survived the first pass; "is taken once, so the read after an error answer asks the server again" was added and goes red |
| `boot.js`: theme for another account, lapsed sign-in, theme version, theme value, hint without a chat list | the matching "is not applied for…" case each |
| `boot.js`: runs twice, no cookie, full roster, no expiry | "starts once per page", "is the request the app makes…", the UI bootstrap cases, "lets go after a minute…" |
| `App` resets the theme before bootstrap | "stays as boot.js applied it until bootstrap answers…" |
| `App` keeps the saved theme on sign-in | "gives way to the system's on the sign-in screen" |
| Theme not saved, or saved without a hint for the account | "starts at sign-in…", "is forgotten when bootstrap names an account other…", "does not invent a sign-in…" |
| Sign-in or sign-out keeps account records | "starts at sign-in…", "is forgotten when the person signs out" |
| Server: `boot.js` not revalidated; missing `boot.js` gets the shell | the two `static-cache` cases |
| Worker: ignores the outdated note; no offline fallback; not intercepted | the three `boot.js` worker cases |
| e2e: `<script src="/boot.js">` removed, rebuilt | "a returning member's load…" at the request order, `bundle` before `/api/bootstrap` |

## Not exercised

- Safari, Firefox, an installed home-screen app and a real phone: not run. Only Chromium runs here.
- HTTP/2: not measured; the local server speaks HTTP/1.1.
- A browser signed in before this release has no sign-in record, so `boot.js` applies no theme until
  its next sign-in, at most seven days. It still starts the read.
- Production compression was not checked. The cold load is bound by the uncompressed bundle.
