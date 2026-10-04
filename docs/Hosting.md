# Hosting

Nicolas authorized this installation on September 30, 2026:

- App origin: `https://agentui.wildflowersranch.com`.
- Host: the existing household Hermes VPS.
- DNS: Cloudflare, matching the existing dashboard's direct A-record routing.
- HTTPS: the host's existing Caddy installation.

The web app is running at [agentui.wildflowersranch.com](https://agentui.wildflowersranch.com).
Cloudflare DNS resolves to the existing host, and Caddy serves a valid HTTPS
certificate. The application service starts automatically and passes its private
Hermes connection check. Public API requests require sign-in; local development
identities are disabled.

## Installation boundaries

The shared desktop/browser and the administrators' VPS terminal are documented in
[Shared computer](SharedComputer.md). Their supervisor is independent of chat
sessions; its browser data stays in the private shared resource directory.

The app has its own pinned Node 24.21.0 runtime, release directories, private
configuration and SQLite database under the host user's application directory.
It listens on loopback behind Caddy. The host's global Node installation remains
available to existing services. The app sends its own Content-Security-Policy,
Permissions-Policy and HSTS headers. Caddy should pass them through rather than
add its own, because browsers enforce every policy they receive.

Hermes keeps execution, profiles, sessions, provider credentials, tools, memory
and scheduling. Its existing dashboard process must load the integration add-on;
starting another owner against the same Hermes home is not a deployment method.
The existing Google login, dashboard address, gateway service and unrelated Caddy
routes remain in place.

The deployed Hermes revision is `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6`, with
the existing tracked OAuth repair preserved. The wrapper uses Hermes's managed
launcher and loads the add-on into the original dashboard process. If a future
revision or service key fails qualification, the original dashboard still starts;
Agent Interface stays unavailable until its integration is repaired. Failures
after hook installation stop startup rather than continue with partial hooks.

After activation, the original Google session still accessed protected HTTP and
opened two fresh authenticated WebSockets. Both Discord connections, the gateway
process, profile configurations, Caddy and WireGuard were preserved. A failed
first activation exposed a missing setup template in the release archive; the
rollback restored and verified the original dashboard before the corrected
release was activated.

Secrets, household email addresses, host access details, backups and rollback
receipts belong in private operating notes. They are not release artifacts.

## Google setup

The app's HTTPS origin was added to the existing Google web client's authorized
JavaScript origins on September 30 and verified after reloading its settings.
The existing Hermes origin and both redirect URIs were preserved.
The app uses the Google Identity Services callback, so it
does not need a new Google redirect URI. Keep the existing Hermes redirect URI.
The server verifies Google's identity token and enforces the household allowlist.
Local development identities are refused by production configuration.
Nicolas confirmed successful Google sign-in and a quick chat through the
production app on September 30. The second household identity and rejection of
an unlisted identity still need production acceptance in issue #1.

## Application backups

The repository's `backup-app.mjs` tool takes an online SQLite backup, checks its
integrity before publishing the copy, and retains the latest 14 copies. A local
validation recovered a committed WAL row while the source database stayed open
and confirmed owner-only file permissions. The host's daily timer is enabled,
and its first backup completed successfully.

These copies protect against an application mistake. They are on the same host,
so they do not establish disaster recovery from loss of that host. Existing Hermes
backups remain separate.

Set `APP_BACKUP_DIR` to the same directory the timer writes, the app base's
`backups/` directory, so the readiness check can see them. The tool removes its
temporary `.partial` copy and that copy's `-shm` and `-wal` files, and clears stale
`.partial` files older than an hour that earlier runs left behind.

## Logs and health

The server writes JSON lines to stdout, and systemd keeps them in journald. Read
them with `journalctl -u <app service> -f`; add `-p warning` for problems only.
`LOG_LEVEL` defaults to `info`. Individual requests are not logged because clients
poll every 1.5 seconds. Logged requests keep only the method and path, and
authorization, cookie, CSRF and ticket values are redacted.

Lines worth searching for:

- `Request failed`: a 5xx response, logged once per route and message. Repeats
  are counted in `Request failure repeated`, at most every 10 minutes.
- `failed`, `is still failing`, `recovered`: the background worker, Hermes event
  discovery and push delivery. A reminder repeats every 10 minutes while a failure lasts.
- `Gave up delivering notifications`: a notification failed 12 attempts, about an
  hour of backoff. Its row keeps state `failed` and `last_error`.
- `Readiness check degraded`, `alerting administrators`, `recovered`: see below.

`/api/health` is liveness only and always answers `{"ok":true}` while the process
runs. Deploys depend on that, including during a Hermes drain.

`/api/health/ready` returns 200 `{"ok":true}` or 503 `{"ok":false}`. It fails when:

- database: `SELECT 1` fails.
- hermes: Hermes has been disconnected for 5 minutes or longer. A Hermes update
  in progress counts as healthy.
- worker: no successful background pass for 2 minutes, after a 2-minute startup grace.

It also reports two checks that warn but never fail readiness:

- push: the latest delivery failure is newer than the latest success and less
  than 24 hours old.
- backup: the newest completed backup in `APP_BACKUP_DIR` is older than 36 hours,
  or none exists. Unset reports `unconfigured`.

Requests through Caddy see only `ok`. A direct loopback request with no forwarding
headers also gets each check's status and detail:

```sh
curl -s http://127.0.0.1:<port>/api/health/ready
```

The app checks readiness every minute. When a check stays `warn` or `fail` for 10
minutes, it sends one push notification to each Hermes update and integration
administrator who has signed in, and another when the check clears. Both
transitions are also logged. A push outage cannot report itself by push, so it
appears only in the logs and in the loopback detail.

## Hermes upgrades and activity

PR #3 is merged and deployed. Web and iOS have an administrator update flow with
separate qualification and installation actions. The working avatar animates
during native activity; Advanced view shows the reasoning and tool details Hermes
actually exposes.

The household host has private upgrade configuration, an explicit administrator
allowlist, original Google HTTP/fresh-WebSocket verification, and pinned private
shared OAuth and Google-plugin regressions. Its supervised gateway loads the
persistent maintenance guard. The installer verified the gate and both Discord
connections before opening admission. Profile settings and the installed Hermes
revision stayed unchanged. No production Hermes upgrade has been performed.

Deployment exposed and repaired integration issues. The installer now uses
the actual native `/api/ws` maintenance transport. Update staging fetches a
complete independent checkout from official upstream, retaining the installed
tag identities and native version metadata. The Linux hook prepares missing
candidate objects locally before stopping services, so cutover does not depend
on fetching source files while Hermes is offline.

The host also keeps the original approved OAuth patch as an immutable private
artifact. Qualification proves its exact result on the current tree and binds
the candidate's resulting fingerprint separately. Upstream line shifts can then
qualify without weakening the checks for changed repair code or extra local edits.

The production Check for update action qualified official candidate
`663362680b6ffa4fbffeb58f6682564239a1953b` in a disposable managed home. All
source, repair, dependency, integration and private authentication checks passed.
It is ready for the administrator's separate installation action; the running
Hermes version remains d23.

See the [Linux installer contract](HermesUpgradeLinux.md) for host configuration
and recovery requirements. The [validation ledger](ValidationLedger.md) records
isolated execution separately from production activation and update checks.

## Native distribution

iOS users connect to this same HTTPS origin. Apple signing, APNs credentials and
physical-device notification acceptance are separate from hosting the web app.
The server reports push availability so the app can explain missing setup.
