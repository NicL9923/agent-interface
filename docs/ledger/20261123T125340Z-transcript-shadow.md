# November 23 SQLite transcript shadow

Code state: `sha256:0ef5aa93ff250af6edeb7b9864636d9e41e03f1b935e576968933fc483fa4e05`
on top of `320740c3`, recorded by `.agents/tools/source-state.py`. The checks ran on Node
24.22.2 with SQLite 3.53.4. The Bun smoke check ran on Bun 1.4.5 with SQLite 3.54.1.

- `npm run typecheck && npm run lint && npm run format:check` passed.
- `npx vitest run tests/store-transcripts.test.ts tests/store*.test.ts` passed, 38 tests in
  3 files. The tests use SQLite for paging, FTS5, transaction rollback, deletion, and reopening
  the previous schema. The Hermes shadow tests use the runtime's conversation contract.
- Bun ran append, paging, preview, snapshot replacement, scoped search, and the FTS5
  `integrity-check` against an in-memory database.
- The file-backed paging check loaded 120,000 messages across two bots. After 10 warmups,
  500 calls read 50 messages at a time, alternating the latest page and older cursors from
  the 100,000-message conversation. The median was 0.134 ms, p95 was 0.184 ms, and the maximum
  was 1.588 ms. These timings cover the repository call on NicolasLaptop.

Each mutation below made its targeted test fail. The original sources were restored before the
repository check.

| Mutation                                           | Failure observed                                      |
| -------------------------------------------------- | ----------------------------------------------------- |
| Make the page cursor inclusive                     | The previous page repeated a boundary message.        |
| Remove the bot filter from search                  | Search returned a private bot's result.               |
| Retain stale sequence numbers after a reorder      | Snapshot rows returned in their old order.            |
| Leave the old message text in FTS after an edit    | A search for the old text still found the edited row. |
| Ignore order differences during shadow comparison  | The mismatch count missed the moved row.              |
| Publish a stale Hermes read after forgetting a bot | A deleted bot's transcript returned.                  |

## Hermes qualification manifest

The first full app suite passed 4,298 tests and failed the Hermes qualification dependency
check because `store.ts` imported an unlisted module. The manifest now includes
`store-transcripts.ts` and the Hermes backfill entry point `transcript-sync.ts`. The first
`check-all` process exited 143 after it started the browser suite.

Code state after the manifest change:
`sha256:e0a138ccf6c85485cb7a5feaa1a1a4e53b0027b3b3685a47904d860a1a0fa50a`.

- Typecheck, lint, and format check passed again.
- `npx vitest run tests/store-transcripts.test.ts tests/store*.test.ts tests/hermes-qualification.test.ts`
  passed, 43 tests in 4 files. The qualification check also verified the shared app and
  Python integration digest.

## Full repository checks

The application source is commit `2d36999545af7cdc9793f948c4fd7ff1bdc2495d`. The
`check-all --keep-going` retry passed typecheck, lint, Ruff, the build, and all 4,299
Vitest tests in 232 files. The terminal process received SIGTERM during Playwright,
so a detached `check-all --only e2e,py --keep-going --verbose` resumed the remaining checks.

| Check                      | Result                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| Chromium on Fedora         | 142 passed                                                                    |
| WebKit on Fedora           | 142 launch failures. Playwright reported missing ICU 74 and JPEG 8 libraries. |
| Python 3.14.10             | 52 files passed in 316.3 seconds                                              |
| WebKit in Playwright Noble | 137 passed, 3 skipped, 2 failed in 4.5 minutes                                |

The WebKit fallback used the installed `mcr.microsoft.com/playwright:v1.65.0-noble` image and
Node 26.13.1. The first container run used `--network none`, which put WebKit into
offline mode. The accessibility test passed with normal container networking, and the
full WebKit rerun used that setting.

Both failures reproduced on a fresh build of the base commit `320740c3` using the same
container. The test at `e2e/smoke.spec.ts:40` reported errors loading the same two lazy
chunks in the service worker. The test at `e2e/smoke.spec.ts:811` timed out waiting for
the same `Fence check 24:` text. The backfill and comparison tests used a runtime fixture.
