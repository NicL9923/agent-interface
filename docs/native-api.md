# Native iOS connection and authentication

The iOS app connects to the self-hosted Agent Interface application origin. Hermes
connection details, provider authentication, and APNs signing keys remain on that
server. The server requires HTTPS outside loopback development. The native app
keeps its application session in the Keychain.

The public `GET /api/auth/config` response includes `nativeAuthVersion: 1`,
`googleClientId`, and `localDevAuth`. A client must require version 1 before opening
native sign-in. Older application servers may serve their web SPA for an unknown
native route and require an update.

## Sign-in contract, version 1

1. Generate a cryptographically random base64url state of 32 to 128 characters
   and a PKCE verifier of 43 to 128 characters. Keep both only for the active login.
2. Compute `base64url(SHA256(verifier))`. Open an `ASWebAuthenticationSession` at
   `/native/sign-in?state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256`
   on the configured app origin, with callback scheme `agentinterface`.
3. The hosted page asks the person to choose a Google account. Google ID tokens
   are verified against the configured client ID, verified email, household
   allowlist, and the flow's Google nonce. An existing web session does not silently
   connect the native app. Opt-in loopback local development shows explicit local
   member buttons and follows the same handoff.
4. After sign-in the browser navigates to exactly
   `agentinterface://auth/callback?code=CODE&state=STATE`. Reject an unexpected
   callback host/path or mismatched state. Redirect URLs are fixed by the server;
   callers cannot select a callback or destination.
5. `POST /api/auth/native/exchange` with JSON
   `{ "code": "CODE", "state": "STATE", "codeVerifier": "VERIFIER" }`.
   Send neither cookies nor an Origin header. The response is
   `{ "token": "OPAQUE_SESSION", "expiresAt": "ISO8601", "user": { ... } }`.
   Store the session in the Keychain. Clear pending login state after success,
   cancellation, or failure.

The browser flow expires after five minutes; its one-time handoff code expires
after one minute. The handoff is bound to state, the PKCE challenge, and an
HttpOnly flow cookie. The database stores hashes of flow, code, and session
credentials. A session lasts seven days. While it is in use, the app renews it with
`POST /api/auth/native/renew`, an empty JSON body and its bearer token; the response
is `{ "expiresAt": "ISO8601" }`. Renewal extends the same token to seven days from
now, so push and Live Activity registrations stay attached and a lost response
cannot sign the app out. It never extends a session past 90 days after its Google
sign-in; at that limit it returns the unchanged expiry. A gone session returns 401
with `session_expired`. Exchange credentials are never
accepted in query parameters; session credentials never appear in callback URLs.
The hosted page and API auth responses use `Cache-Control: no-store`. The server
disables request logging. Reverse proxies should avoid retaining the sign-in
query or request bodies.

## Authenticated operations

Use the existing application API for all chat, bot, avatar, upload, file download,
draft, preference, routine, approval, clarification, and connection operations.
Send `Authorization: Bearer OPAQUE_SESSION` without cookies or an Origin header.
Native bearer sessions do not need CSRF tokens. Every request rechecks the current
household allowlist. A missing, invalid, expired or revoked session returns 401
with `code: "session_expired"`. Clear the Keychain session and require sign-in
only for that code. An expired or replayed native sign-in flow or handoff code
returns the same code. Other 401s keep the session, such as terminal step-up
with `code: "reauthentication_required"`.

When Hermes rejects this server's own credential, the server returns 502 with
`code: "hermes_unauthorized"` and a message to show. It never forwards a Hermes
401 or 403. The person is still signed in; the self-hoster must update the
server's Hermes token.

`GET /api/files/:id` streams the file. It sends `Content-Length` only when Hermes
reports one for an uncompressed body, and the cap counts decoded bytes. A file over 100 MB returns 502 with `code: "file_too_large"` and a message
to show. If Hermes understated the length, the transfer stops at the cap instead,
so treat a truncated body as a failed download.

`GET /api/bots/:id/conversation` without a query returns the whole history and
every file. With `turns` or `start`, it returns that window, `earlier` messages
before it, and only the window's `files`; `earlierFiles` counts files that only
earlier messages carry, and `GET /api/bots/:id/files?before=MESSAGE_ID` lists
those messages with their files. `GET /api/bots/:id/events` is a server-sent
event stream for the same readers: each `change` message means the
conversation may have changed, so refetch it, and refetch after any reconnect.
It sends a `ping` event every 25 seconds and ends when the session does.

Clients may opt in with `/api/bots/:id/events?inflight=1`. Token, reasoning,
status and tool-start frames then send `event: inflight` at most four times a
second, with JSON `{botId, message, activity, toolCalls}`. `message` is the
synthetic assistant row whose ID ends in `-inflight`, including optional
`reasoning` and `origin`. Replace that row, or remove it if both text and
reasoning are empty, and replace `activity` and `toolCalls` without a GET.
The same persisted-segment and origin rules as conversation reads apply,
and private agent handoffs are redacted. Apply a patch only while the fetched
conversation is active and its `activity.runId` matches the patch. A settled
conversation or a newer run supersedes a retained live tail.
Structural events still send `data: change`, meaning refetch. Clients fetch on
stream open and reconnect; the server sends no initial notice. Streams without the parameter retain their
one-change-per-second streaming cadence.

`?inflight=2` opts in to the same stream with growth sent as deltas, so a long
reply is not resent whole every 250 ms. `?inflight=1` is unchanged, and the iOS
app and cached web bundles keep using it. A `?inflight=2` stream sends the first
`event: inflight` whole and then, while the same reply only grows, `event:
inflight-delta` with JSON `{botId, messageId, baseTextLength, baseReasoningLength,
appendText?, appendReasoning?, activity, toolCalls?}`. The lengths count UTF-16
code units of the `message.text` and `message.reasoning` the stream last sent, an
absent `reasoning` counting as zero. Append the suffixes to the live reply you
hold, replace `activity`, and replace `toolCalls` only when the event carries it.
An event that sends nothing new is omitted. The server sends the update as a whole
`inflight` event instead of a delta when the message `id` changed, when text or
reasoning changed any way except by growing at the end, when any other message
field changed, after any `data: change` notice, and on a new stream. Later growth
of that reply may be sent as deltas on the whole event's text and reasoning. Deltas are
computed on the redacted reply, so redaction applies exactly as for `?inflight=1`.
If a delta's `messageId` or base lengths do not match the reply you hold, or you
hold none, discard it, refetch the conversation and reconnect the stream, which
restarts from a whole event. A server that predates `?inflight=2` treats it as no
opt-in and sends only change notices, which clients already handle.

`GET /api/bootstrap?roster=lean` and `GET /api/bots?roster=lean` opt in to
roster fields only: `id`,
`name`, `description`, `model`, `provider`, `shared`, `ownerId`, `avatar`,
`sessionId`, `activity`, `lastMessage` and `unread`. `unread` is true when the
latest message is newer than this person's last read of a chat they have opened
before; chat presence reports record reads. Show the open chat as read, and treat a
chat as read through its latest message after leaving it until the next roster.
Optional configuration fields
`instructions`, `enabledTools`, `enabledSkills` and `enabledMcpServers` load
from `GET /api/bots/:id`. Fetch detail before initializing a settings form or
resending configuration during a model change. Model fallback from profile
configuration is also available in detail. Without `roster=lean`, both list
routes retain full configuration for native build 5 and cached web bundles.
Build 5 can decode missing fields, but its settings form treats them as empty
and can erase saved configuration. It must receive the full default roster.

`GET /api/events` is an authenticated household SSE stream. `event: roster`
with `data: roster` means refresh bootstrap. It carries no assistant IDs or
previews. The server evaluates the cheap roster at most once per second and
notifies each viewer only when their visible roster changes. Private activity
does not notify other household members. Clients fetch on open; there is no
initial roster notice. The stream pings every 25 seconds and ends on sign-out. Refresh on
reconnect and foreground as well. A 45-second bootstrap poll covers missed
notices and changes made outside this app. The server shares one read of the
assistant list, capabilities and connection status among bootstraps for 1.5
seconds, so many devices answering one notice cost one Hermes round trip. It drops
that read when this app writes an assistant, a routine, an integration, a Hermes
upgrade or a connection retry, and never keeps a disconnected one, so a change
made outside this app can take up to 1.5 seconds longer to show.

`GET /api/events?group=ROOM_ID` also watches one group chat. The server checks the
room like `GET /api/groups/:id`, answering 404 for a room the person cannot see,
before the stream opens. While any stream watches a room, the server reads that
room from the Hermes coordinator about every 2 seconds, one reader per room, and
stops when the last watching stream closes. Reads slow down to every 30 seconds
while Hermes fails. Each change to the room's latest event or its driver status
sends `event: group` with `data: {"roomId":"ROOM_ID","latestSeq":N}`; fetch
`GET /api/groups/:id/log?since=CURSOR&state=1` from your own cursor. `latestSeq`
can repeat when only the driver status changed, such as a new pending approval,
and is 0 when Hermes does not report one. There is no notice on open, so fetch
then. A room that gains someone else's private assistant ends the stream. Watch
one room per stream; roster events still arrive on the same stream. Each person
may hold 8 room-watching streams at once across tabs and devices, and the server
watches at most 24 rooms for the household. A watch beyond either limit answers
429 with an `error` message before the stream opens; close the stream when the
room leaves the screen, and rely on the fallback poll until a retry succeeds.
Keep a slow fallback poll, such as every 30 seconds, for older servers and
missed notices; they ignore `group` and send no `group` events.

A personal assistant with a recorded owner is private to that owner. For anyone
else it does not exist: lists such as `/api/bots`, bootstrap, Today, search, saved
items, automations, routines and group chats leave it out, and every route that
names it answers 404 with `code: "assistant_not_found"`. That covers every
`/api/bots/:id` route and any `botId` or `profile` in a request body or query.
Routine-ID routes for its routines answer 404 `Routine not found`. A group chat
that includes it exists only for its owner. Bootstrap preferences drop it from
favorites, sections, followed assistants and the default assistant. Treat a 404
for the open assistant as "no longer available": refresh bootstrap and leave
that conversation. An assistant that is not in Hermes's roster answers the same
404, so a private assistant cannot be told from a made-up ID. A read that was
under way when an assistant became private to the caller answers 404 for that
assistant's own route, or 503 with `code: "assistants_changed"` for anything
else; retry it. Inside a shared assistant's conversation, history and search,
agent exchanges with someone else's private assistant read "Message from another
member's assistant" without their content. A submission receipt is shown only to
its sender. Shared assistants and personal assistants without a recorded
owner stay open to every household member, who may also change them.

`PATCH /api/bots/:id` with `"shared": false` on an assistant everyone can see
makes it the caller's private assistant. The request needs
`"confirmPrivate": true`, sent after the person confirms that it will disappear
for the rest of the household. Without it the server returns 409 with
`code: "private_confirmation_required"` and changes nothing. `POST /api/bots`
records a personal assistant's owner before Hermes creates it, and returns 409
when an assistant with that name already exists. If someone else
changed its sharing while the save was under way, it returns 409 with
`code: "sharing_changed"` and changes nothing. A private assistant's routines
accept only its owner as a recipient; others return 400 with
`code: "private_recipients"`. Only its owner can
reach a private assistant to share it again; sharing clears the recorded owner.
`DELETE /api/bots/:id` also removes its owner, visibility and each person's
drafts, read positions, reply choices, saved items and preference references,
along with its recorded events, notifications, run participants, submissions and
trials, so a new assistant reusing the ID starts clean.

Browser APIs continue to require their HttpOnly session cookie, exact app Origin
for writes, and CSRF token for authenticated writes. A bearer request carrying
any Origin is rejected. Invalid bearer credentials never fall back to cookies.

`POST /api/auth/logout` revokes the presented native session immediately and
removes all device registrations linked to it. Await the operation before
discarding a valid credential. A failed/offline logout needs a visible retry
because clearing only local storage cannot revoke the server session. When the
server stays unreachable, the app lets the person clear the local session anyway
after warning that the server-side session remains valid until it expires.

## Retrying a failed turn

`POST /api/bots/:id/messages` accepts `retryOf`, the ID of a user message in this
assistant's current conversation, to send that message again after the assistant's
turn failed. Send the failed turn's retry ID as `requestId` (below), the original
`text`, its files as `attachments`, and no `draftBaseRevision`; a retry with
`draftBaseRevision` answers 400. The server answers 400 when `retryOf` names a
message that is not a person's message in the current conversation, such as an
assistant reply, a scheduled delivery, another assistant's message or an ID from
another chat, and 400 on `POST /api/bots/:id/steer`. While the assistant is working
or waiting on someone it answers 409; offer Retry only after a failed turn. A retry
never reads, merges or clears the sender's draft. Receipts, uncertain receipts and
attribution work as for any other message.

### One retry per failed turn

The server admits one retry per failed turn: the assistant, `retryOf`, and the
conversation's `activity.runId` when the retry arrives, or empty without one. A
retry's `requestId` must be exactly that turn's retry ID (below), derived from the
run the server reads; any other ID answers 400 and records nothing, so reload the
conversation and derive it again. An ordinary message or steer whose `requestId` is
a version 8 UUID also answers 400: those IDs are kept for retries, so send ordinary
messages with random version 4 IDs. The first retry claims the turn. A retry with
the claimed `requestId` takes the usual idempotent path; from another person, or
with different text, it answers the same receipt instead of 409, even when both
arrive at once. Reviewing an `uncertain` retry with `reviewedUncertain: true`, from
anyone who can see the assistant, sends the recorded request again: its original
text, files and sender, which Hermes's idempotency check covers. Anyone who can see
the assistant can read a retry's receipt with `GET /api/submissions/:id`. Once the
retried message runs and fails again, Hermes records it as a new message in a new
run, so retrying it is a new turn.

While the conversation's activity is `failed`, `GET /api/bots/:id/conversation`
carries `retry`, that turn's claim as a receipt with `retryOf`, once anyone retried
it. Hide Retry when its `retryOf` is the latest person's message and its status is
`accepted`, `rejected` or `interrupted`. A refused retry stays refused under its ID,
so while `retry` is `rejected` or `interrupted`, show "Hermes didn't take the retry."
followed by its `message`, if any, and offer "Put my message in the message box". That
adds the retried message's text after the draft's own, separated by a blank line, and
its files after the draft's, up to the attachment limit. It never replaces the draft,
and is not offered while a message is sending. The person sends it from the composer
as a new message. While it is `uncertain`,
show "Checking whether the retry arrived…" and check its `requestId` with
`GET /api/submissions/:id`: at once, then after 2, 4, 8 and 16 seconds, then every
30, until a receipt settles it or the conversation moves past that message or run.
Retry in that state sends the same request with `reviewedUncertain: true`, only
when the `idempotency` capability is supported; without it, keep Retry disabled and
say the retry is unconfirmed and will not be sent again. Never make a new request
ID for the same failed turn.

### Retry request ID

Every client derives the same `requestId` for a failed turn, so a lost response, a
second tab, a reload or another device can never run it twice:

1. Join `wildbots-retry`, the assistant ID, `retryOf` and the failed
   `activity.runId` (empty without one) with a NUL character (U+0000) between
   them, and encode the result as UTF-8.
2. Take the first 16 bytes of its SHA-256 digest.
3. Set byte 6 to `(byte6 & 0x0F) | 0x80` (version 8) and byte 8 to
   `(byte8 & 0x3F) | 0x80` (the RFC 9562 variant).
4. Format the bytes as a lowercase UUID, `8-4-4-4-12` hex digits.

`src/shared/retry-id.ts` implements it; `tests/retry-id.test.ts` checks these
vectors:

| Assistant | `retryOf` | Run | `requestId` |
| --- | --- | --- | --- |
| `ranch` | `msg-42` | `run-7` | `97260a13-beba-8fb5-9218-204b5e8a2010` |
| `ranch` | `msg-42` | empty | `3bba2658-e84c-8ad5-a391-77d34308f4b8` |
| `café` | `👋` | `run` | `f0431e86-8678-8bc4-92de-7d27336108fb` |

## Drafts

Each person has one draft per assistant, shared by their devices.
`GET /api/bots/:id/draft` returns it, or `null` if they never saved one there. The
conversation response carries the same object as `draft`:

```json
{ "text": "Add basil", "attachments": [], "revision": 4, "reason": "edit", "sentRevision": 2 }
```

`revision` grows with every change. `reason` is `edit`, or `sent` when the latest
change was the clear after an accepted message. `sentRevision` is the revision of
the latest such clear, or 0. A draft saved before revisions existed is at revision 0.

`PUT /api/bots/:id/draft` takes `{ "text": "...", "attachments": [], "baseRevision": 4 }`
and returns the saved draft. `baseRevision` is the revision the edit was made on.
If the draft has changed since, the server returns 409 with `code: "draft_conflict"`
and the current draft as `draft`, and saves nothing. Without `baseRevision`, as from
older app builds, the edit always applies. Content the server already has is not a
conflict and does not advance the revision, so a retried save is harmless.

A message submission may carry `draftBaseRevision`, the revision of the draft the
message was written on. When Hermes accepts the message, the server clears the
sender's draft for that assistant if it is empty or missing, still holds exactly
the sent text and attachments, or has a revision at or below `draftBaseRevision`.
The last rule clears a draft whose final edits were never saved because the
person sent first. An edit saved from another device after that base keeps the
draft. Without `draftBaseRevision`, as from older app builds, the base rule does
not apply. A clear always advances the revision with reason `sent`, even for an
empty draft, so a save dispatched before the send conflicts instead of restoring
the sent text.

Clients keep a local copy with its base revision, a fingerprint of the content at
that revision, an unsaved-edits flag, and a sequence number that increases with
every local edit. Each save records the sequence it carries. Every server draft
that reaches the client, from a load, a save acknowledgment or a 409, is merged
into the copy as it is now, never applied as the request's snapshot:

1. A read older than the copy's base is ignored, unless it is the 409 answering
   the copy's latest edit with no other save in flight, as after a database restore.
2. A copy without unsaved edits adopts the server draft. While the text this device
   sent is still on the server and `sentRevision` does not yet show that send, it
   waits for the clear. Once it does, the guard ends, so a later draft with the
   same text is adopted.
3. If `sentRevision` is newer than the copy's base, and the copy still holds its
   base content or the text this device sent, that text was sent: adopt the
   server draft. A retry after a 409 goes through the same rule.
4. Matching content is saved, but only once no other save of that draft is in
   flight, because an older save may still land.
5. Otherwise unsaved edits are new work and win, including text typed offline
   while another device sent the shared draft. Keep them and save again on the
   server's revision.

A save in flight is never cancelled; its response is merged like any other. Saves
of one draft go one at a time, except that leaving sends the latest edit at once.
After every response or merge, a copy left unsaved with no save in flight or
waiting saves again. A failed or timed-out save does the same after a backoff of
1, 2 and 4 seconds, up to 30, reset by the next answered save.
Fingerprints use a fixed attachment field order.

The web client implements this in `src/app/draft-merge.ts` and iOS in
`Draft.merge` in `Models.swift`. Both save a pending edit at once, instead of
dropping it, when the person switches assistants or leaves: the web with a
`keepalive` request on page hide, iOS with a short background task.

## Household experience

Web and native clients share these authenticated operations. See
[Household experience](HouseholdExperience.md) for behavior and the card schema.

| Method and route | Body or response |
| --- | --- |
| `GET /api/today` | Canonical activity, pending decisions, paged recorded events, recent files, `generatedAt`, `frontier` and `hasMore`. The ETag leaves out `generatedAt`, so an unchanged recap answers 304 and the client keeps the body it has; show your own check time |
| `PUT /api/today/seen` | `{ "seenAt": "LOADED_GENERATED_AT", "frontier": "LOADED_FRONTIER" }`; advances only the returned page |
| `GET /api/bots/:id/memory` | Native profile scope, document revisions, entries and character limits |
| `PATCH /api/bots/:id/memory/:target` | `{ "revision": "SHA256", "entries": [{ "id": "EXISTING_ID", "text": "FACT" }] }`; target is `memory` or `user` |
| `DELETE /api/bots/:id/memory/:target` | `{ "revision": "SHA256", "entryId": "EXISTING_ID" }` |
| `POST /api/bots/:id/voice/transcribe` | Multipart `audio` field, maximum 8 MiB; returns a reviewable transcript |
| `POST /api/bots/:id/voice/speak` | `{ "messageId": "COMPLETED_ASSISTANT_MESSAGE_ID" }`; returns a private, single-use audio URL |
| `GET` or `PUT /api/bots/:id/messages/:messageId/cards/:cardId/state` | `{ "checkedIds": ["ITEM_ID"], "notes": { "ITEM_ID": "PERSONAL_NOTE" } }`, private to the caller |
| `GET /api/routines/templates` | Routine recipes |
| `POST /api/routines/preview` | `{ "botId": "ID", "schedule": "CRON_OR_NATIVE_SCHEDULE" }`; actual timezone and upcoming runs |
| `POST /api/routines/:id/run` | `{ "requestId": "UUID" }`; durable native trial receipt |
| `GET /api/routines/:id/runs/:requestId` | Exact trial result; rechecking does not execute another trial |
| `GET /api/groups/:id/log?since=CURSOR&state=1` | The group's events after `since`. `state=1` adds the room and its driver status as `state`, so an open group polls with one request and one Hermes read. Servers before this option answer 400; then read `GET /api/groups/:id` separately. A `message.user` event sent through this app carries `sender: { "id": "USER_ID", "name": "NAME" }`; label others "Household member" |
| `GET /api/search?q=TEXT&botId=ID` | `{ "hits": [...], "unavailableBots": [...] }`. `botId` is optional and searches only that assistant, answering 404 with `code: "assistant_not_found"` for one the person cannot see. A hit whose `sessionId` is the assistant's current session and that has a `messageId` can open the live chat with `GET /api/bots/:id/conversation?start=MESSAGE_ID` |

Preserve memory drafts after a 409 revision conflict. Persist a trial's request ID
before dispatch and reuse it after an uncertain admission. Do not replay a trial
automatically. iOS read aloud plays `POST /api/bots/:id/voice/speak` audio from Hermes, as
the web does, and refuses replies over 12,000 characters; transcription uses Hermes.

## Work and learning

`GET /api/bots/:id/automation` returns the shared `AutomationOverview` contract
in `src/shared/automation.ts`. Goals, tasks, triggers and skills each report
`supported` and an optional explanation. Clients must honor those capabilities
and the server's `canManageTriggers` and `canManageLearningPolicy` flags.

All routes below are relative to `/api/bots/:id/automation`.

| Method and route | Contract |
| --- | --- |
| `PUT /goal` | `{title,maxTurns}` replaces the entire goal with a new paused goal, resetting progress, subgoals, completion contracts and verification gates; require explicit confirmation for an existing goal |
| `POST /goal/resume` | `{requestId,reviewedInterruption?}` resumes through durable chat admission and returns the overview |
| `POST /goal/pause` or `/goal/clear` | `{}`; both work during an active turn and return the overview |
| `POST /tasks` | `TaskInput`, including a UUID `requestId`; returns a blocked `AutomationTask` |
| `GET` or `PATCH /tasks/:taskId` | Reads a task, or edits `{title?,body?,priority?,assignee?}`; explicit `assignee: null` clears assignment, omission preserves it |
| `POST /tasks/:taskId/actions` | `{action,reason?,reviewer?}`; action is `start`, `block`, `unblock` or `request_review` |
| `PUT /tasks/:taskId/dependencies/:dependencyId` | `{remove}`; dependencies must share the selected owner profile |
| `POST /triggers` | `TriggerInput`; returns a disabled subscription and its signing secret once |
| `PUT`, `PATCH` or `DELETE /triggers/:triggerId` | All require the loaded `revision`; PUT edits routing, PATCH edits `enabled` |
| `GET /skills/content?name=...` | Installed `SkillContent` |
| `GET /skills/pending/:pendingId` | `SkillDiff` with the revision of the reviewed diff |
| `POST /skills/pending/:pendingId` | `{revision,decision}`; decision is `approve` or `reject` |
| `PUT /skills/policy` | `{approvalRequired}`; requires an integration administrator |

Persist a resume UUID before sending. An `uncertain` resume requires a status
refresh, never automatic resubmission. A rejected request remains rejected on
retry. A new, explicitly reviewed attempt uses a fresh UUID. Send
`reviewedInterruption: true` only after the person reviews interrupted work.
Persist one task UUID per creation intent as well.
Show the task overview's truncation notice when `tasks.truncated` is true. The
overview contains at most `tasks.limit` newest visible tasks owned by the selected
profile; older tasks remain available in Hermes.

Skill approval must use `SkillDiff.revision` from the loaded detail, rather than
the pending-list revision. Refuse approval of a truncated diff. Keep trigger
secrets only in the creation view until the person dismisses them.

Memory responses expose `refresh.state` as `next_turn`, `pending` or `applied`.
Saved app edits reach the canonical Bot Chat at its next safe execution boundary
without replacing its
history or starting a message. A running turn keeps its existing prompt.

## Native notifications

| Method and route | Body or response |
| --- | --- |
| `GET /api/native/push/config` | `{ "available": true, "environment": "sandbox" }`, or `{ "available": false }` |
| `PUT /api/native/push/device` | `{ "deviceId": "UUID", "token": "HEX_APNS_DEVICE_TOKEN" }` |
| `DELETE /api/native/push/device` | `{ "deviceId": "UUID" }` |
| `POST /api/native/push/test` | `{ "botId": "EXISTING_BOT_ID" }`; queues a notification only for the signed-in person |

Registration, removal, and tests require native bearer authentication. Registration
binds the token to the current person, installation UUID, and native session.
The token must contain 16 to 256 bytes encoded as hex. Do not assume a fixed
Apple token length. Token rotation replaces the previous installation token.
Cross-person ownership collisions return 409 until the former session signs out
or removes that device. An unconfigured host returns an explicit 409 for
registration/tests. Removal remains available if APNs configuration is removed.

The server exclusively chooses the APNs environment. The device must not supply
an environment field; unknown fields are rejected. Configure the app's signed
push entitlement to match the host. Development uses `sandbox`; TestFlight and
App Store use `production`. A single host supports one environment at a time.
An Xcode debug app and TestFlight app that need different environments should
connect to hosts configured for those environments.

APNs and Web Push share the durable notification outbox and existing rules for
run participants, routine recipients, and bot followers. A private assistant's
notifications reach only its owner, including any queued, held for quiet hours or
batched into a digest before it became private, or mid-way through delivery.
Each event reaches only whoever could see the assistant when it happened, judged
by the event's own time; an event without a readable time counts as private.
Today applies the same rule. Each endpoint records
delivery independently; retrying a failed endpoint does not repeat successful
deliveries. No registered endpoint keeps an event pending. Native devices are
removed when their native session expires or APNs reports an invalid token.
Notification taps receive the existing relative `url` field such as `/?bot=ID`
and the event `tag`. Resolve links against the configured application origin;
reject external URLs. Oversized links are omitted instead of truncated.

### Notification payload and actions

Each iOS alert carries `aps.thread-id` set to the assistant ID, so iOS groups
notifications per assistant. Alerts without an assistant, such as digests and
host alerts, have none. The request sets `apns-collapse-id` to the `tag` when it is
1 to 64 printable ASCII characters, or to the tag's base64url SHA-256 otherwise.
Tags name one notification, so the collapse ID only replaces a repeated delivery
of the same one. Clearing still matches the payload's `tag`.

Approval requests set `aps.interruption-level` to `time-sensitive`, so they break
through Focus. The app is signed with the Time Sensitive Notifications entitlement
from build 15; iOS ignores the level for earlier builds.

Every alert about an assistant names its account with `account`, the first 16 hex
characters of SHA-256 of `wildbots-account:` and the user ID, and the assistant
with `botId`, and sets `aps.mutable-content` to 1. The app's notification service
extension then shows the assistant as the sender, with its avatar, like a person
in Messages. People can then allow WildBots through a Focus. The extension reads
only the avatar pictures the app keeps in the App Group per account and never
holds a sign-in token. It waits for iOS to record the message donation before
showing the notification. A portrait avatar shows the assistant's initials. A
notification for an account not signed in on the device stays as sent, and
signing out deletes that account's pictures and donated messages. Digests and
host alerts have no assistant and stay as sent. `botId`, `account` and
`mutable-content` are dropped before the alert itself would exceed APNs' limit.

| Notification | `aps.category` | Extra fields |
| --- | --- | --- |
| Approval request from an add-on that reports its ID | `APPROVAL` | `botId`, `approvalId`, `account` |
| Finished reply in a one-to-one chat | `REPLY` | `botId`, `account` |
| Routine results, failures and other assistant alerts | none | `botId`, `account` |
| Digests and host alerts | none | none |

`APPROVAL` offers Review and Decline, and both need the phone unlocked. The
payload leaves out what the approval would run, because it can contain
credentials, so approving from the notification would be blind: Review opens the
chat, where the approval card shows it. Decline runs without opening the app. It
calls `POST /api/bots/:id/approvals/:approvalId` with
`{ "decision": "denied", "account": ACCOUNT }`, the request the approval card
makes plus the account. The server answers 409 when the account is
not the signed-in person's, or when the approval is no longer pending. The app
sends a decision once and never retries it. When it does not go through, the app
posts a local notification saying so, and tapping it opens the chat. `REPLY`
offers a Reply text field. It opens the app and adds the text to that assistant's
draft for review. While a send to that assistant is unsettled, the text waits, as
Share inbox items do. It is never sent for the person.

Grouping and actions are optional: when they would push the payload past 4000
bytes, the actions go first, then the grouping. IDs over 200 bytes get neither.
Older app builds ignore the new fields.

### Badge

Each alert sets `aps.badge` to the person's badge count when the server can read
Hermes's roster; without one, the badge is left as it was. The count is the number
of assistants they can see that show the unread mark, plus those waiting on an
approval, a question or a secure request, each counted once. The notification being
delivered counts too: an approval as a decision, other news as unread in a chat
they have opened before. An approval the person was notified about keeps counting,
even while the roster shows the assistant idle, until someone decides it in the
app, its own run finishes, fails or is interrupted, or the open requests of the
Hermes session that raised it no longer hold it. Another run or session on the same
assistant, such as a routine, does not settle it. The server compares open requests whenever it reads the conversation
and, a few assistants at a time, about once a minute in the background, and
credits nobody with a decision made outside the app. Approvals count for a day at
most. `src/shared/unread.ts` holds the rule, which iOS mirrors in `UnreadChats`. The read-elsewhere clear push carries the new count as `badge`
beside `aps`, since a background push's `aps` may hold only `content-available`,
and the server follows it with a silent alert push, `{ "aps": { "badge": N } }` at
priority 5, which iOS applies even while the app is closed.

### Web Push

Web Push payloads carry `title`, `body`, `url`, `tag`, `kind`, `botId`, an
approval's `approvalId`, and `badge` as above. The service worker sets the app badge
from `badge`, or clears it at 0. A lone approval also carries `declineToken`, a
single-use token valid for an hour that denies that approval for that person.
Where the browser supports notification actions, the service worker offers Review,
which opens the chat as a tap does, and Decline, which calls
`POST /api/push/actions` with `{ "token": "TOKEN" }` and no session or CSRF token.
The request still needs the app's Origin. The server answers 401 for a used,
expired or unknown token, or an assistant the person can no longer see, and 409
when the approval is no longer pending. A failed Decline shows a notification that
opens the chat. APNs payloads never carry the token.

### Chat presence

| Route | Body |
| --- | --- |
| `PUT /api/bots/:id/presence` | `{ "client": "DEVICE_OR_TAB_ID", "state": "active" }`; returns `{ "ok": true }` |

While a chat is on screen, uncovered by a sheet, and the app is active, send
`active` every 15 seconds with the push `deviceId` as `client`. Send `left` when
the chat leaves the screen, a sheet covers it, or the app leaves the foreground.
Send one report at a time so they arrive in order. `idle` ends presence without marking the chat
read; the web sends it after five minutes without input. The server treats a
client as gone 45 seconds after its last beat.

No device gets a notification for a chat its person has open on any client, or
read on any client after the event happened. That includes retries to an endpoint
that failed earlier. Routine results and security alerts always notify. After a
chat is read, the worker sends each other iOS device that received its
notifications one background push, `apns-push-type: background` at priority 5:
`{ "aps": { "content-available": 1 }, "clear": { "tags": ["TAG"] } }`. It names
the read notifications by their `tag`, newest first and within 4KB, so a clear
that arrives late never removes a newer unread one. The app removes those. iOS
throttles background pushes and drops them for an app the person force-quit, so
the app also clears a chat's notifications when it opens. Browsers get no clearing
push: Safari revokes a Web Push subscription after three pushes that show no
notification. A browser closes its own notifications for a chat when it opens.

Configure `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_TOPIC`, `APNS_PRIVATE_KEY_FILE`, and
`APNS_ENVIRONMENT` together. `APNS_TOPIC` is the app's actual bundle ID.
`APNS_PRIVATE_KEY_FILE` points to a private server file containing the Apple
P-256 signing key. No keys or credentials ship in the iOS app. The server uses
cached ES256 provider tokens, HTTP/2 over TLS, alert push type, bounded 4KB JSON
payloads, and a 15-second request timeout.

Unit/integration tests use generated temporary signing keys and a transport
double. Physical device delivery additionally requires an Apple developer team,
the matching signed app entitlement, a real APNs signing key, notification
permission, and a current device registration. The repository does not provision
those external credentials or publish a signed app.

## Shared computer

The iOS app shows the shared desktop in a `WKWebView` without a web session:

1. `POST /api/computer/desktop` with the bearer token and `{}`, or
   `{ "viewerId": "ID" }` to keep the same attachment identity on reconnect,
   returns `{ "path": "/api/computer/desktop/ws?ticket=TICKET", "expiresAt": "...", "viewerId": "ID" }`.
   The ticket works once, within 30 seconds.
2. Load `ORIGIN/native/computer#path=ENCODED_PATH&control=0`. The page connects to
   the ticketed WebSocket, full screen and scaled to fit, watch-only. Its socket
   carries no bearer token or cookie: a ticket issued to a native session is
   accepted on its own from the app's Origin, and the stream ends when that native
   session ends.
3. `POST /api/computer/control` with the bearer token and
   `{ "action": "take" | "release", "viewerId": "ID" }` returns the computer status.
   After a successful take, set `control=1` in the hash; set it back to 0 after
   handing back or on any failure. Changing only `control` switches input without
   reconnecting. A new `path` reconnects with that ticket.
4. The page reports to the `computer` script message handler, when present, with
   `{ "type": "connected" }`, `{ "type": "disconnected", "reason": "closed" | "lost" }`
   or `{ "type": "failed", "reason": "invalid_ticket" | "viewer_unavailable" | "rejected" }`.
   On disconnect, request a fresh ticket with the same `viewerId` and set the new
   path. The page also sets `data-state` on its root element and announces the
   state in a status line.

The page accepts only a desktop ticket path. It is served with the app's content
security policy and needs no Hermes credential. The terminal stays in the browser.

## Live Activity

The app shows one aggregate Live Activity per device: the person's assistants that are
working, waiting for them, or just finished. The server owns the content so the lock
screen, Dynamic Island and the in-app view agree. Rows include an assistant visible to the
signed-in person when that person sent to its current run (run participant) or follows it,
the same rule as notifications. A private assistant appears only for its owner.

| Method and route | Body or response |
| --- | --- |
| `GET /api/native/live-activity?deviceId=UUID` | `{ "available": true, "state": ACTIVITY_STATE }`; `available` is false when APNs is not configured. The optional installation UUID restores this native session's starting grace and observed rows. `&local=1` says the app is about to start its own activity after a send, which holds pushed starts off this device for two minutes. |
| `PUT /api/native/live-activity` | `{ "deviceId": "UUID", "token": "HEX_ACTIVITY_PUSH_TOKEN", "botIds": ["kitchen"] }`; returns `{ "ok": true }`, and the next push within about five seconds replays the current state. An app launched in the background for a pushed activity adds `"scope": SCOPE`; the server answers 400 when it names another account. |
| `DELETE /api/native/live-activity` | `{ "deviceId": "UUID", "token": "HEX_ACTIVITY_PUSH_TOKEN" }`; removes only that activity token, so late cleanup cannot remove a replacement. The app sends it when the activity is dismissed or ends. When that activity was still registered, the assistants running at the worker's next pass are not started again by push, even after a Hermes outage. |
| `PUT /api/native/live-activity/start` | `{ "deviceId": "UUID", "token": "HEX_PUSH_TO_START_TOKEN", "scope": SCOPE }`; returns `{ "ok": true }`. Answers 400 when the scope names another account. |
| `DELETE /api/native/live-activity/start` | `{ "deviceId": "UUID" }`; stops pushed starts on this device |

`ACTIVITY_STATE` is both the response body field and the APNs `content-state`:

```json
{
  "title": "Kitchen needs you",
  "activeCount": 2,
  "attentionCount": 1,
  "updatedAt": 1760000000,
  "rows": [
    { "botId": "kitchen", "name": "Kitchen", "phase": "waiting", "status": "Needs approval",
      "detail": "Order groceries", "since": 1759999900, "color": "#1084FE" }
  ]
}
```

- `phase` is `starting`, `thinking`, `working`, `waiting`, `blocked`, `done`, `failed` or
  `interrupted`. Clients render an unknown phase as "Status unknown".
- `status` is a short label of at most 24 characters. `detail` is optional, at most 80
  characters, and comes from the current activity detail. `color` is the avatar color when
  the assistant has a geometric or character avatar.
- `updatedAt` and `since` are Unix epoch seconds. They are numbers, not ISO strings, because
  ActivityKit decodes `Date` from the 2001 reference epoch.
- At most four rows, ordered: attention (`waiting`, `blocked`), then `failed` and
  `interrupted`, then `starting`, `thinking` and `working`, then `done`. The first row
  drives the tint, the minimal Dynamic Island symbol and the tap target.
- `activeCount` counts non-terminal rows, including any beyond the first four.

Registration requires native bearer authentication and binds the activity token to the
person, installation UUID and native session, like device registration. The app keeps a
different installation UUID for each server/account so an offline sign-out cannot block
the next person's activity. Re-registering the same session preserves its observed rows
and starting grace; token rotation replays them. A token is 16 to
256 bytes encoded as hex. `botIds` (at most 10) lists assistants the app just sent to: for
two minutes, each appears as `starting` until Hermes reports it active or finished, and
the server does not end the activity while one is still starting. Registering a new token for the same
device replaces the previous one and replays the current state on the next push.
Without APNs configuration, registration returns 409 and the app does not start an
activity.

The background worker pushes with `apns-push-type: liveactivity` and topic
`APNS_TOPIC.push-type.liveactivity`:

- `update` when the content changes, at most once every 15 seconds unless the attention
  count rises, a row finishes, or the active count changes. While anything is active it
  repeats the current state every five minutes so `stale-date` (15 minutes ahead) keeps
  moving. Updates use priority 5; a rise in attention uses priority 10.
- `end` at priority 10 when no row is active and the grace period has passed. The final
  state keeps finished rows and sets `dismissal-date` five minutes ahead. The server then
  forgets the registration.
- Updates never carry an `alert`; ordinary notifications already announce finished work
  and decisions.
- Content stays below 3500 JSON bytes, leaving space for the APNs envelope. Long names
  are shortened and excess previews or rows are omitted without changing aggregate counts.
- A 410 or `BadDeviceToken`, `DeviceTokenNotForTopic` or `Unregistered` response removes
  the registration. Sign-out removes it with the native session.

### Starting by push

On iOS 18 and later the app registers the device's push-to-start token with its
`SCOPE`: the base64url of the server address the app uses, `|`, and the user ID,
the same value it stores in the activity's attributes. The server checks the
scope names the signed-in person. A token belongs to the device, so registering
it for another account, as after an offline sign-out, takes it over. Sign-out
removes it with the native session.

When a device has no registered activity and the person's aggregate gains a
running assistant, the worker sends `event: "start"` at priority 10 with
`attributes-type: "AssistantsActivityAttributes"`, `attributes: { "scope": SCOPE }`,
the current state, a `stale-date` and `input-push-token: 1`. iOS requires an
`alert` to start an activity; it carries the title and the first row's status,
never approval details, and no sound. iOS then wakes the app with the new
activity's update token, which the app registers as above, and updates follow.
This covers work that starts away from the phone, such as a routine or a message
sent from the web. The server remembers which runs an activity on that device already
showed: dismissing an activity keeps those runs off the Lock Screen, and a new run,
even of the same assistant, starts it again. The record drops each run once it
finishes.
Rejected tokens are forgotten and failures back off as for updates.

The app starts the activity in the foreground after sending a message, or on foreground
when the state has active rows. It shows a `starting` seed row for the assistant it sent
to, registers the push token as soon as iOS provides it, and re-registers on every
foreground. It ends extra activities, ends its activity on sign-out or account change,
and respects a per-device Live Activities switch in Preferences.

## Widgets

The widget extension never receives a sign-in token. The app writes a snapshot of the
signed-in person's visible assistants into the shared App Group whenever the household
refreshes, removes it on sign-out or account change, and reloads widget timelines when it
changes. Widgets show the snapshot time and say "Open WildBots to refresh" once it is
older than 30 minutes. Message previews are privacy-sensitive, so a locked device that
hides widget data redacts them. A tap opens `agentinterface://open?bot=ID`, which the app
handles exactly like a notification link to `/?bot=ID`.

## App updates

The bootstrap includes `"nativeApp": { "latestBuild": 12, "updateUrl": "https://testflight.apple.com/join/CODE" }`
when the host sets both `IOS_APP_LATEST_BUILD` and `IOS_APP_UPDATE_URL`. The app compares
`latestBuild` with its own `CFBundleVersion` and, when it is behind, shows an update
banner and a Preferences row whose button opens `updateUrl`. The URL must use HTTPS.
Setting only one of the two variables is a configuration error. Raise
`IOS_APP_LATEST_BUILD` after each distributed build.

Protocol references: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[Apple APNs connections](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns),
and [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
