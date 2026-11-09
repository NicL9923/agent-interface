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
Signing in counts as confirming it's you for the system terminal: the new session
starts confirmed at the Google credential's issue time, or now for a local member.
A Google credential without an issue time leaves the session unconfirmed.
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
Conversation reads carry a `Server-Timing` header that splits the time between the
Hermes read, the add-on's phases and this server. It is diagnostic only and never part
of the body or its ETag.

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
`instructions`, `enabledTools`, `enabledSkills`, `enabledMcpServers` and
`availableMcpServers` load from `GET /api/bots/:id`. `availableMcpServers` lists
every MCP server configured for the profile, enabled or not, so settings can offer
them as switches. Fetch detail before initializing a settings form or
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

The household stream, with or without `?group=`, also sends `event: groups` with
`data: groups` when that person's visible group catalog changes: a room added,
removed, renamed or with changed members, or a room's newest message. Refetch
`GET /api/groups`; the notice carries no room IDs or previews. Visibility follows
`GET /api/groups`, so a room with someone else's private assistant never notifies.
One server check serves every open stream: it reads the Hermes catalog at most once
every 30 seconds, only while a household stream is open, and compares each person's
catalog with the last one, so an unchanged catalog sends nothing. A group write
through this app (create, send, stop, settings, approval) or an assistant change
checks within about a second instead. Every connection also gets one `groups` notice
once its catalog is known: at once when the server already has a starting point, or
when its first check lands. Fetch on that notice rather than on connect, which would
read twice. Notices sent while disconnected are lost, and the connect notice covers
them. Fetch on foreground as well. A fallback
poll of about 5 minutes covers a missed notice; older servers send no `groups`
events, so keep a 30-second poll for them.

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
`code: "private_recipients"`. Routines also take `roomIds`, the group chats they post their
results in, where `GET /api/groups` reports `routineDelivery: true`. A routine lists only the
rooms the reader can open, and leaves `roomIds` out when the server could not read the room
catalog; send `roomIds` only when it was present, since saving replaces the rooms you can see
and keeps the ones you cannot. A new room must be one you can open (400), and a private
assistant's routine may post only in rooms nobody else can open, in practice rooms with one of its
owner's personal assistants (400 with `code: "private_recipients"`). An error that names a room you cannot
open is replaced whole with "Couldn't post in a group chat you can't open.", since Hermes repeats the
room's profile elsewhere in it, and one that names an assistant you cannot see is hidden as private.
A save merges your rooms with the routine's rooms as Hermes has them when the save runs. Anything that
lets a routine deliver checks every room its delivery names, read exactly as Hermes reads it
(`src/server/delivery-targets.ts`): `deliver` and `failure_deliver`, `room:<id>` with any spacing and
case Hermes trims, `room:<id>@<profile>` as the same room, and `origin` delivery into the room a job
came from. That includes rooms you cannot see and targets written outside the app. The places it applies: a save that leaves it enabled,
`PATCH /api/routines/:id/state` with `enabled: true`, `POST /api/routines/:id/run`, and creating,
changing or turning on an event trigger for it. If a room would expose the routine, these answer 409
with `code: "routine_rooms"`. If the rooms, the routine or a trigger's routine cannot be read, they answer
`code: "routine_rooms_unknown"`, including a trigger beyond the 100 the automation overview lists and a
Hermes that offers no room catalog. Hermes lets two assistants hold jobs with one ID: a save checks the
named assistant's routine and a trigger its own assistant's, and `PATCH /api/routines/:id/state`,
`POST /api/routines/:id/run` and `DELETE /api/routines/:id` act on the one you can see and tell Hermes its
assistant, a running trial blocks changes only to its own assistant's routine, a deletion answers 404 and deletes
nothing if that assistant's copy is gone by the time it runs, routine recipients are kept per assistant, answering 409 with `code: "routine_ambiguous"`
when you can see two. Pausing,
saving a paused routine and turning a trigger off always go ahead. `PATCH /api/bots/:id` refuses a sharing change that
would let a routine post where people who cannot see its assistant read it, such as making an
assistant personal while its routine posts in a room others can open, or sharing the last personal
member of a room a personal routine posts in. `POST /api/bots` refuses the same way when a room
still lists an earlier assistant with the new one's ID and the new one would open that room. Deleting
an assistant is never refused: a room that lists a deleted assistant opens for nobody. These answer 409 with `code: "routine_rooms"` and names
the routines and rooms you can see; remove those rooms from the routines first. When the routines or
rooms cannot be read, it answers 409 with `code: "routine_rooms_unknown"` and changes nothing. Only its owner can
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

## Direct routes

A server can offer the app shorter paths to itself, such as its household LAN or
tailnet address, beside the primary origin. The app prefers one it can reach and
falls back to the primary origin. The primary origin stays the server's identity:
the Keychain, caches, links, sign-in and every web page use it.

`GET /api/native/routes` returns `{ "routes": [ROUTE] }`, LAN routes before tailnet
routes, or an empty list when the server offers none. A server from before direct
routes answers 404; treat that as an empty list. Each route is
`{ "kind": "lan" | "tailnet", "url": "https://ADDRESS:PORT", "certificateSha256": PIN }`.
Each `ADDRESS` is an IPv4 literal. Skip a route with another kind or scheme, a host
name, a path, no port or a malformed pin, rather than failing the list.

`PIN` is the base64url SHA-256 of the route listener's certificate, in DER form. The
certificate is self-signed and names no host. On a route's address, accept exactly
that certificate and no other, whatever a certificate authority says, and cancel the
handshake otherwise, so the session token is never sent to an impostor. Every other
address keeps the system's own HTTPS evaluation. Learn routes and pins only over the
primary origin or another pinned route.

A route listener serves only the signed-in native API: a registered `/api/` route
with `Authorization: Bearer TOKEN` and neither a cookie nor an Origin header. Of the
`/api/auth/` routes it serves only `POST /api/auth/native/renew` and
`POST /api/auth/logout`. Anything else, including sign-in, unknown paths and
WebSockets, returns 403 with
`code: "direct_route_refused"` before it is handled; send it to the primary origin
instead. An unknown or expired bearer returns the usual 401 `session_expired`.

The app probes each route with `GET /api/native/routes` and a three-second timeout,
uses the best one that answers 200 (LAN, then tailnet, then the primary origin), and
checks again when the app returns to the foreground, when the device's network
changes, and every two minutes while it polls. When a request on a route fails at
the network, the app stops using that route for a minute and sends the request
again on the primary origin if it cannot have reached the server: the connection
never opened, or the handshake failed, or the request is a GET. A write that timed
out or lost its connection is not repeated; the app's usual retry rules apply.

## Reusing a request ID

`POST /api/bots/:id/messages` and `/steer` admit one message per `requestId`. The same
ID with the same content answers that message's receipt again. The same ID with
different text, files or sender answers 409 with `code: "submission_conflict"`, even
when both arrive at once. The web's form cards rely on this: they derive one ID per
person, message, card and attempt, so a second tab or device that sends different
answers learns that the first one already went and follows its receipt.

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

### Form request ID

A form card's answers are sent as an ordinary message under an ID every device of the
same person derives alike, so the server admits them once:

1. Join `wildbots-form`, the person's `formKey` from `GET /api/bootstrap`, the
   assistant ID, the message ID, the card's `id` and the attempt number in decimal,
   with NUL between them, and encode the result as UTF-8.
2. Take the first 16 bytes of its SHA-256 digest.
3. Set byte 6 to `(byte6 & 0x0F) | 0x40` (version 4) and byte 8 to
   `(byte8 & 0x3F) | 0x80`.
4. Format the bytes as a lowercase UUID.

`formKey` is private to the signed-in person and stable across their devices and
the server's restarts; never log or share it. A server without it is older than form
cards. Attempt 0 comes first. Move to the next attempt only after a receipt says
`rejected`. On opening a form with nothing saved, look up attempts in order with
`GET /api/submissions/:id`, skipping `rejected`, until one says where the form stands:
`accepted` means sent, `interrupted` means Hermes restarted while holding it and the
person decides whether to send again, and anything else means not sent yet.
`src/shared/retry-id.ts` implements it; `tests/retry-id.test.ts` checks these vectors:

| `formKey` | Assistant | Message | Card | Attempt | `requestId` |
| --- | --- | --- | --- | --- | --- |
| `k3y_A-b` | `ranch` | `msg-42` | `trip` | 0 | `1ab28536-230d-4777-84cf-8dcda31bb28c` |
| `k3y_A-b` | `ranch` | `msg-42` | `trip` | 3 | `76bbd8a5-8259-4c9e-8b2b-3b3fa7bec9d2` |
| `café` | `👋` | `m` | `c` | 1 | `f2ec6d4c-7663-410f-88ba-49c4a6921df8` |

## Approval scopes, recommended answers and steering

<!-- Workstream B: approval scopes, the decline handoff, recommended answers and the steering label. -->

Every field below is additive. A client that ignores them keeps today's behavior.

**Approval choices.** A pending `Approval` may carry `choices`, the `request.answer` choices
Hermes offered for that request in its order (`once`, `session`, `always`, `deny`), plus
`patterns`, the Hermes pattern keys a session or always grant covers (such as
`recursive delete`), and `command`, the command as Hermes shows it, already redacted.
Without `choices` the request comes from a Hermes that offers approve once or decline.
A request Hermes's smart guardian denied offers only `once` and `deny`. The server
leaves `always` out when the add-on cannot list and remove always-allowed commands
(it reports no `approval_settings`), so no client can save a grant nobody could
remove in the app, and the server refuses `always` there too.

`POST /api/bots/:id/approvals/:approvalId` takes an optional `scope`: `once` (the
default when absent), `session` (this conversation) or `always` (this assistant, from
now on, in every conversation). `scope` is valid only with `decision: "approved"`.
The server refuses a choice Hermes did not offer with 409 and
`code: "approval_choice_unavailable"`, naming the choice; Hermes itself runs an
unoffered `always` as a one-time approval, so a client must never show a scope the
request does not list. `always` saves each pattern to the assistant's Hermes
`command_allowlist` and also grants the current session. Ask before sending
`always` and name the patterns, since a pattern covers commands other than this one.
A notification's Decline is unchanged and never carries a scope.

**Always-allowed commands.** These need an add-on that reports `approval_settings`.

| Route | Request and response |
| --- | --- |
| `GET /api/bots/:id/approval-settings` | `{ "supported", "reason"?, "allowlist": [pattern], "mode": "manual" \| "smart" \| "off", "canManageAutoReview" }`. An older add-on answers `supported: false` with a reason and an empty list |
| `DELETE /api/bots/:id/approval-settings/allowlist` | `{ "pattern" }`; any member who sees the assistant. Removes the pattern from the config and withdraws the matching permanent and session grants the Hermes dashboard process holds, so Hermes asks again at the next command in the app. Another Hermes process, such as the Discord gateway, may keep allowing it until its chat ends or, on Hermes before `ed1afb0`, until it restarts. Answers the settings |
| `PUT /api/bots/:id/approval-settings` | `{ "autoReview": true \| false }` sets Hermes's `approvals.mode` to `smart` or `manual`. Integration administrators only (403, `approval_policy_forbidden`); 409 `approvals_off` when Hermes is set never to ask. Answers the settings |

**Recommended answers.** A clarify question may carry `multiple: true` (Hermes's
`multi_select`) and `recommended`, the index of the one option Hermes marked with a
trailing ` (Recommended)`; Hermes marks the first of several choices. Several marked
options, or a suffix with nothing before it, carry no `recommended`. Show the option
without the suffix and a Recommended tag, pre-select it for a single-choice question,
and never pre-select a multi-select one. Answer with the raw option text, which Hermes
strips. A multi-select answer is one JSON array of strings, such as `["Hay","Feed"]`,
with any written answer as one more item. Send `answerFormat: "json"` with the answers
to say so; the server then refuses a multi-select answer that is not a non-empty JSON
array of strings with 400, naming the question. Without it, the server reads the
answer as an older client's: picks joined with `, ` in option order and any written
text last, which it turns into that array for Hermes. When an option itself contains
`, `, that answer goes to Hermes unchanged, as the person's typed text.

**Steering.** A `SubmissionReceipt` from an add-on that reports `steering_decision`
carries `steered`: whether the add-on admitted the message into the task that was
already running, decided under its submission lock. A user `Message` it admitted that
way carries `steered: true`, in every history read and on every device. Show "Added to
the current task" under it. Absent means unknown, so show nothing.

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

Streams opened as `GET /api/bots/:id/events?drafts=1` also hear about the person's
own draft: each new revision, from an edit or the clear after a send, sends `event:
draft` on that person's streams for the assistant. Its data is the new revision
number, never the draft. Without `drafts=1` none are sent, so a client that treats
every data line as a change, as the iOS app does, is unaffected. A client holding
an older revision reads the draft again, so an edit from another device appears at
once without polling. Other household members' streams never see it. The web app
keeps a 30-second draft read only as a fallback for a stream that fails unnoticed.

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
| `PUT /api/bots/:id/voice` | `{ "voice": "marin" }`, one of `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`; returns `{ "voice" }`. A bot's `voice` is absent until chosen, which means `marin` |
| `POST /api/bots/:id/talk/session` | No body. Needs the `liveVoice` capability. Returns `{ "clientSecret", "expiresAt", "model", "voice" }` with `Cache-Control: no-store`; 429 for a second start within five seconds or past 20 an hour; 409 with the reason when live voice is unavailable or the launch profile is signed out of ChatGPT; 503 when the voice plugin was disabled since the last status check or Hermes refuses it |
| `POST /api/bots/:id/talk/ask` | `{ "requestId": "UUID", "request": "SPOKEN_TEXT" }`; sends it as the caller's message and waits up to 20 seconds. Returns `{ "state": "done" | "working" | "needsApproval" | "needsAnswer" | "interrupted" | "refused", "text"? }`. Repeat the same request ID while the state is `working`, `needsApproval` or `needsAnswer`; it never sends twice |
| `GET` or `PUT /api/bots/:id/messages/:messageId/cards/:cardId/state` | `{ "checkedIds": ["ITEM_ID"], "notes": { "ITEM_ID": "PERSONAL_NOTE" } }`, private to the caller |
| `GET /api/routines/templates` | Routine recipes |
| `POST /api/routines/preview` | `{ "botId": "ID", "schedule": "CRON_OR_NATIVE_SCHEDULE" }`; actual timezone and upcoming runs |
| `POST /api/routines/:id/run` | `{ "requestId": "UUID" }`; durable native trial receipt |
| `GET /api/routines/:id/runs/:requestId` | Exact trial result; rechecking does not execute another trial |
| `GET /api/groups/:id/log?since=CURSOR&state=1` | The group's events after `since`. `state=1` adds the room and its driver status as `state`, so an open group polls with one request and one Hermes read. Servers before this option answer 400; then read `GET /api/groups/:id` separately. A `message.user` event sent through this app carries `sender: { "id": "USER_ID", "name": "NAME" }`; label others "Household member" |
| `GET /api/groups/:id` | A routine's post is a `message.user` event whose `actor.id` starts with `cron:` (`cron-notice:` for a failed run's notice) and whose `actor.display_name` is the routine's name, which may start with an `[bot:ID] ` tag to drop; show it as the routine's post. The room, its driver status and, from Hermes versions with room settings, `context: { "purpose", "notes", "routing": "everyone" or "lead", "lead_member_id" }`. `driver_status.member_activity` lists each assistant's live turn (`member_id`, `status` of queued, running or stopping, 0-based `round_index`, `started_at`, current `tool`), and `max_rounds` bounds a discussion. Older Hermes versions omit them; then say only that the room is working |
| `POST /api/groups/:id/context` | `{ "requestId": "UUID", "purpose": "TEXT", "notes": "TEXT", "leadMemberId": "MEMBER_ID" or null }`. Anyone who can open the room may save; null means every assistant answers a message that names no one. Purpose is at most 500 characters and trimmed notes at most 4,096 UTF-8 bytes. Answers 409 when Hermes cannot save room settings. `GET /api/groups` reports `settings: true` where it can |
| `GET /api/usage/accounts?refresh=1` | `{ "accounts": [...], "unavailableBots": [...] }`: plan limits and credits for the provider accounts the caller's visible assistants use, main provider and fallbacks, each account once. An account has `key` (a 32-character digest, never the credential), `provider`, `plan`, `windows` (`label`, `usedPercent` 0 to 100 or null, `resetsAt`, `detail`, `scope` of `account` or `model`), `details`, `unavailableReason`, `bankedResets`, `botIds` and `fallbackOnly`. The server keeps one answer for a minute, and a failed read for 15 seconds; `refresh=1` reads again once the answer is 15 seconds old. A read still running is shared. 409 when the Hermes add-on predates account usage |
| `POST /api/usage/accounts/:key/reset` | `{ "confirmed": true, "requestId": "UUID", "force": false }`; spends one banked ChatGPT reset. Send it only after the person confirms. Keep the request ID until a 200 answer and reuse it to retry: Hermes records each request before asking ChatGPT, so a retry returns the recorded outcome, or `uncertain` when Hermes stopped before recording it, and never spends twice. `force: true` spends one before any account-wide limit is used up, which wastes most of it; ask again with that warning first. Returns `{ "status", "message", "availableCount", "windowsReset", "account"? }`, status one of `reset`, `nothing_to_reset`, `no_credit`, `already_redeemed`, `not_exhausted`, `no_credits_banked`, `unavailable`, `uncertain`. `message` is a fixed sentence per status. `availableCount` is null when ChatGPT could not be asked after the reset; say nothing about the count then. Keep the request ID on `uncertain`. 404 for an account none of the caller's assistants uses, 409 for a provider without resets or while another reset for that account is in progress through any of its sign-ins |
| `GET /api/search?q=TEXT&botId=ID` | `{ "hits": [...], "unavailableBots": [...] }`. `botId` is optional and searches only that assistant, answering 404 with `code: "assistant_not_found"` for one the person cannot see. A hit whose `sessionId` is the assistant's current session and that has a `messageId` can open the live chat with `GET /api/bots/:id/conversation?start=MESSAGE_ID` |

Preserve memory drafts after a 409 revision conflict. Persist a trial's request ID
before dispatch and reuse it after an uncertain admission. Do not replay a trial
automatically. iOS read aloud plays `POST /api/bots/:id/voice/speak` audio from Hermes, as
the web does, and refuses replies over 12,000 characters; transcription uses Hermes.
Live Talk is web-only for now. iOS decodes the `liveVoice` capability and ignores
a bot's `voice`.

<!-- Main assistant: begin -->
### Main assistant and check-ins

`mainBotId`, `checkIns: { "enabled", "everyHours", "timezone" }` and
`mainSuggestionDismissed` are optional `Preferences` fields; servers before them
omit all three. The server owns `mainBotId` and `checkIns`: `PATCH /api/preferences`
ignores whatever a client sends for them, so an older client's save can neither
change nor clear them. Send `mainSuggestionDismissed: true` there; an omitted value
keeps the saved one.

| Method and route | Body or response |
| --- | --- |
| `PUT /api/preferences/main` | `{ "botId": "ID" }` or `{ "botId": null }` to clear; the key is required, so encode null explicitly. Returns `Preferences`. 409 `main_not_personal` for an assistant that isn't the caller's own personal one, with the reason; 404 for one they can't see. A new main assistant starts with check-ins off |
| `PUT /api/preferences/check-ins` | `{ "enabled": true, "everyHours": 1-4, "timezone": "IANA_NAME" }`. Returns `Preferences`. 400 `check_in_hours`; 409 `main_required`, or when Hermes has no routines; 502 `check_in_unavailable` when Hermes couldn't create or update the routine (the switch is saved off), 502 `check_in_removal_pending` when it is off but Hermes still has the routine, which the server keeps removing |
| `PATCH /api/bots/:id` | Sharing the caller's main assistant, or a personal assistant a check-in is still on, answers 409 `main_share_confirmation_required` until the body has `"confirmMainCleared": true`; then check-ins end first, or 502 `check_in_removal_pending` leaves it personal. Any change to who sees an assistant answers 502 `roster_update_failed`, changing nothing, when Hermes did not take the narrowed roster first |

For a main assistant's routine, saving (paused or not), resuming, a trial run or an event trigger answers
409 `routine_chats` unless its only destination is its own chat. `PUT /api/preferences/main` making an
assistant main records nothing unless Hermes first takes, and enforces, its main assistant's limits:
502 `main_activation_failed` when Hermes didn't take them, 409 `main_activation_failed` when its add-on
can't enforce them. It then answers 409 `main_routine_delivery`, naming them, while any of that assistant's
routines posts anywhere else, and when its routines or the deliveries Hermes holds can't be read; 409
`main_routine_busy`, naming them, while one is running or Hermes still holds a delivery from it, wherever it
posts. Show the message and let the member try again. Clearing or changing it answers 502
`main_clear_pending` when Hermes still has the previous main assistant's check-in: the change is saved, and
that assistant keeps a main assistant's limits until the server removes it.

A refusal that comes after the server saved the member's preferences carries them as `preferences` in its
error body: `main_clear_pending`, `check_in_removal_pending` (from `PUT /api/preferences/check-ins` and from
sharing in `PATCH /api/bots/:id`) and `check_in_unavailable`. Apply them, or reload, so the screen shows
what was saved, and keep showing the message. A routine with `managed: "check-in"` is a member's check-ins: show it without Edit,
Pause or Delete, which answer 409 `check_in_managed`. A transcript `message_agent`
handoff or incoming agent envelope may offer the other assistant's chat when its
`target` or sender names, by ID or name, an assistant in the caller's bootstrap
`bots`; a comma-separated fan-out names none.
<!-- Main assistant: end -->

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

Every alert sets `aps.filter-criteria` for the app's Focus filter: the assistant ID,
`approval:` and the assistant ID for an approval request, or `household` for digests
and host alerts. A Focus filter that chose some assistants lets their notifications,
household news and, unless the person turned it off, every assistant's approval
requests through; iOS delivers the rest quietly. The criteria are dropped before the
alert itself would exceed APNs' limit.

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

<!-- BEGIN device activity -->
### Device activity

Notifications go only to the devices their person is using now. A device is one
installation, named by a **device ID**: a lowercase UUID chosen once and kept across
sign-ins. iOS uses the push `deviceId` it registers with `PUT /api/native/push/device`,
one per install. The web keeps one per browser profile in local storage, shared by its
tabs, and attaches it to its Web Push subscription with `deviceId` on
`POST /api/push/subscriptions` or `POST /api/push/subscriptions/status`. The server
accepts upper case and stores lower case. A registration without `deviceId` clears any
earlier one for that endpoint.

| Route | Body |
| --- | --- |
| `PUT /api/devices/activity` | `{ "deviceId": "UUID", "state": "active", "idleMs": 1200 }` or `{ "deviceId": "UUID", "state": "inactive" }`; returns `{ "ok": true }` |

While the app is in the foreground (iOS) or the window is visible and focused (web),
and the person touched it in the last five minutes, send `active` every 15 seconds on
any screen, with `idleMs` the milliseconds since their last input, below 300000. Send
`inactive` when that stops: the app leaves the foreground, the window loses focus or
hides, five minutes pass without input, or the account signs out or switches. Send one
report at a time and keep at most one waiting, the latest; work out its state and
`idleMs` only as it goes, so a slow server never receives an old `active` after the
device was left. The server answers 400 for a device ID that is not a UUID, a missing
or unknown `state`, `idleMs` that is not a whole number from 0 to 299999, or any other
field. A server from before device activity answers 404; one from before device IDs
refuses `deviceId` on the status route with 400, so ask again without it.

A device counts as in use while its last beat is under 45 seconds old, its last input
under five minutes old, and the session that sent it is still signed in. Signing out
ends it at once. A device ID belongs to one account at a time: the account whose
signed-in session last reported it. Push registrations name a device but never hold one,
so a stale or mistaken label only affects routing. Another account's `active` report for it is refused
with 409 and `{ "error": "This device is signed in to another household member. Sign
out there first." }` until that session signs out or expires, as switching accounts
on the device does. An `inactive` report keeps the account's hold, and one account's
`inactive` never ends another's.

The device ID is the only proof of the installation: a random UUID kept on the device,
never returned to anyone but its own account. A member who copied another member's ID
off their device could hold it before any session has claimed it, or once that ID's own
session has signed out or expired. The real device's reports would get the 409 until the
holder's session ends, so its alerts might arrive as a badge on that device and as alerts
on the owner's other devices. The alerts still go only to their owner. Reading the ID
needs the unlocked device, which already gives far more than this, so no separate
installation credential is issued.

When the person has a device in use that can receive the notification (an iOS device
registered for push, or a browser subscription that named its device), only those get
the alert. Each other iOS device gets the badge alone, `{ "aps": { "badge": N } }` at
priority 5, and its later read-elsewhere clears lower that badge. Other browsers get
nothing: Web Push cannot set a badge without showing a notification, so a browser left
quiet updates its badge when it next opens the app. When no device is in use, or none of
those in use could take it (no subscription, permission removed, an endpoint the push
service reports gone, or a failed send), every device gets the alert as before. Security
alerts always reach every device. A chat open on any device still silences that chat's
notifications everywhere.

A client that sends no device ID is never in use, so it keeps the earlier behavior: it
gets alerts unless its person is using another device. A server without this route
answers 404; clients ignore the failure.
<!-- END device activity -->

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
security policy and needs no Hermes credential.

### Confirming it's you

The system terminal needs a confirmation from the last 2 hours, as on the web. A
signed-in app confirms with the sign-in flow above:

1. Open the `ASWebAuthenticationSession` at
   `/native/sign-in?state=STATE&code_challenge=CHALLENGE&code_challenge_method=S256&purpose=confirm`
   with a fresh state and PKCE verifier. `purpose=confirm` only changes the page's
   heading to "Confirm it's you" and asks for the same household account. Any
   other `purpose` is a 400.
2. Take the code from the same `agentinterface://auth/callback?code=CODE&state=STATE`
   callback, checking the state.
3. `POST /api/auth/native/confirm` with the bearer token, no Origin header, and
   `{ "code": "CODE", "state": "STATE", "codeVerifier": "VERIFIER" }`, validated
   as for exchange. It spends the code and answers `{ "confirmedAt": "ISO8601" }`.
   The session keeps the later of this and any earlier confirmation.

Failures leave the session signed in. None of them uses `session_expired`:

- 401 `{ "error": "That confirmation expired. Try again.", "code": "confirmation_expired" }`
  for an unknown, used or expired code, or a wrong state or verifier.
- 403 `{ "error": "Use the same Google account you signed in with." }` when the
  code belongs to another household member. The code is spent.
- 401 `{ "error": "That confirmation is too old. Try again.", "code": "confirmation_expired" }`
  when the Google credential behind the code is more than 10 minutes old or has
  no issue time.
- 403 `{ "error": "Confirm your identity in the iOS app." }` for a browser session.

### System terminal

`GET /api/computer` reports `terminal: { "available", "target", "reason"?, "confirmationRequired"? }`.
Only terminal administrators get `available: true`; everyone else gets the reason.
`confirmationRequired: true` means the session has no confirmation from the last
2 hours; confirm it first.

1. `POST /api/computer/terminal` with the bearer token and `{}` returns
   `{ "path": "/api/computer/terminal/ws?ticket=TICKET", "expiresAt": "...", "sessionId": "ID", "target": "..." }`.
   The ticket works once, within 30 seconds, and only for the terminal socket. Without
   a recent confirmation the answer is 401
   `{ "error": "Confirm it's you to open the terminal.", "code": "reauthentication_required" }`;
   confirm and try again. A non-administrator gets 403, a turned-off or unavailable
   terminal 403 or 409 with the reason, and maintenance 409.
2. Load `ORIGIN/native/terminal#path=ENCODED_PATH`. The page connects to the ticketed
   WebSocket with no bearer token or cookie, as the desktop page does: a terminal
   ticket issued to a native session is accepted on its own from the app's Origin.
   The connection ends when that native session ends. A new `path` reconnects with
   that ticket.
3. `POST /api/computer/terminal/end` with the bearer token and `{ "sessionId": "ID" }`
   ends the member's own shell and answers `{ "ok": true }`.

The page reports to the `terminal` script message handler with:

- `{ "type": "connected" }` once the shell is attached.
- `{ "type": "disconnected", "reason": "closed" | "lost" }` when the connection ends
  without the shell ending. Request a fresh ticket and set the new path.
- `{ "type": "failed", "reason": "invalid_ticket" | "viewer_unavailable" }` for a path
  that is not a terminal ticket or an emulator that could not load.
- `{ "type": "ended" }` when the shell exited. Offer to start a new one.
- `{ "type": "error", "message": "..." }` with the server's words, such as the
  maintenance pause. The connection stays open.
- `{ "type": "focus" }` when the person taps the terminal. Show the app's keyboard.

The page never raises the web keyboard, so iOS smart quotes and autocorrect never
reach the shell. The app types with its own keyboard through two functions, each
returning whether it sent anything; both send nothing unless the shell is connected:

- `terminalInput({ "text": "..." })` types text, with line breaks as Return.
  `terminalInput({ "key": NAME })` presses one of `enter`, `tab`, `backspace`,
  `escape`, `delete`, `left`, `up`, `right`, `down`, `home`, `end`, `pageUp` or
  `pageDown`, using application cursor keys when the running program asks for them.
  Add `"control": true` to text of one letter, `@`, `[`, `\`, `]`, `^`, `_` or a space
  to send its control character, so `{ "text": "c", "control": true }` is Control-C.
  Control with a key, or with longer text, sends them unchanged.
- `terminalPaste(text)` pastes up to 8,192 characters through the terminal, bracketed
  when the shell asked for it, so a pasted command waits for Return.

The page fits the shell to the web view and sends the size on connect and on every
size change. A finger drag scrolls as a mouse wheel does. The page sets `data-state`
on its root element and announces the state in a status line.

### Handoff requests

An assistant's request to take over the computer arrives in a conversation's
`attention` with `kind: "computer"` and
`computer: { "epoch", "sessionId", "reason", "whatToDo" }`. `reason` and
`whatToDo` are the assistant's own words, at most 200 and 300 characters. Take
over uses the steps above; Hermes answers the request when the person who took
control hands back, so the client sends nothing extra. For **Not now**, call
`POST /api/bots/:id/computer-handoffs/:requestId` with
`{ "decision": "decline", "epoch": "...", "sessionId": "..." }`. It answers
`{ "status": "ok" }`, or `{ "status": "expired" }` when the request already
closed, and 409 when the binding no longer matches the assistant's conversation.

### Terminal requests

An assistant's request for a person at the system terminal arrives in `attention`
with `kind: "terminal"` and
`terminal: { "epoch", "sessionId", "reason", "whatToDo", "command"? }`. The three
texts are the assistant's own words, at most 200, 300 and 500 characters.
`command` is one line with no control or hidden characters; the server drops the
whole card to an official-client request when it is not. Open the terminal with
the terminal routes and offer `command` for the person to paste at the prompt
with `terminalPaste`; never paste it on its own or run it. To answer, call `POST /api/bots/:id/terminal-requests/:requestId`
with `{ "decision": "done" | "decline", "epoch": "...", "sessionId": "..." }`. It
answers `{ "status": "ok" }`, or `{ "status": "expired" }` when the request already
closed. `done` answers 403 unless the person is a terminal administrator, 409
when the binding no longer matches the conversation, and `decline` is open to
anyone who can see the chat. Hermes tells the assistant that `done` is the
person's word, because it cannot see the terminal.

### Connection requests

An assistant's request to set up one of its connections arrives in `attention`
with `kind: "connection"` and
`connection: { "epoch", "sessionId", "connectionId", "reason" }`. `connectionId`
is an ID from `GET /api/integrations?profile=:id`, such as `google_workspace`,
`github` or `key:brave`. `reason` is the assistant's own words, at most 200
characters. Show that one connection's integration controls in the card. To
answer, call `POST /api/bots/:id/connection-requests/:requestId` with
`{ "decision": "connected" | "decline", "epoch": "...", "sessionId": "...", "connection": "<connectionId>" }`.
`connected` answers 409 with a message to show until the catalog lists the
connection as `connected` or `configured`. An OAuth MCP server whose sign-in
never finished reads as `not_connected`, from Hermes's own token store.
Send it once the connection becomes ready while the card is open, or after an
in-card setup finishes. A flow names its connection in `connectionId`; a sign-in
restored for another connection must not settle the card. If the
connection already read as set up when the card opened, wait for the person to
press **Continue**. It answers `{ "status": "ok" }`, or `{ "status": "expired" }`
when the request already closed.

A message sent with `POST /api/bots/:id/messages` while the assistant waits on a
question, a secure request, a handoff or a connection request closes those requests after the message
is admitted, so the assistant reads it next. A login the assistant asked for by
address stays open unless the sender is the member whose task asked for it. An
answer that reaches Hermes after its request closed answers `{ "status": "expired" }`.

## Crash reports

While signed in, the app sends the crashes and hangs MetricKit delivers on a later launch to
`POST /api/client-errors`, the route the web client uses for render crashes and uncaught errors.
One request per diagnostic, with `kind` `crash` or `hang`, `platform` `ios`, a `message` naming
the exception, signal and termination reason with the app version, a `stack` of the top frames as
binary name and offset, `route` `/ios/crash` or `/ios/hang`, and `release` as `<version>-<build>`.
The bounds are `CLIENT_ERROR_LIMITS` in `src/shared/api.ts`. The server logs each report as a
`Client error` warning and stores nothing. It accepts 20 reports per person every 10 minutes and
answers 429 beyond that: drop the report, do not retry it. Never send a token or a URL with a query.

## Linked Macs

`GET /api/mac/devices` lists the signed-in person's Macs linked with WildBots for
Mac, and `DELETE /api/mac/devices/:id` revokes one, with the bearer session. The
iOS app shows them in Settings > Macs. WildBots for Mac itself uses sign-in
contract version 1 once, to enroll, then its own device credential. See
[WildBots for Mac](MacLink.md#protocol-version-1).

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
      "detail": "Order groceries", "since": 1759999900, "color": "#1084FE", "approvalId": "request-7" }
  ]
}
```

- `phase` is `starting`, `thinking`, `working`, `waiting`, `blocked`, `done`, `failed` or
  `interrupted`. Clients render an unknown phase as "Status unknown".
- `status` is a short label of at most 24 characters. `detail` is optional, at most 80
  characters, and comes from the current activity detail. `color` is the avatar color when
  the assistant has a geometric or character avatar.
- `approvalId` is set on a `waiting` row to its first pending approval, when the ID is at
  most 200 bytes. It never carries what the approval would run.
- `updatedAt` and `since` are Unix epoch seconds. They are numbers, not ISO strings, because
  ActivityKit decodes `Date` from the 2001 reference epoch.
- At most four rows, ordered: attention (`waiting`, `blocked`), then `failed` and
  `interrupted`, then `starting`, `thinking` and `working`, then `done`. The first row
  drives the tint, the minimal Dynamic Island symbol and the tap target.
- `activeCount` counts non-terminal rows, including any beyond the first four.

The first row gets one button while the activity is current: **Decline** for a `waiting`
row with an `approvalId`, or **Stop** for a `thinking` or `working` row. Both need the
phone unlocked and run in the app, never in the widget extension. The app acts only
when the activity's scope is the signed-in account. Decline sends the notification
action's request, `POST /api/bots/:id/approvals/:approvalId` with
`{ "decision": "denied", "account": ACCOUNT }`; Stop sends `POST /api/bots/:id/stop` with
`{ "account": ACCOUNT }`. The server answers 409 when the account is not the signed-in
person's, so a sign-in that changed since the app's check cannot act with another
person's token. Stop without a body, as the chat and the web send it, is unchanged.
When either does not go through, a local notification says so and opens the chat.
Approving stays in the chat, where the approval card shows what it would run.

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
older than 30 minutes.

While the app is closed, the background worker compares each person's visible roster
every 30 seconds: names, states, latest messages, avatar colors and pins. When it
changed, it sends each of their devices a background push,
`{ "aps": { "content-available": 1 }, "refresh": ["widgets"] }` with
`apns-push-type: background` and priority 5, at most once per device every 15 minutes.
A change inside that window goes out when it ends. The push carries no names or
previews. The app reads `GET /api/bootstrap?roster=lean` with its own sign-in and
rewrites the snapshot, as it does in the foreground; an outage or a sign-in that changed
during the read leaves the snapshot alone. iOS also runs the app's background refresh
task, `dev.agentinterface.ios.widgets`, when it chooses. Both are best effort: iOS
budgets background pushes and skips them for an app the person force-quit. A device
first seen after the server starts is not woken until its person's roster next changes. Message previews are privacy-sensitive, so a locked device that
hides widget data redacts them. A tap opens `agentinterface://open?bot=ID`, which the app
handles exactly like a notification link to `/?bot=ID`.

## Universal links and Handoff

When APNs is configured, the server answers
`GET /.well-known/apple-app-site-association` without a session. It names
`APNS_TEAM_ID.APNS_TOPIC`, which is the app's bundle ID, for `applinks` and
`activitycontinuation`. Only `/?bot=ID` and `/?view=today` open the app; sign-in and
every other page stay on the web. Without APNs the route answers 404.

The app lists `applinks:` and `activitycontinuation:` for the household's domain,
set by `LINK_DOMAIN` in `ios/tools/generate-project.py`. A link for another server
shows a notice instead of opening. An open chat advertises Handoff with its web link,
`https://SERVER/?bot=ID`, so a Mac without the app opens the web client there. A device
with the app opens it only when that link is its own server's, since another household's
server may use the same assistant ID.

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
