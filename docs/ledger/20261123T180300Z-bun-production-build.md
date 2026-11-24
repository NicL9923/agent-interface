# November 23 Bun production build and service preflight

`python3 .agents/tools/source-state.py` recorded
`sha256:0c224697aefbc72e613f3b5609fb39679c94895e42ce11f1c677bfd8de8074ce`
on top of `29df1c10`. Checks used Bun 1.4.5, Node 24.22.2, and Python 3.14.10
unless noted.

- `npm ci`, `npm run typecheck && npm run lint && npm run format:check`, and
  `.agents/tools/check-all --only ruff` passed. The last command used pinned Ruff 0.17.4.
- `npx vitest run tests/bun-server-build.test.ts tests/bun-runtime.test.ts`
  passed 3 tests in 2 files. With Bun absent from PATH, 1 passed and 2 skipped.
  The same files plus `tests/index-shutdown.test.ts` passed 6 tests on Node 26.13.0.
- `npm run test:py && npm run lint:py` passed. The Python runner reported
  `52 passed, 0 skipped, 0 failed in 291.6s` at the file level, including
  `tests/release_app_test.py`.
- `npm run build:server:bun` built 1,094 modules and emitted the entry point,
  linked map, and terminal helper in `dist/server/`. The test started that entry
  point on loopback, observed `/api/health` success with an invalid `.env.local`
  present, and observed exit 0 after SIGTERM.
- Offline `systemd-analyze verify` accepted the documented Bun drop-in alongside
  the Node drop-in. It also accepted the unit after removal of the Bun drop-in.

`.agents/tools/check-all --skip typecheck,lint,ruff,py --keep-going` ran under
the LaptopServer machine lock and reused the checks above. Vitest passed
4,631 tests in 251 files. The Node web build compiled 911 modules and produced
service worker `1295d4ff3cf69f95`. All 142 Chromium tests passed. All 142
WebKit tests failed before launch because the host lacks ICU 74 and libjpeg 8,
the same issue recorded in the [native routines validation](20261123T164200Z-native-routines-scheduler.md).

Both mutations made `npx vitest run tests/bun-server-build.test.ts` exit 1.
Replacing the missing-Bun diagnostic failed the no-PATH test. Replacing
`--sourcemap=linked` with `--sourcemap=inline` failed the bundle test because
preflight found no `index.js.map`. The original build script was restored byte
for byte after each run.

The live canary and the separate native wiring integration remain pending.
The in-progress wiring derives the workspace root from `APP_DATABASE`.
The hosting guide lists `WILDBOTS_WORKSPACE_ROOT` as conditional on server
support.
