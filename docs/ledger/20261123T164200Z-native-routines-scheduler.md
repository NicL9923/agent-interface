# Native routines scheduler validation

Node v24.22.2 on NicolasLaptop. The scheduler implementation and focused test diff in
`b9db2a49` against `2ee7ec9a` had SHA-256
`7f83ab8fe0c4302f554e29f8dd2b7c3039ab8cf8f3456c9360c2bb9cdc8a8f69`.

## Checks

| Command                                                         | Result                 |
| --------------------------------------------------------------- | ---------------------- |
| `npm ci`                                                        | 335 packages installed |
| `npm run typecheck`                                             | Compiled               |
| `npm run lint`                                                  | Passed                 |
| `npm run format:check`                                          | Passed                 |
| `npx vitest run tests/native-scheduler.test.ts`                 | Unit-passed, 40 tests  |
| `TZ=Asia/Kolkata npx vitest run tests/native-scheduler.test.ts` | Unit-passed, 40 tests  |
| `npx vitest run tests/store-migrations.test.ts`                 | Unit-passed, 10 tests  |

The requested static and focused Vitest checks also passed at `c162e9d2`.

The scheduler tests used real SQLite databases, an injected clock, and callback fakes for
execution and delivery. The crash test reopened a file-backed database and checked the
single-flight constraint from a second SQLite connection. Runtime callbacks for a live
harness, chat, and push delivery are part of server integration.

Cron skips spring-forward gaps and resolves both UTC instants in fall-back folds.
Schedules use the restricted day-of-month or day-of-week match when both fields are restricted.
[crontab(5)](https://github.com/cronie-crond/cronie/blob/master/man/crontab.5)

A local `zdump` check covered 418 IANA zones in tzdata 2026f from 1800 through 2499. The
closest offset changes within one zone were 167 hours apart. The largest absolute offset was
15.94 hours.

## Red runs

The target tests failed for all 24 mutation runs. The runner restored each changed source file
byte for byte after every run.

| Coverage        | Changes that the tests caught                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cron validation | Zero step accepted, missing time zone defaulted to the server time zone                                                                                                          |
| Cron matching   | Requiring both restricted day fields, losing Sunday 7, including the starting instant, allowing gaps, dropping a fold                                                            |
| Quiet results   | Dropping overnight logic, delivering the quiet marker, delivering Markdown-wrapped markers, skipping check-in quiet hours, posting after quiet hours began                       |
| Admission       | Ignoring the scheduled or manual overlap guard, dropping the SQLite unique index, running stale work that should skip, skipping a current occurrence, keeping a try-once enabled |
| Lifecycle       | Dropping cancellation, skipping startup recovery, posting after deleting the bot                                                                                                 |
| Credentials     | Removing group policy or the credential check before delivery                                                                                                                    |

## Rollback compatibility

The repository check at `b9db2a49` passed 4,504 Vitest tests and failed one. The rollback
test applied its plain-index rule to the two partial indexes on new routine tables.
Commit `c162e9d2` binds each of those indexes to its exact new table. The test continues
to require a plain, non-unique definition for other added indexes. Two red runs proved
that the test rejects either a named scheduler index moved to `drafts` or a new partial,
unique index on `drafts`.

## Repository check

`check-all --keep-going --py always` acquired the machine lock after 22 minutes and
55 seconds. The check itself took 18 minutes and 20 seconds, including 8 minutes and
12 seconds queued on the repository lock.

| Phase   | Result                                                                              |
| ------- | ----------------------------------------------------------------------------------- |
| Static  | Typecheck and lint passed. Ruff passed.                                             |
| Vitest  | 4,504 passed and one failed. All 10 migration tests passed after the test-only fix. |
| Build   | Built with 911 modules.                                                             |
| Browser | All 142 Chromium tests passed. All 142 WebKit tests failed to launch.               |
| Python  | Passed, 52 files.                                                                   |

A standalone Playwright WebKit launch reproduced the missing-library error. Fedora 44
provides ICU 77 and libjpeg 62. The WebKit build on this host requires ICU 74 and
libjpeg-turbo8. [Playwright system requirements](https://playwright.dev/docs/intro#system-requirements)
