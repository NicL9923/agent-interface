# November 23 direct voice and native group chats

Code state: `sha256:e71f7b2a05bfebecb397822108d9a0a09debc1701c8eff156f59822947650f7e`
on top of `2ee7ec9a`, recorded by `.agents/tools/source-state.py`. The checks ran on Node
24.22.2 with SQLite 3.53.4.

- `npm run typecheck && npm run lint && npm run format:check` passed.
- `npx vitest run tests/direct-voice-groups.test.ts` passed, 21 tests. The voice tests call a
  loopback HTTP server that stands in for OpenAI and fails the test on any route it was not
  given. The group tests use an in-memory `StoreDatabase` with the real `ManagedBotRepository`.
- `npx vitest run tests/direct-voice-groups.test.ts tests/store*.test.ts` passed five times
  in a row, 99 tests. The first run of that pair failed once: two rooms made in the same
  millisecond listed by ID. Rooms now list by creation time, then insertion order.
- `.agents/tools/check-all --keep-going` under `linux-heavy-lock.sh`: typecheck, lint, ruff,
  test (244 files, 4486 tests), build and py passed. e2e failed 142 of 284: every failure is the
  WebKit project, whose browser cannot launch because NicolasLaptop lacks its system libraries
  (`playwright install-deps`). Chromium passed all 142. Runs from two other worktrees today show
  the same 142 WebKit failures, so this is baseline, not this change.

Each mutation below made the named test fail, run on its own after the ordering fix. The original
sources were restored before the repository check.

| Mutation                                               | Test that failed                                         |
| ------------------------------------------------------ | -------------------------------------------------------- |
| Let the turn cap allow one more turn (`>` for `>=`)    | hands off between bots by mention and stops at the cap   |
| Let a bot hand off to itself                           | hands off between bots by mention and stops at the cap   |
| Count a shared bot as single-user                      | refuses a subscription-backed personal bot               |
| Accept a thread reply as a thread root                 | keeps thread replies and their context inside the thread |
| Keep duplicate mentions                                | parses @id and @name mentions                            |
| Skip the check that the sender can see every assistant | refuses a message from someone who cannot see            |
| Drop the missing-key guard                             | reports unavailable without a key                        |
| Accept a client secret with whitespace or no expiry    | accepts a secret nested under client_secret              |
| Map OpenAI's 429 like any other failure                | maps OpenAI failures to fixed sentences                  |

One mutant survived: removing the `signal.aborted` check after a turn resolves. `abortable()` already
rejects a turn the moment the room stops, so that check only covers a turn that resolves and a stop
that lands before the coordinator's next microtask. It stays as a guard for that race.
