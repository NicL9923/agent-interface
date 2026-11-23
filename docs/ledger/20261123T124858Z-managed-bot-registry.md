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
