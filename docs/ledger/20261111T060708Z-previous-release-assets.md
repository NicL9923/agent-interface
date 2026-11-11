# November 11 a page open across a deploy still loads its files from the release it replaced

Branch `t3/rollback-asset-grace` over `origin/main` at `589f542`, on NicolasLaptop (Fedora 44, Linux x64, 32 cores), Python 3.14.10,
Node 24.22.2, ruff 0.17.3. Source fingerprint `sha256:ede7c92db94220a302da49424f7be246e4cf85b88eba98a3c080b4b8762f044a`
(1769 source files) with the change applied, before this entry. No Hermes process ran, nothing was deployed and the production host
was not touched. Line numbers are this branch's.

## Defect

Activation replaces the app, and the service serves `dist/client` of the new release only. A page that opened under the previous
release and later asks for one of that release's hashed `/assets/` files (a lazy screen, the terminal, a library chunk) gets the
uncached 404 from `src/server/app.ts` (`setNotFoundHandler`), and the screen says "This screen could not load" until the person
reloads. `20261110T010000Z-missing-chunk-recovery.md` recorded the plan and deliberately left it undone: serve the missing file
from the previous release's `dist/client/assets`.

The host keeps what that needs. Each release lives in `APP_BASE/releases/release-*`, `current` points at the live one, and
`release-app.py` prunes only releases that are not the live release or the rollback target the live release's deploy configuration
names (`REMOTE_PRUNE`), so the release being replaced stays on disk. Nothing told the app which directory it was.

## Change

- `.agents/tools/deploy_common.py:21` `PREVIOUS_RELEASE_FILE = "dist/previous-release.json"`, and `:290` `Deployment.switch` calls the
  new `name_previous_release` (`:295`) before it moves `current`. It writes `{"assets": "<previous>/dist/client/assets"}` into the
  release going live, atomically, so both the guarded activation and the bootstrap tool's rollback (`switch(old_release)`) name the
  release they replace. It removes a file left from an earlier cycle when there is nothing to name: a first release (no `current`),
  a switch to the release already live, or a previous release without an assets directory. A failed write is logged to the
  operation's command log and never stops the cutover, since the grace is a courtesy to pages already open.
- `src/server/static-cache.ts` (a module the qualification test lists as plumbing, so it is not a qualification input):
  `readPreviousAssets` reads that file (absent: no grace, no warning; unreadable, malformed, a non-object, a non-string or relative
  `assets`: no grace and a warning). `previousAssetFile` accepts a request path only when it is `/assets/<hashed name>` with the same
  name rule as the current `isHashedAsset` (no slash, 8 hash characters), and only when `realpath` of the file is a regular file
  inside the `realpath` of the directory. `isPreviousAsset` gives the file the same `immutable` cache header as a live asset.
- `src/server/app.ts:162-163` reads the file once at start (`options.previousRelease`, else `dist/previous-release.json` beside
  `dist/client` when no `clientRoot` is given, so a test never reads an ambient file); `:171` the static plugin's `setHeaders`
  treats a file of that directory as hashed; `:190` the 404 handler sends it for GET and HEAD with `reply.sendFile(name, root)` and
  logs `Served a retired asset from the previous release`. Every other `/assets/` request still gets the uncached plain-text 404.
- `README.md`, `docs/Hosting.md` ("Pages open across a deploy"), `.agents/tools/README.md`.

One release of grace, no clock. The file names exactly one release, each activation or rollback renames it, and pruning keeps the
rollback target, so the grace lasts as long as that directory is named and exists. A time limit would add a second rule to get
wrong and no case where it helps: served files are content-hashed and immutable.

## Tests

`tests/static-cache.test.ts` (10 new, 20 in the file) runs the real Fastify app against a temp layout of two releases, a secret
beside the previous release's assets and another outside the release, plus links:

- A file only the previous release has is served 200 with the live asset's `Cache-Control` and content type, with a query string,
  and for HEAD; the live copy wins when both have the name.
- Absent from both releases: the uncached `text/plain` 404.
- Files that exist in the previous release but fail the name rule (`logo.png`, a short hash, a subdirectory, a directory named like
  an asset) get the 404, each with its reason.
- Traversal: raw and escaped `..` (`%2e%2e`, `..%2f`, `%2e%2e%2f`, `%5c`) and a `%00`, aimed at a secret beside `assets/` and
  one outside the release. No body contains either secret.
- Links: a hashed name that links to a file outside the directory, and one to a directory outside it, get the 404; a link to another
  file inside the directory is served. A configured directory that is itself a link works, with the immutable header.
- A POST gets the 404. A malformed escape gets Fastify's 400 and, passed to `previousAssetFile` directly, no file.
- A pruned directory, or no file at all, leaves the 404 as before.
- The file is read in the place the tooling writes it: the default path with no `clientRoot` (the test changes directory), and a
  comparison of `PREVIOUS_RELEASE_FILE` in `deploy_common.py` with the path in `app.ts`, since a drift would silently stop the grace.
- `readPreviousAssets` against eight bad files, each with its warning, and the missing file with none.

`tests/deploy_common_test.py` `DeploymentTests` (4 new): the release going live is told the previous release's assets directory,
and a rollback names the release it came from; a stale name is replaced, and removed for a switch to the live release or a
previous release without assets; a first release writes nothing; an unwritable name is logged and the cutover completes.

## Red proof

A scratch runner applied each replacement, ran the file (`vitest run`, or `python3 -B -m unittest` with
`PYTHONDONTWRITEBYTECODE=1` and every `__pycache__` removed), and restored it. All 19 went red; the restored tree then passed.

| Broken | Red |
| --- | --- |
| `setHeaders` ignores the previous release's files | the served-file test and the linked-directory test |
| The 404 handler never looks in the previous release | the same two |
| Any method may read the previous release | the POST test |
| No hashed-name rule | the name-rule test |
| No containment check | the links test |
| A directory named like an asset is served | the name-rule test |
| The configured directory is not resolved with `realpath` | the linked-directory test |
| A relative path in the file is accepted | the bad-file test |
| A non-string `assets` is accepted (`String(x)`) | the bad-file test, after a case with an array was added: it first survived |
| An unreadable file is silent | the bad-file test |
| A missing file warns | the bad-file test |
| The app reads another file name | the contract test and the default-path test |
| The tooling writes another file name | the contract test |
| `switch` does not name the previous release | 4 tests |
| A switch to the live release names itself | the stale-name test |
| A previous release without assets is named | the stale-name test |
| A stale name is never removed | the stale-name test |
| A failed write stops the cutover | the unwritable-name test |
| The release root is named, not its assets directory | the naming test and the stale-name test |

Four breaks were equivalent and the code they guarded was deleted rather than tested: a NUL and a backslash refusal in
`previousAssetFile` (`fs` already throws on a NUL and Linux has no backslash separator), an `Array.isArray` check (an array has no
`assets`), the hashed-name test inside `isPreviousAsset` (only `previousAssetFile`'s files reach it), and the `decodeURIComponent`
(an undecoded escape names a file that does not exist).

## Checks

`.agents/tools/check-all --py always --keep-going` on the tree before the documentation sentences were corrected: all 7 passed in
6m35s, 18.8 s of it queued for the machine's heavy slot.

| Check | Result |
| --- | --- |
| typecheck, lint, `ruff check .` (0.17.3) | passed |
| `npm test` | 205 files, 3,680 tests passed |
| `npm run build` | 892 modules |
| `npm run test:e2e` | 40 tests passed (ports 24826, 24827) |
| `npm run test:py` | 46 files passed in 4m21s |

## Production compression, read from the repository only

The app compresses nothing: `src/server/app.ts` registers `@fastify/static` without `preCompressed`, and no `@fastify/compress` or
build-time compression plugin is installed (`package.json`, `vite.config.ts`). So the bundle is compressed in production only if
Caddy has an `encode` directive for the site. The repository holds no Caddyfile and no document says so. `docs/Hosting.md` calls
Caddy a reverse proxy and says it should pass the app's security headers through; `20261110T155144Z-early-bootstrap.md` and
`20261110T190000Z-early-bootstrap-review-fixes.md` record "production compression: not measured". The one hint is a comment in
`src/server/event-stream.ts:114`, "Caddy's encode handler would hold notices in its compressor; it skips an encoded body", which
sends `Content-Encoding: identity` on event streams and assumes an `encode` exists. Caddy does not compress by default.

The size at stake, from this build: `index-YdaPv04v.js` 450,683 bytes, 140,572 with `gzip -9`; `xterm` 330,929 and 81,868; `rfb`
187,377 and 55,570. The host was not contacted. Check on it with
`curl -sI -H 'Accept-Encoding: gzip, br' https://APP_ORIGIN/assets/NAME.js | grep -i content-encoding`.

## Not exercised

No real release was built twice, no activation ran, and no browser held a page across a deploy: the server tests drive the real app
over `inject` against a temp layout, and the tooling test drives `Deployment.switch` against temp release directories. The
`current` link and `release-app.py`'s pruning were read, not run. `reply.sendFile` with a root other than the plugin's, and its
`setHeaders` call for that file, are exercised by the tests, not by a socket.

## Qualification and operator notes

`src/server/app.ts` is on `src/shared/qualification-inputs.json`; no other changed file is (`static-cache.ts` is listed as
plumbing in `tests/hermes-qualification.test.ts`, `deploy_common.py`, the README files and the tests are not inputs). The next
release therefore needs a new Hermes qualification: `release-app.py prepare COMMIT ... --qualification RECEIPT`, produced with
`qualify-app-release.py NAME`. `scripts/hermes-upgrade-linux.py` does not change here, so `--accept-helper-change` is not needed
for this branch. `release-app.py activate` runs the guarded tool from the release being activated (`cd RELEASE && python3
.agents/tools/deploy-guarded-app-release.py`), so the first activation of a release that carries this change already writes the
file, and the new server reads it at its start: pages open under the release it replaces get the grace at once.
