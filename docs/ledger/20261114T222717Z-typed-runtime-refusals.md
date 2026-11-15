# November 14 typed runtime refusals

Branch `t3/typed-runtime-refusals`, written over `65ed9eb4` and rebased onto `origin/main` `fa0243ee` (which brought
#396's request log into `http-error.ts`), on the Mac mini (macOS, arm64), Node 24.22.2, Python 3.14.7.
No Hermes took part and nothing was deployed by this entry.

## Why

The error handler answered every error without a `statusCode` with 502 and "The Hermes operation could not be
completed", and logged it as "Request failed". The Hermes adapter threw plain errors for refusals the person can act
on, such as a stale approval, an avatar changed on another client or a name of only emoji, so those reached people
as the generic 502 and buried real failures in the error log. A bad or stale `/api/files/:id` was a 502 too.

Two members approving one shared request at once both passed the app's pending check, both reached Hermes, and the
second's attribution hit the primary key of `approval_attribution`: a 502 either way.

## Change

`RuntimeRefusal` in `src/shared/errors.ts`, with `InvalidInput` (400), `NotFound` (404) and `Conflict` (409), is
the refusal every runtime adapter throws. It carries `statusCode`, so the error handler sends its message and code
and does not log it. The user-facing throws in `src/server/hermes.ts` and `src/server/hermes-files.ts` use it;
upstream failures stay plain errors and 5xx. `POST /api/bots` refuses a name that makes no ID with 400
`assistant_name_invalid` before Hermes is asked. `decideApproval` claims the approval before it awaits anything, so
a second decision at the same moment is refused with 409 `request_not_pending`, and the claim is released when the
first settles. Attribution keeps the first decision on a conflict instead of throwing.

The roster loop in `bot-routes.ts` matched a deleted bot by the text "Unknown Hermes bot."; it now matches
`NotFound` with `assistant_not_found`.

## Red runs

Each line was broken by hand in the working tree, the named test run alone, and the file restored byte for byte
(checked by SHA-256). Every test went red.

| Mutation | Test | Result |
| --- | --- | --- |
| `hermes-files.ts` unsigned ID throws a plain `Error` | answers a file ID this server did not issue with 404 | failed |
| `bot-routes.ts` empty-ID guard removed | refuses a new assistant whose name makes no ID | failed |
| `conversation-routes.ts` claim check removed | sends only the first decision to Hermes | failed |
| `conversation-routes.ts` claim never released | lets the approval be decided again after a decision Hermes failed | failed |
| `store-submissions.ts` `ON CONFLICT DO NOTHING` removed | keeps the first decision recorded | failed |
| `hermes.ts` expired approval throws a plain `Error` | answers an approval Hermes no longer has open with 409 | failed |
| `hermes.ts` saveBot empty-ID guard removed | refuses a new profile whose name makes no ID | failed |
| `hermes.ts` botDetail missing profile throws a plain `Error` | reports a profile deleted since the roster read | failed |
| `bot-routes.ts` deleted bot matched by message again | drops a bot deleted between reads (both routes) | failed |
| `Artifacts.tsx` 404 branch removed | reports text download failures | failed |

## Checks

`.agents/tools/check-all --keep-going` on the rebased commit:

| check | result | counts |
| --- | --- | --- |
| typecheck, lint, ruff, build | pass | 894 modules |
| test | 3 failed of 3,912 | all three need the `127.0.0.2` loopback alias (`EADDRNOTAVAIL`): two in `direct-routes`, one in `native-contract` |
| e2e | 1 failed of 55, then 55 of 55 | the failure was the live reply across a tool call timing out at 5 s while the run waited 23 minutes for heavy slots; `check-all --only e2e` passed |
| py | 3 failed of 52 files | `deploy_common`, `mutate_py` and `release_app` fail the same way on a clean `origin/main` `fa0243ee`: macOS `/private/var` paths and Linux process facts. No Python changed |

Application tests use the real Fastify app with the in-memory store, and either a fake runtime or the real Hermes
adapter over a fake socket and `fetch`. Since #396, a refusal is logged once at warn level as "Request answered with
an error status" and no longer at error level as "Request failed". Not exercised: real Hermes, the iOS app (no Swift
changed; its status handling was read, not run), and browsers other than the e2e smoke suite's Chromium.

## Review fix

GPT-6.1 Sol's review found that a second member deciding an approval while the first member's decision was in flight
got 409 `request_not_pending` at once. If the first then failed, the approval stayed pending, but the web approval card
had saved the second member's attempt as closed and hid its controls. Now the second decision waits for the first to
settle and reads the approval again: it is refused if the first was recorded and sent if the first failed, so a 409
always means closed.

Both race tests now wait until the second request has passed the route's capability check before the first is
released or failed. Without that wait, both mutants below passed, because the second request reached the decision only
after the first had settled.

| Break | Test | Failure |
| --- | --- | --- |
| Refuse a second decision at once while one is in flight | `sends the waiting member's decision when the first one fails, instead of telling them it closed` | 1 failed |
| Never record the in-flight decision, so both reach Hermes | `sends only the first decision to Hermes, records it, and refuses the second once the first is recorded` | 1 failed |

`tests/runtime-refusals-api.test.ts` passed 6 of 6 after each restore, and three more times in a row.
