# November 21 partial preference saves, review fixes

Code state: the working tree on top of `0d9b921d` on `t3/partial-preference-saves`. Node v24.22.2.
Hermes did not take part. The first entry is
[`20261121T021708Z-partial-preference-saves.md`](20261121T021708Z-partial-preference-saves.md).

An independent review found seven problems. Each one was checked against the code first, and each
held.

1. Turning off quiet hours could leave them on. The queue nulled only the keys its older copy held,
   and a copy from before another device turned them on held neither. `patchFor` now sends `null`
   for every clearable key a named object field lacks, listed in `CLEARABLE_KEYS`, with a type check
   that fails if the patch type gains a clearable key the list misses.
2. A waiting save's older copy could erase a pin already on screen. The queue built each edit on the
   newest queued whole object. It now runs each edit when its turn to send comes, on what the server
   answered to the save before it, so the edit starts from what the person sees and a refused save's
   change is not carried into the edits behind it.
3. A whole save's 400 listed fewer fields than before, because the partial schema read the body
   first. The route's `before` step now validates a whole body with the original schema. The test
   pins the bodies the server at `af8d1c38` answered, captured by running that commit.
4. The guide now says the 415 fallback has the old stale-write window between its read and its
   write.
5. The guide now says a whole save replaces model favorites it sends and keeps `mainBotId` and
   `checkIns`, and the test asserts the model favorites.
6. The parser tests now check each refusal's code: an empty body, `{`, a `__proto__` key and a
   `constructor.prototype` key.
7. The guide now says an unknown key inside a `hiddenRoutineRuns` entry is a 400, and that a
   merge patch body on another route is a 415, or a 413 over the body limit.

## Checks

| Check                                                              | Result                                |
| ------------------------------------------------------------------ | ------------------------------------- |
| `npm run typecheck`, `npm run lint`                                | Compiled and passed                   |
| `npx vitest run`, full                                             | Unit-passed: 4,215 tests in 230 files |
| `e2e/preference-saves.spec.ts`, Chromium, after `npm run build`    | Runtime-exercised, 1 passed           |
| `e2e/preference-saves.spec.ts`, WebKit in the Playwright container | Runtime-exercised, 1 passed           |

### Red runs

The four new queue tests ran against the queue at `0d9b921d` and all four failed for the reported
reasons: the quiet hours patch held two keys instead of four, the pin patch was `["ranch"]` instead
of `["creek","ranch"]`, and the edit behind the refused save resent the refused pin.

Each line below was broken by a script that replaced one exact string, ran the test file, and wrote
the original bytes back.

| Break                                                      | Test file                             | Result                                                     |
| ---------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| Drop the whole-schema check in `before`                    | `tests/preferences-patch-api.test.ts` | 1 failed: the af8d1c38 refusal bodies                      |
| Parse merge patches with plain `JSON.parse`                | `tests/preferences-patch-api.test.ts` | 1 failed: the parser refusals                              |
| Let the parser ignore prototype keys                       | `tests/preferences-patch-api.test.ts` | 1 failed: the parser refusals                              |
| Keep the saved model favorites in a whole save             | `tests/preferences-patch-api.test.ts` | 1 failed: the routed fields test                           |
| Leave the clearable keys out of a named object field       | `tests/preference-queue.test.ts`      | 3 failed                                                   |
| Keep the screen's first copy as the base after each answer | `tests/preference-queue.test.ts`      | 3 failed, the pin on screen among them                     |
| Take an edit's base when it is queued, not when it is sent | `tests/preference-queue.test.ts`      | 2 failed: the quick second tap and the changed-back choice |
