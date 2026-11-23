# November 23 managed bot registry

Code state `sha256:690956df4ed30181ad5d8311f613bafbdb7999e65c674b7ff7e6955641210a7a`
on base `320740c3`, from `python3 .agents/tools/source-state.py`. Validation used Node
24.22.2, npm 11.19.1, and Bun 1.4.5 on LaptopServer.

| Command                                                                  | Result                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------- |
| `npm ci`                                                                 | Installed 335 packages, 0 vulnerabilities      |
| `npm run typecheck`                                                      | Compiled                                       |
| `npm run lint`                                                           | Passed                                         |
| `npm run format:check`                                                   | Passed                                         |
| `npx vitest run tests/store-bots.test.ts`                                | 27 tests passed                                |
| `npx vitest run tests/store-bots.test.ts tests/store-migrations.test.ts` | 37 tests passed                                |
| Bun SQLite smoke                                                         | Exercised registry writes and schema version 2 |

Twenty-two deliberate mutations each made the targeted test fail. These covered the
credential kind, allowed harness array and members, required subscription owner,
environment variable references, harness match, API key access, sharing, exact owner
match, Unix account match, group chat, handoff, routine delivery, unknown context,
sharing updates, credential writes, credential changes for live and archived bots,
live credential deletion, outer transaction rollback, and the schema version.
All mutated files were restored before the final checks.

The Bun smoke used the real in-memory store. It saved a bot and credential in an outer
transaction, changed the harness, confirmed the live credential deletion refusal,
switched the bot to Hermes, and deleted the credential. No vendor CLI or token was
involved. Group chat, handoff, and routine delivery were exercised as policy inputs.

## Qualification manifest

The first full Vitest run on `be46d515` found one missing dependency in the Hermes
qualification manifest. The qualification suite passed all five tests on the base
commit `320740c3`. The manifest now includes the repository and its two new imports,
so the app and the Hermes qualification worker bind the same source.

The updated source fingerprint is
`sha256:93285ada4d38558ce34a9b5c91be19863fb65816c7607bf9eee49b8054062224`.
Typecheck, lint, format check, all 27 registry tests, and all 15 combined
qualification and migration tests passed on that source.

## Repository-wide checks

`.agents/tools/check-all --keep-going` passed typecheck, lint, Ruff, the build of
912 modules, and the Python suite covering 52 files. Its initial unit run reported
4,308 passed and one failed before the manifest correction. All 142 Chromium
tests passed. All 142 WebKit tests failed at browser launch because the Fedora
host lacks `libicu74` and `libjpeg-turbo8`. Launching the same browser on the
base commit reproduced the missing dependencies. The web build artifacts
were byte-for-byte identical to the base build.

`.agents/tools/check-all --only test` passed all 4,309 tests in 232 files on
`64a16a0f`. The unit suite took 20.5 seconds after waiting 4 minutes 23 seconds
for the repository lock.

The first container attempt used an isolated network that made WebKit report
offline. The retry used default container networking and Node 24.22.2 in
`mcr.microsoft.com/playwright:v1.65.0-noble`. WebKit reported 137 passed,
3 skipped, and 2 failed in 5.7 minutes. Both failures reproduced on
`320740c3` in the same container:

- `e2e/smoke.spec.ts:40` logged service-worker chunk load errors during the
  offline reload.
- `e2e/smoke.spec.ts:811` timed out waiting for the seeded transcript's latest
  message before measuring the phone composer.
