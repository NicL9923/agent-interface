# Durable bot queue verification

Phase 1C on `t3/durable-bot-queue-routes`, based on `320740c3`. The binary diff against that base, excluding this ledger entry, has SHA-256 `c218168d5efe030bbc89b30074a09892660874cbae33960cddaff022e621fa9f`.

## Red runs

Each command used `npx vitest run tests/store-queue.test.ts -t <test name>` with one temporary change. Each exited 1 with the expected assertion failure. The script restored the original file after each run.

| Temporary change                                 | Assertion that failed                              |
| ------------------------------------------------ | -------------------------------------------------- |
| Skip the admission fence                         | The stale request did not throw 409.               |
| Allow claims when another item is running        | The second connection claimed a second item.       |
| Return running items to `queued` during recovery | A recovered item had the wrong status.             |
| Allow any user to edit through the repository    | The edit from another sender did not throw 404.    |
| Skip the visibility check after the runtime call | Send-now returned 200 after the assistant changed. |

## Checks

- `npm ci` installed the worktree's dependencies with zero vulnerabilities.
- `npm run typecheck && npm run lint && npm run format:check` exited 0.
- `npx vitest run tests/store-queue.test.ts` passed all 12 tests.
- `npx vitest run tests/store-queue.test.ts tests/store-migrations.test.ts` passed all 22 tests, including the prior database schema check.
- A Bun 1.4.5 smoke run exercised queue admission, retry, claim, and crash recovery through `Store`.

The HTTP tests register the queue routes on Fastify with production authentication, visibility, and error handling. The Phase 1 merge owns production registration, dispatch, and version bumps for events outside the queue.
