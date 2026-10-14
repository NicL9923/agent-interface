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
credentials. Session lifetime is seven days. Exchange credentials are never
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

Only the owner of a personal assistant can change, delete or re-avatar it, change
its tools, skills or inference settings, or read its search history and routine
results. Anyone else receives 403 with `code: "owner_only"` and an explanation to
show. Its routines follow the same rule: `GET /api/routines` omits them for anyone
else, routine-ID routes return 404 for them, and creating, moving or previewing a
routine on that assistant returns 403 `owner_only`. Shared assistants and personal assistants without a recorded owner accept
every household member.

Browser APIs continue to require their HttpOnly session cookie, exact app Origin
for writes, and CSRF token for authenticated writes. A bearer request carrying
any Origin is rejected. Invalid bearer credentials never fall back to cookies.

`POST /api/auth/logout` revokes the presented native session immediately and
removes all device registrations linked to it. Await the operation before
discarding a valid credential. A failed/offline logout needs a visible retry
because clearing only local storage cannot revoke the server session. When the
server stays unreachable, the app lets the person clear the local session anyway
after warning that the server-side session remains valid until it expires.

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
sender's draft for that assistant if it still holds exactly the sent text and
attachments, or if its revision is at or below `draftBaseRevision`. The second
rule clears a draft whose final edits were never saved because the person sent
first. An edit saved from another device after that base keeps the draft.
Without `draftBaseRevision`, as from older app builds, only the exact-text rule
applies. Either clear advances the revision with reason `sent`.

Clients keep a local copy with its base revision and an unsaved-edits flag, and
reconcile it the same way after a 409 or a load that shows a different revision:

1. A copy without unsaved edits adopts the server draft.
2. If `sentRevision` is newer than the copy's base, the text was sent from another
   device: drop the unsaved edits and adopt the server draft. A copy this device
   sent from, or restored with Discard, keeps its edits, because that clear may be
   its own send.
3. Otherwise unsaved edits win. Keep them and save again on the server's revision.

A load older than the copy's base is ignored; a 409 is always the current draft.
The web client implements this in `src/app/draft-merge.ts` and iOS in
`Draft.merge` in `Models.swift`. Both save a pending edit at once, instead of
dropping it, when the person switches assistants or leaves: the web with a
`keepalive` request on page hide, iOS with a short background task.

## Household experience

Web and native clients share these authenticated operations. See
[Household experience](HouseholdExperience.md) for behavior and the card schema.

| Method and route | Body or response |
| --- | --- |
| `GET /api/today` | Canonical activity, pending decisions, paged recorded events, recent files, `generatedAt`, `frontier` and `hasMore` |
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

Preserve memory drafts after a 409 revision conflict. Persist a trial's request ID
before dispatch and reuse it after an uncertain admission. Do not replay a trial
automatically. iOS read aloud uses the device voice; transcription uses Hermes.

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
run participants, routine recipients, and bot followers. Each endpoint records
delivery independently; retrying a failed endpoint does not repeat successful
deliveries. No registered endpoint keeps an event pending. Native devices are
removed when their native session expires or APNs reports an invalid token.
Notification taps receive the existing relative `url` field such as `/?bot=ID`
and the event `tag`. Resolve links against the configured application origin;
reject external URLs. Oversized links are omitted instead of truncated.

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

Protocol references: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns),
[Apple APNs connections](https://developer.apple.com/documentation/usernotifications/establishing-a-connection-to-apns),
and [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
