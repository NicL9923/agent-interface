# Native routines scheduler validation

Node v24.22.2 on NicolasLaptop. The production and test diff against `2ee7ec9a` had SHA-256
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
