# November 10 a refused session no longer strands the browser's push subscription under the member who left

Branch `t3/refused-session-push` over `origin/main` at `b41cc54`, on NicolasLaptop (Fedora 44, Linux x64), Node 24.22.2 after a
real `npm ci`, ruff 0.17.3. Server and tests only; no client file changed. Line numbers are this branch's.

## Defect

When the server refuses a session (a lapsed or revoked cookie), `accountRefused` in `src/app/account-epoch.ts` closes the
notifications on screen and tells the worker nobody is signed in, and keeps the browser's push subscription. The server still holds
that subscription under the refused member, so it keeps sending that member's pushes to the browser. The worker drops them, but a
browser may show a generic "site updated in the background" notice for a push that shows nothing. The next member to sign in there
is stuck as well: `NotificationRepository.subscribe` answered 409 "belongs to another household member. Remove it from that session"
for the endpoint, a session that cannot be reached, so their Settings said "Turn on" and the button failed.

## Decision

Fix it on the server, at the next member's subscribe, and do nothing at the refusal itself.

- Ending the subscription in the browser at the refusal was ruled out: the same member signing back in finds notifications off and
  must turn them on in Settings, for every lapsed session. A lapsed cookie is the common case, so that is a regression.
- Doing something at the refusal on the server was ruled out: a refused request carries no session, so the server cannot tell who it
  was, and acting on an endpoint named by an unauthenticated request would let anyone silence a member.
- Dropping a member's web subscriptions when their session lapses was ruled out: a member who has not opened the app for weeks has
  no refusal, and their worker still shows their pushes. Suppressing those would be a regression too.
- `subscribe` (`src/server/store-notifications.ts:211`) moves the endpoint to the member who presents it, when the request carries
  the stored subscription's own `p256dh` and `auth`. One endpoint is one browser profile, which has one cookie jar, so a member
  authenticated there makes the browser theirs. The upsert now writes `user_id` too (it kept the first holder before), and
  `attachSubscriptionDevice` then replaces or deletes the previous holder's device label as before. The previous member has no row
  for the endpoint from that moment.
- The keys are the proof. Only the browser that made a subscription knows its keys, and the API never returns them or an endpoint to
  anyone. A request with an endpoint and different keys still answers 409, so a member who learns an endpoint cannot silence another's
  browser. `sameKeys` (line 17) compares both values in constant time and treats a different length as different.
- Delivery rechecks the holder. `deliver` reads a member's subscriptions, then sends to each endpoint in turn, and each send awaits,
  so a takeover can land between the read and a later send. `attempt` (`src/server/notifications.ts:333`) now asks the store whether
  the member still holds the endpoint just before the send, with no await between the check and the call, and records `dead:<endpoint>`
  when not, as for a push service's 410. The push reached the member's other endpoints; the taken one is never sent. The `drop` of a dead
  target is scoped to the member, so it cannot remove the new holder's row.
- What stays: until the next member signs in there, the same member returns, or the push service answers 410, the server keeps sending the
  refused member's pushes to the browser and the worker drops them (the account marker, `scripts/service-worker.js`). That is the cost
  of not turning notifications off at every lapsed session. A returning member finds them still on.

## Tests

`tests/push-status-api.test.ts` runs the real Fastify app with the in-memory store and a fake runtime that throws on any call the
test did not configure. `tests/notifications.test.ts` runs the real `BackgroundWorker` over the in-memory store with a fake sender.

- Takeover: member one subscribes with a device label, member two subscribes with the same endpoint and keys and another label: 200;
  the row and the label are two's, one's status reads unregistered, and one subscribing back takes it back, with no label for a client
  that names none.
- Rejection, each for its own reason, all 409 with the endpoint, keys and label still the holder's: a different `p256dh`, a different
  `auth` of another length, a different `auth` of the same length, an `auth` that is a prefix of the stored one (a missing length check
  would throw in `timingSafeEqual`).
- Other guards: no session 401, no CSRF token 403, an `http` endpoint 400, no keys 400, an empty `auth` 400, and a body that names
  `userId: "one"` changes nothing for the signed-in member two.
- A member refreshing their own subscription with new keys updates the stored keys, and the old keys then no longer move it.
- Delivery: a push for one member goes to their other endpoint and not to the one two took, and a push for two goes to it; a push for one
  already in flight when two takes its second endpoint is sent to the first and never to the second, and is recorded `dead:`.

### Red runs

Each protecting line broken by hand, the file restored. The runner is a scratch script that applies one replacement, runs
`tests/push-status-api.test.ts` and `tests/notifications.test.ts`, and restores the file.

| Mutation | Result |
| --- | --- |
| Any other member's endpoint refused, as before | failed: the takeover, the body-identity and both delivery tests (4) |
| No key proof, any member takes any endpoint | failed: the four refusal tests (4) |
| Upsert without `user_id=excluded.user_id` | failed: the takeover, the body-identity and both delivery tests (4) |
| `p256dh` not compared | failed: the different-`p256dh` refusal |
| `auth` not compared | failed: the two `auth` refusals |
| The length check in `sameKeys` removed | failed: the four refusal tests, which now throw |
| `timingSafeEqual` replaced by `true` | failed: the same-length `auth` refusal (added for this) |
| `timingSafeEqual` replaced by `a === b` | survived: equivalent |
| No `held` check before a send | failed: the in-flight takeover test |
| The taken endpoint not recorded `dead:` | failed: the in-flight takeover test |

The first run of the same-length mutation survived; the same-length `auth` case was added and it went red.

## Checks

`npm run typecheck`, `npm run lint`, `ruff check .` pass. `npm test`: 202 files, 3,526 tests. `npm run build` passes. `npm run test:e2e`:
38 passed.

## Not exercised

A real browser's push service: the endpoint and keys are fixtures, and no push left this machine. A real lapsed session in a browser
was not driven; the server tests stand in for the browser's second member with a second signed-in fixture. The native iOS routes
(`src/server/store-devices.ts`) have the same "Sign out there first" 409 for their own tokens and are not changed here.
