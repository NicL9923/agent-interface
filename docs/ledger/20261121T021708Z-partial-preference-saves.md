# November 21 partial preference saves

Code state: the working tree on top of `af8d1c38` on `t3/partial-preference-saves`. Node
v24.22.2. Hermes did not take part; server tests run the real Fastify app with the in-memory
store, and UI tests mock only the client API module.

A client saved its whole `Preferences` object, so a tab or phone holding an older copy wrote its old
theme, pins, sections and the rest back over a newer save from another device. The chat style
changes fixed that for `chatStyle` and `ownBubble` only.

`PATCH /api/preferences` now reads a body sent as `application/merge-patch+json` as a partial save
(RFC 7396): a field left out keeps its saved value, and `null` clears the optional fields. A body
sent as `application/json` follows the whole-object rule it always did, so released iOS builds and
tabs loaded before a deploy store exactly what they stored before. The merge patch parser answers
415 on every other route. The web client's preference queue sends only the fields an edit set: each
caller names them, and the queue adds any field that differs from the value the edit was made on.
`request()` sends this route with the merge patch media type, and a 415 from a server that predates
it sends the save whole, built on a copy read after the refusal. `docs/native-api.md` has the
contract under "Saving preferences".

The server at `af8d1c38` was asked directly: a merge patch body, with and without `charset=utf-8`,
answered `415 {"error":"Unsupported Media Type","code":"FST_ERR_CTP_INVALID_MEDIA_TYPE"}`, and the
stored preferences did not change.

Four UI test files answered a mocked save with the body they were sent, which no longer describes
the server once a save is partial. `tests/helpers/preference-server.ts` merges each save over what
the last one stored, as the server does, and those mocks use it. Two queue tests changed shape for
the same reason: the failed-save test now checks the next save carries only the confirmed pin plus
the new one, and the account-change test appends to the base so building on the wrong account's
value would show.

## Checks

| Check                                                              | Result                               |
| ------------------------------------------------------------------ | ------------------------------------ |
| `npx vitest run` on the 9 touched test files                       | Unit-passed while iterating          |
| `e2e/preference-saves.spec.ts`, Chromium                           | Runtime-exercised and passed, 1 test |
| `e2e/preference-saves.spec.ts`, WebKit in the Playwright container | Runtime-exercised and passed, 1 test |
| `.agents/tools/check-all --keep-going`                             | Recorded in the next section         |

### Red runs

Each line was broken by a script that replaced one exact string, ran the named test file, and wrote
the original bytes back.

| Break                                                        | Test file                                | Result                                             |
| ------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------- |
| Treat every body as a whole save, ignoring the media type    | `tests/preferences-patch-api.test.ts`    | 5 of 9 failed                                      |
| Skip validating the merged notifications                     | `tests/preferences-patch-api.test.ts`    | 1 failed: the half quiet-hours window              |
| Let every route read a merge patch                           | `tests/preferences-patch-api.test.ts`    | 1 failed: the other-route 415                      |
| Allow `null` for `theme`                                     | `tests/preferences-patch-api.test.ts`    | 4 failed                                           |
| Drop `startPage ??=` from the whole save                     | `tests/preferences-patch-api.test.ts`    | 1 failed: the whole-save byte check                |
| Drop `mainBotId = previous.mainBotId` from the whole save    | `tests/preferences-patch-api.test.ts`    | 2 failed                                           |
| Leave a removed field out instead of sending `null`          | `tests/preference-queue.test.ts`         | 1 failed                                           |
| Send only the keys an object field still holds               | `tests/preference-queue.test.ts`         | 1 failed                                           |
| Send an undefined key inside an object as undefined          | `tests/preference-queue.test.ts`         | 2 failed                                           |
| Ignore the fields a control names                            | `tests/preference-queue.test.ts`         | 1 failed: the pick a waiting save holds            |
| Ignore a changed field the edit did not name                 | `tests/preference-queue.test.ts`         | 6 failed                                           |
| Send every field                                             | `tests/preference-queue.test.ts`         | 7 failed                                           |
| Send every field                                             | the new Settings and home pin UI tests   | both failed                                        |
| Always set `Content-Type: application/json` in `send`        | `tests/client-api.test.ts`               | 1 failed                                           |
| Same break, after `npm run build`                            | `e2e/preference-saves.spec.ts`, Chromium | failed on the content type                         |
| Fall back to a whole save on any 4xx                         | `tests/session-preferences-ui.test.ts`   | 1 failed                                           |
| Fall back with the patch alone, not merged over a fresh copy | `tests/session-preferences-ui.test.ts`   | 1 failed                                           |
| Send the fallback with the route's merge patch media type    | `tests/session-preferences-ui.test.ts`   | 1 failed                                           |
| Settings names no fields for its pickers                     | `tests/app-ui.test.ts`                   | 1 failed: the chat style pick a waiting save holds |

## check-all

The first run, on `6aad2931`, passed typecheck, lint, ruff, build and the Python tests. Vitest failed
3 of 4,209 tests, all from this change: `tests/helper-guards.test.ts` found the 415 fallback calling
`write()` for a mapped route, `tests/hermes-qualification.test.ts` found `src/shared/merge-patch.ts`
missing from the qualification inputs, and `tests/worker-opens-ui.test.ts` answered a save with the
body it was sent. The fallback now goes through `request()` with `plainJson`, the module is a
qualification input, and that mock merges. The e2e step ran 286 tests: all 143 Chromium tests
passed, and all 143 WebKit tests failed because the host lacks WebKit's system libraries. The
second run's results are in the commit that adds them below.

## Not exercised

The iOS app still sends whole objects as `application/json`, which the server reads as before. The
Swift change follows the contract in `docs/native-api.md` on the Mac mini.
