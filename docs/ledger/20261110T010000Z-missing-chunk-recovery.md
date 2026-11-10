# November 10 a lazy screen whose file is gone reloads the tab once

Branch `fix/missing-chunk-recovery`, from `origin/main` at `0d205eb`. Checks ran on NicolasLaptop
(Fedora, Linux x64, Node 24.22.2, Playwright Chromium) at commit `ca01c2d`, which this entry follows.
No Python, iOS, Hermes or deploy-tool code changed.

## Change

- `src/server/app.ts`: the not-found handler answers a path under `/assets/` with 404,
  `Cache-Control: no-store`, `text/plain` and "Not found". Other unknown paths still get
  `index.html`.
- `src/app/chunk-recovery.ts`: `useChunkRecovery` listens for `vite:preloadError` and calls
  `location.reload()` when all of these hold:
  - the page check passes;
  - no `agent-interface:submission:` key, and no `agent-interface:group-send:` key other than a
    `:draft`, is in localStorage;
  - the `agent-interface:chunk-reload` time in sessionStorage is at least five minutes old;
  - that time can be written.

  It never calls `preventDefault`, so the import error still reaches the screen's error boundary
  and its Reload prompt.
- `src/App.tsx`: the page check is no `pending` send, no `sending`, no upload held in memory
  for any chat (`holdingFiles` from `useDraft`), and a chat draft that is empty or equals its
  saved local copy.

## Application tests

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/chunk-recovery-ui.test.ts tests/static-cache.test.ts`: 2 files, 18 tests passed.
- `npm test`: 171 files, 2,567 tests passed.
- `npm run build` passed, including the precache-plan guards, then `npm run test:e2e`: 4
  Chromium tests passed. The new case blocks the service worker and rewrites the Usage screen's
  file to a name the build never had, so the real server answers 404. The tab reloads once, and
  the second attempt shows "This screen could not load." with no further load.

## Mutants

Each line was broken by hand, the focused tests run, and the source restored.

| Mutation | Result |
| --- | --- |
| `location.reload()` removed | failed: 4 cases, including "reloads the tab once…" |
| Window check removed | failed: "reloads the tab once…", "leaves the screen's Reload prompt…", "counts a reload time ahead of the clock as recent" |
| Window boundary `<` changed to `<=` | failed: "leaves the screen's Reload prompt…" |
| A future time not counted as recent | failed: "counts a reload time ahead of the clock as recent" |
| Reload time not recorded | failed: "reloads the tab once…", "does not reload when it cannot remember that it did" |
| Reload although the time could not be recorded | failed: "does not reload when it cannot remember that it did" |
| Page check ignored | failed: draft, upload and send cases |
| Stored sends ignored | failed: the chat-send and group-send cases |
| A group draft counted as a send | failed: "with only a group draft…" |
| Draft copy not compared | failed: "does not reload over a draft the device could not keep" |
| Empty draft not exempt | survived at first; a case was added, then failed: "reloads with an empty draft even when the device keeps no copy of it" |
| Uploads ignored | failed: "does not reload while a file is still uploading" |
| In-memory pending send ignored | failed: "does not reload while a message send is on its way" |
| Server: missing asset gets the shell | failed: "answers a bundle a release retired with an uncached 404…" |
| Server: `/assets` prefix without the slash | failed: "serves the shell… for a route the client handles" |
| Server: `no-store` removed | failed: the 404 case |
| Server: 404 body sent as HTML | failed: the 404 case |
| e2e: `location.reload()` removed, rebuilt | failed: "the tab reloads itself once…" at the load count, received 0 |

## Deploy tooling, read only

Each release is built in its own `releases/release-*` directory. Activation switches the
`current` link and restarts the service, which serves `dist/client` from that release. The
previous release's `dist/client/assets/` stays on disk but is no longer served. `release-app.py`
prunes older release directories after each activation. It keeps the newest 10, the rollback
target named in the live deploy configuration, and anything touched in the last 7 days.

A grace period is a small change but not a trivial one. Hashed names never collide, so the
server could serve a missing `/assets/` file from the rollback release's `dist/client/assets/`.
The guarded tool already records that release. Pruning keeps it while it is the rollback
target, so one release of grace is safe. Hard-linking the previous release's assets into each
new release would compound across releases unless only that release's own build output is
copied. No deploy tooling changed here.

## Not exercised

- No browser use beyond the Playwright suite, and only Chromium.
- Unsaved state in other screens, such as a settings form, is not checked. A failed lazy
  screen is usually the one being opened, which replaces the open panel.
- A group draft that storage refused is not checked. Its composer already reports that it
  cannot save.
