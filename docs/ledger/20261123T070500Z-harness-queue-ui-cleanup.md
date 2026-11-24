# November 23 harness picker, message queue and legacy UI cleanup

Code state: the working tree on top of `320740c3` on `t3/harness-queue-ui-cleanup`, committed as
this entry's commit. Node v24. Hermes did not take part. The server routes for harnesses and the
queue are built in parallel, so every web check runs against fakes at `fetch` or the mocked client
API, and the client contract is in [native API](../native-api.md#harnesses-and-the-message-queue).

## Checks

| Check                                                                      | Result                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`, `npm run lint`, `npm run format:check`                | Compiled and passed                                                                                                                                                                                                                                  |
| `npm run build`                                                            | Built                                                                                                                                                                                                                                                |
| 15 affected Vitest files, including the new `tests/queue-panel-ui.test.ts` | Unit-passed: 386 tests                                                                                                                                                                                                                               |
| Full Vitest suite under `linux-heavy-lock.sh`                              | Unit-passed: 232 files, 4,238 tests. The first run failed 2: `hermes-qualification` wanted `src/shared/queue.ts` listed as an input, and `keystroke-delta-work` saw one extra commit from the hidden queue panel's hooks; both fixed before this run |
| Swift and the iOS project                                                  | Not run: this Linux host cannot run `xcodebuild`. Reviewed by inspection; the project was regenerated with `ios/tools/generate-project.py`                                                                                                           |

## Red runs

Each mutant below broke one guarded line, ran the named file, and restored the file byte for byte.
Every one went red.

| Mutant                                                       | Test file that failed     |
| ------------------------------------------------------------ | ------------------------- |
| Move down names the next message instead of the one after it | `queue-panel-ui`, 2 tests |
| The queue shows for a Hermes bot                             | `queue-panel-ui`, 2 tests |
| A 409 does not read the queue again                          | `queue-panel-ui`          |
| The queue polls while idle and empty                         | `queue-panel-ui`          |
| A turn starting does not read the queue                      | `queue-panel-ui`          |
| The bot's own capability is ignored for the bootstrap's      | `queue-panel-ui`, 2 tests |
| Save is allowed for an unchanged or blank edit               | `queue-panel-ui`          |
| PATCH always sends the harness                               | `bot-settings`            |
| Hermes is always offered                                     | `bot-settings`            |
| Simple view always shows the harness picker                  | `bot-settings`            |
| Hermes updates always show                                   | `preferences-dialog-ui`   |
| Hermes updates ignore servers from before harnesses          | `preferences-dialog-ui`   |
| Hermes updates ignore an unknown roster                      | `preferences-dialog-ui`   |
| Hermes updates ignore a bot still on Hermes                  | `preferences-dialog-ui`   |

## Not exercised

- The iOS build, unit tests and UI tests. The Mac mini needs to run them for this commit.
- Any real harness server: the queue routes and `harness` on bot saves have no server yet.
