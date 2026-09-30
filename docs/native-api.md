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
household allowlist. Expired and revoked native sessions return 401; clear the
Keychain session and require sign-in.

Browser APIs continue to require their HttpOnly session cookie, exact app Origin
for writes, and CSRF token for authenticated writes. A bearer request carrying
any Origin is rejected. Invalid bearer credentials never fall back to cookies.

`POST /api/auth/logout` revokes the presented native session immediately and
removes all device registrations linked to it. Await the operation before
discarding a valid credential. A failed/offline logout needs a visible retry
because clearing only local storage cannot revoke the server session.

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
