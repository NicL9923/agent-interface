# November 9 a linked chat is read beside bootstrap

Branch `perf/linked-chat-prefetch`, from `origin/main` at `0d205eb`. Checks ran on NicolasLaptop
(Fedora, Linux x64, Node 24.22.2) at commit `3184fea`, which this entry follows. No Python, iOS or
Hermes code changed. The server change is a shared constant for the session lifetime, with the
same value.

## Change

- `src/app/linked-chat.ts`: `prefetchLinkedChat()` runs as `useSession` mounts, before the first
  bootstrap. For `/?bot=ID` it calls `prefetchFirstPage(ID)`, which the chat already joins.
- It reads only when `agent-interface:sign-in-hint` in localStorage says this browser signed in
  less than `SESSION_MAX_AGE_MS` (seven days, less a minute) ago and the last connected bootstrap
  listed the chat. Sign-in writes the record, each connected bootstrap updates its chat IDs, and a
  401 bootstrap or a sign-out removes it.
- A link with `message=`, `view=today` or any other view waits for bootstrap as before.
- `prefetchedFirstPage` also returns a read that finished less than five seconds ago, so a chat
  opened after its prefetch finished does not read twice.

## Application tests

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/linked-chat-ui.test.ts tests/conversation-prefetch.test.ts`: 2 files,
  25 tests passed.
- `npm test`: 171 files, 2,571 tests passed.
- `npm run build` passed, including the precache-plan guards, then `npm run test:e2e`: 4 Chromium
  tests passed, including the new link case.

## Mutants

Each line was broken by hand, the focused tests run, and the source restored.

| Mutation | Result |
| --- | --- |
| `prefetchLinkedChat()` call removed from `useSession` | failed: "reads the chat while bootstrap is on its way…", "drops a read for a chat the person can no longer see…" |
| Chat-list guard removed | failed: signed-out case and 6 "waits for bootstrap" cases |
| Lapse check removed | failed: "waits for bootstrap with a sign-in that has lapsed" |
| `Array.isArray(bots)` check removed | failed: "…whose chats are not a list of IDs" |
| `typeof until` check removed | failed: "…a lapse time that is not a number" |
| Message-link guard removed | failed: "opens a message link at that message…", "…a link to a message…" |
| View guard removed | failed: "…a link to Today" |
| `forgetSignIn()` on a 401 removed | failed: "starts at sign-in, learns the chats…" |
| `forgetSignIn()` on sign-out removed | failed: "is forgotten when the person signs out" |
| `rememberSignIn()` removed | failed: "starts at sign-in, learns the chats…" |
| Connected check on the chat-list write removed | failed: "starts at sign-in, learns the chats…" |
| Lifetime not from `SESSION_MAX_AGE_MS` | failed: "starts at sign-in, learns the chats…" |
| A finished read not joinable | failed: "opened 4999ms after a prefetch finished…", "reads the chat while bootstrap is on its way…" |
| Freshness boundary `<` changed to `<=` | failed: "opened 5000ms after a prefetch finished…" |
| e2e: `prefetchLinkedChat()` removed, rebuilt | failed: "a link to a chat…" at `expect(heldUntil[0]).toBe(true)`, received `false` |

One mutant survived the first pass: removing the check that each listed chat is a string. A
non-string entry never equals a chat ID, so the check was dead. It was removed with its test case.

## Not exercised

- No browser use beyond the Playwright suite. No real phone or notification tap.
- A browser signed in before this release has no record, so it waits for bootstrap until its next
  sign-in, at most seven days.
- A session the server ends early, such as an account removed from the household, still has a
  record until the next 401. That load logs one refused chat read. A chat made private since the
  last bootstrap logs one 404 the same way; the app shows its existing notice and opens the main
  assistant.

## November 9 review round

GPT-6.1 Sol reviewed the branch at `bd6def6`. This round merged `origin/main` at `da00a26`
(merge commit `9e3f851`) and changed the code at `d7d2bcd`. Checks ran on
NicolasLaptop (Fedora, Linux x64, Node 24.22.2).

### Findings and changes

- P1, a prefetch made as another account. The record now holds the account ID, written by the
  first connected bootstrap after sign-in; a record without one starts no read. The read is
  tagged with that account. `settleLinkedChat()` runs on every bootstrap before anything else in
  `refresh()`, so before the chat can open: a different account drops the read and clears the
  response cache, and the chat reads again. A `storage` event that removes the record or names
  another account drops the read the same way. A bootstrap that names another account than the
  record also drops the record.
- P2, an empty prefetched chat. `use-conversation.ts` lets only the chat's first load join a
  prefetch. The stream's connection read, every notice, reconnect and poll ask the server.
- README: names the two cases that still cost one refused read.
- `tests/linked-chat-ui.test.ts` no longer mocks presence, device activity or `Avatar`. It runs
  the real client API against a fetch fake that records and refuses any request the test did
  not configure, and fails the test on one. jsdom's missing SVG geometry and
  `IntersectionObserver` are stubbed as other suites do.

### Red before the fix

On `bd6def6` plus the new tests, before each fix:

- `npx vitest run tests/conversation-prefetch.test.ts -t "empty prefetch"`: failed, "expected
  [ Array(1) ] to have a length of 2 but got 1" at the stream's connection read.
- `npx vitest run tests/linked-chat-ui.test.ts`: 8 failed. Both "never shows a read made as
  another account" cases failed with "expected 'One's private draft' not to contain 'One's
  private draft'"; both "drops its read when another tab…" cases failed the same way with "Read
  before the switch"; the two new record guards and the two record-content tests failed on the
  missing account field.

### Mutants

Each line was broken by hand, the two focused files run, and the source restored.

| Mutation | Result |
| --- | --- |
| `settleLinkedChat()` call removed from `refresh()` | failed: both "never shows a read made as another account" |
| A mismatched account settles without dropping | failed: the same two |
| `storage` listener not added | failed: both "drops its read when another tab…" |
| Any record change drops the read | failed: "keeps its read when another tab changes the same account's chat list" |
| Storage key filter removed | failed: "keeps its read when another tab changes something other than the sign-in" |
| A record without an account prefetches | failed: "waits for bootstrap with a sign-in whose account no bootstrap has named yet" |
| Account type check removed | failed: "waits for bootstrap with an account that is not an ID" |
| Another account's record kept | failed: "is forgotten when bootstrap names an account other than the one it recorded" |
| Account not recorded | failed: "starts at sign-in, learns the account and chats…" |
| A drop does not clear the response cache | failed: 4 drop cases |
| Every load may join the prefetch | failed: "reads fresh for the stream's connection and each notice after an empty prefetch" |
| No load may join the prefetch | failed: 6 cases |

### Checks

- `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/linked-chat-ui.test.ts tests/conversation-prefetch.test.ts`: 2 files, 35
  tests passed.
- `npm test`: 171 files, 2,599 tests passed.
- `npm run build`, then `npm run test:e2e`: 4 Chromium tests passed.

### Not exercised

- Two real browser tabs switching accounts. The interleaving runs in jsdom with the real client
  API and a fake server.
- Safari, Firefox and an installed iOS web app: not run.
- A false match needs the cookie to change from A to B, then back, between this page reading the
  record and bootstrap leaving, with no storage event in between. Not tested; it needs two
  sign-ins inside one round trip.

## November 10 second review round

GPT-6.1 Sol's second review verified one finding at `da60ee9`. This round merged `origin/main` at
`2d461e3` (merge commit `21cb37f`) and then changed the code. Checks ran on NicolasLaptop (Fedora,
Linux x64, Node 24.22.2).

### Finding and change

- P2, returning to a chat could show a page from before a send. A finished prefetch stayed
  joinable for five seconds whatever happened after it, so a chat prefetched empty, opened, sent
  to and left could come back to the empty page until another read landed.
- `supersedePrefetch(botId)` in `src/app/conversation-page.ts` is the one rule: a prefetched page
  stops being usable the moment anything newer exists for its chat. A send, or any transcript read
  of the chat that completes, drops every prefetch of it begun before, finished or still on its
  way. One still on its way is aborted, so its older page never lands in the response cache over
  the newer read, and a first load that joined it reads again.
- The send path calls it through `sendMessage()`, which every `POST /bots/:id/messages` in the
  client now uses: the composer's send and retry, a turn retry and a form reply. The chat's read
  path calls it after each read it makes itself in `use-conversation.ts`, and the secure request
  card after its own read of the chat.
- README: the linked chat paragraph says a send or a finished read retires an earlier prefetch.

### Choices

- Approvals, clarify answers and Stop do not supersede a prefetch. They are not sends; the approval
  card keeps its own saved decision, and the next read retires the prefetch as before.
- An aborted prefetch rather than only a dropped entry: without the abort, the older read still
  wrote the response cache, which the chat shows first on its next open.

### Red before the fix

On `21cb37f` plus the new tests, with the source change reverted:

- `npx vitest run tests/conversation-prefetch.test.ts tests/linked-chat-ui.test.ts`: 2 failed.
  "shows the person's message on return… after the chat read the transcript that holds it" failed
  at the return with "expected 'Start with Ranch Hand's role…' to contain 'Shut the north gate'".
  "drops a prefetch still on its way when a newer read of the chat completes" failed with
  "expected Promise{…} to be undefined".

### Mutants

Each line was broken by hand, the two focused files run, and the source restored.

| Mutation | Result |
| --- | --- |
| `sendMessage()` does not call the rule | failed: "…when the person left before any read landed" |
| The chat's read path does not call the rule | failed: "drops a prefetch still on its way…" |
| The rule does not abort a prefetch on its way | failed: "drops a prefetch still on its way…", at the response cache |
| The rule keeps a finished prefetch | failed: both "shows the person's message on return…" cases |
| The rule keeps the entry of a prefetch on its way | survived |
| A finished prefetch stored without checking it is still current | survived |

The two survivors cover the same window: a prefetch whose response was already read when the rule
runs, so the abort comes too late and its `then` has not run yet. Every test aborts before the
response arrives, so the abort alone settles the read. Both stay as the guard for that window;
holding the order of two settled reads to one microtask is not something the fakes can set.

### Checks

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/conversation-prefetch.test.ts tests/linked-chat-ui.test.ts
  tests/submission-state-ui.test.ts tests/draft-sync-ui.test.ts`: 4 files, 57 tests passed.
- `npm test`: 172 files, 2,678 tests passed.
- `npm run build`, then `npm run test:e2e`: 4 Chromium tests passed.

### Not exercised

- Safari, Firefox and an installed iOS web app: not run.

## November 10 third review round

GPT-6.1 Sol's third review verified two findings at `32b9bd0`. No merge from `origin/main` this
round. Checks ran on NicolasLaptop (Fedora, Linux x64, Node 24.22.2).

### Findings and changes

- P2, Live Talk skipped the rule. A spoken request goes to `POST /bots/:id/talk/ask`, which the
  server submits like a typed message, but never called `supersedePrefetch()`. `use-talk.ts` now
  calls it in the `ask` callback before the request leaves; the payload and abort signal are
  unchanged.
- P2, an older read's body could overwrite a newer cached one. Two reads of the same path both
  awaiting their bodies, the newer one's ending first and the older one's in the same turn, both
  wrote the response cache before the newer read's caller could abort the prefetch. `api()` in
  `src/client-api.ts` now numbers each request as it starts, and each cache entry keeps the number
  of the read that last vouched for its body. `remember()` refuses a body from a read that started
  before the one the entry holds. The rule knows nothing about prefetching.
- The cache cases it touches: a 304 answered from memory, and a 200 whose text matches the cached
  body, both vouch for the body as of their own start, so each re-stores the entry with its own
  number and returns the same object as before. The 304 path no longer checks that the entry is
  still the one it started with; the order rule decides instead, so a later-started 304 now
  restores its body over an earlier-started read that landed first. Sign-out still clears every
  entry and bumps the scope, so an in-flight read writes nothing. The count and size limits run
  after the order check, unchanged.
- README: the linked chat paragraph names Live Talk and the cache order rule.

### Other requests that submit to a chat

| Request | Caller | Result |
| --- | --- | --- |
| `POST /bots/:id/messages` | `sendMessage()`: composer send and retry, turn retry, form reply | already covered |
| `POST /bots/:id/talk/ask` | `use-talk.ts` | fixed this round |
| `POST /bots/:id/steer` | no web caller; the composer steers through `/messages` | nothing to change |
| `POST /bots/:id/requests/:approvalId` | clarify answers in `AttentionCard.tsx` | left as decided last round: not a send |
| `POST /bots/:id/approvals/:approvalId`, `POST /push/actions` | approval cards, the worker's notification actions | left: not a send; the worker has no page state |
| `POST /bots/:id/stop` | Stop | left: not a send |
| `POST /routines/:id/run` | "Try once" in `RoutineEnhancements.tsx` | left: the run's output arrives later as a delivery, like any reply, so retiring at start would not cover it; the change stream reads it |
| `POST /bots/:id/automation/goal/resume`, `.../tasks/:taskId/actions` | `AutomationPanel.tsx` | left: same as a routine run |
| `POST /groups/:id/messages` | `GroupChats.tsx` | not a prefetched path; only `/bots/:id/conversation` is prefetched |
| Main assistant's Ask | `CommandPalette.tsx` | puts text in a draft; sends nothing |

### Red before the fix

On `32b9bd0` plus the new tests, with the source change reverted:

- `npx vitest run tests/client-api.test.ts`: 8 failed. Five of the six finishing orders of three
  overlapping reads failed, for example order 2, 1, 0 with "expected 1 to be 2"; order 0, 1, 2
  passes on both. A later-started 304 in both orders and a later-started same body landing first
  failed, for example "expected { day: 'older' } to be { day: 'kept' }".
- `npx vitest run tests/conversation-prefetch.test.ts`: "keeps the newer read's page cached when an
  older prefetch's body ends just after it", built on real `Response` bodies from
  `ReadableStream`, failed with "expected 'Older' to be 'Newer'".
- `npx vitest run tests/talk-ui.test.ts` with the Talk call removed: "retires the chat's
  prefetched page before a spoken request leaves" failed with "expected Promise{…} to be
  undefined".

### Mutants

Each line was broken by hand, the focused file run, and the source restored.

| Mutation | Result |
| --- | --- |
| Order check in `remember()` removed | failed: 5 finishing orders, both "…finishing in the order [ 2, 1 ]" |
| 304 keeps the old identity check beside the order rule | failed: "…answered with a 304 confirmed, finishing in the order [ 1, 2 ]" |
| 304 re-stores the entry with its old number | failed: both 304 cases |
| Same body re-stores the entry with its old number | failed: both same-body cases |
| Talk does not call the rule | failed: "retires the chat's prefetched page before a spoken request leaves" |
| A finished prefetch stored without checking it is still current | failed: "keeps the newer read's page cached…", at `prefetchedFirstPage` |
| The rule keeps the entry of a prefetch on its way | failed: the same test |

The last two were the survivors of the second round. The new test holds two settled bodies to one
turn with real streams, which the second round's fakes could not.

### Checks

- `npm ci`, `npm run typecheck` and `npm run lint` passed.
- `npx vitest run tests/client-api.test.ts tests/conversation-prefetch.test.ts
  tests/talk-ui.test.ts tests/linked-chat-ui.test.ts`: 4 files, 75 tests passed.
- `npm test`: 172 files, 2,690 tests passed.
- `npm run build`, then `npm run test:e2e`: 4 Chromium tests passed.

### Not exercised

- A real Live Talk call; the test drives the data channel with a fake peer.
- Safari, Firefox and an installed iOS web app: not run.
