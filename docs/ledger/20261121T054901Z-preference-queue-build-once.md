# November 21 preference queue builds each patch once

Code state: the working tree on top of `bae99356` on `t3/partial-preference-saves`. Node v24.22.2.
Hermes did not take part. Earlier entries:
[`20261121T021708Z-partial-preference-saves.md`](20261121T021708Z-partial-preference-saves.md) and
[`20261121T051050Z-partial-preference-saves-review.md`](20261121T051050Z-partial-preference-saves-review.md).

A second review found four regressions in the queue from `bae99356`, which ran each edit when its
save's turn came, on whatever the server had answered by then. An edit such as "move Ranch Hand to
B", "append ranch" or "move B up" gave a different result on a base the person never saw:

1. A refused section creation made the next save take Ranch Hand out of its section.
2. A lost answer made the next save erase a change the server had committed.
3. A pin queued behind another save could double another client's same pin.
4. A queued reorder could swap a different pair from the one the person saw.

`src/app/preference-queue.ts` now runs each edit once, when the person taps, on the preferences the
server last confirmed with the patches still waiting laid over them. The save sends that patch as
built. Each answer becomes the confirmed copy and goes on screen with the waiting patches laid over
it; a refused save's patch leaves the overlay, and the patches behind it still go out. One existing
assertion changed with that rule: the first answer in the "one save at a time" test now shows with
the waiting pin laid over it. The `bae99356` test "does not carry a refused save's change into the
edit queued behind it" described the rejected design and is replaced by one that checks the save
behind a refusal goes out as built.

The review's fifth finding narrowed the guide: `PATCH /api/preferences` is the one route that
accepts `application/merge-patch+json`, and the guide no longer promises a status elsewhere.

## Checks

| Check                                                              | Result                                |
| ------------------------------------------------------------------ | ------------------------------------- |
| `npm run typecheck`, `npm run lint`                                | Compiled and passed                   |
| `npx vitest run`, full                                             | Unit-passed: 4,222 tests in 231 files |
| `e2e/preference-saves.spec.ts`, Chromium, after `npm run build`    | Runtime-exercised, 1 passed           |
| `e2e/preference-saves.spec.ts`, WebKit in the Playwright container | Runtime-exercised, 1 passed           |

### Red runs

Six new tests were written first and failed on the queue at `bae99356`, each for the reported
reason. The three in `tests/preference-queue-server.test.ts` run the real queue against the real
Fastify app:

| Test                                                                                 | Failure on `bae99356`                            |
| ------------------------------------------------------------------------------------ | ------------------------------------------------ |
| never takes an assistant out of its section when the section it moved to was refused | stored `{ "Around the house": [] }`              |
| creates the section with the assistant in it when only the first save failed to send | stored `{ "Around the house": [] }`, no Barn     |
| keeps a change the server committed though its answer was lost                       | stored `["Around the house", "Creek"]`, no Barn  |
| sends the save behind a refused one as it was built                                  | the screen showed `[]`, not `["creek", "ranch"]` |
| sends a pin as the list the person saw                                               | sent `["ranch", "ranch"]`                        |
| sends a reorder as the order the person saw                                          | stored `["A", "B", "C"]`, not `["B", "A", "C"]`  |

Two more tests guard behavior `bae99356` already had, so each was broken by hand on the new queue
instead. Every break below was applied by a script that replaced one exact string, ran
`tests/preference-queue.test.ts` and `tests/preference-queue-server.test.ts`, and wrote the original
bytes back.

| Break                                            | Result                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| Ignore the fields a control names                | 1 failed: the named pick equal to another device's value                 |
| Show an answer without the patches still waiting | 1 failed: one save at a time                                             |
| Leave the screen alone after a refusal           | 2 failed                                                                 |
| Build an edit on the confirmed copy alone        | 6 failed, the three real-server cases among them                         |
| Keep a refused patch in the overlay              | 2 failed: the retry after a refusal, and the failed save then a new edit |
