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

The app's last recorded runtime pin is Node 24.21.0. Before the next production
release, verify the app-specific host runtime and update it to Node 24.22.2 if
needed. The release tool builds with that host binary, and 24.21.0 is outside
the updated package engine range. Track this prerequisite in [issue #210](https://github.com/NicL9923/agent-interface/issues/210).
This dependency update does not change the production host.

The app has its own pinned runtime, release directories, private
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

## Metadata egress floor

The host is an OpenStack instance, and its metadata service at
`169.254.169.254` serves cloud-init user data and instance details to any local
process that asks. One Unix account runs everything household-facing: the Hermes
gateway and dashboard, this app, the shared-computer browser and agent terminal
tools. URL checks in the browser paths cannot see runtime-built URLs, `curl` or
Python tools, so the host blocks that account at the network layer.

`.agents/tools/metadata-egress-floor.py` installs a dedicated nftables table,
`inet agent_interface_metadata`. Its output-hook chain rejects every packet the
service account's sockets send to `169.254.169.254` or OpenStack's IPv6
link-local `fe80::a9fe:a9fe`: TCP with a reset, everything else with
admin-prohibited, so clients fail at once instead of hanging. Only those two
addresses are blocked; the rest of `169.254.0.0/16` stays reachable, and root,
including cloud-init, is not affected. The tool loads only its own table in one
transaction and never flushes the ruleset, so ufw's iptables-nft rules stay
untouched.

The rules live in root-owned `/etc/agent-interface/metadata-egress-floor.nft`.
The root oneshot `agent-interface-metadata-floor.service` loads that file at boot,
after `network.target`, `nftables.service` and `ufw.service` and before the
service account's `user@UID.service`. It reloads and restarts with
`nftables.service`, whose ruleset flush would otherwise remove the table.

Install it before preparing a release, from any checkout that has the tool. Before
the first release that carries it, copy the tool from the merged commit:

```sh
git show origin/main:.agents/tools/metadata-egress-floor.py | ssh <host> 'umask 077 && cat > ~/metadata-egress-floor.py'
ssh -t <host> 'sudo nft list ruleset > ~/nft-before.txt'
ssh -t <host> 'sudo python3 ~/metadata-egress-floor.py install --user <service user>'
ssh -t <host> 'sudo python3 ~/metadata-egress-floor.py check --user <service user>'
```

Install is idempotent: rerunning it rewrites nothing unless the uid changed, and
reapplies the table. It validates the rules with `nft -c` before changing
anything and refuses uid 0. `check` exits 1 unless the rules file, boot unit and
loaded table are current, a TCP connect to `169.254.169.254:80` as the service
user is refused within a second, the IPv6 address on the default interface does
not connect, and as the service user DNS resolves and `github.com:443` connects.
`--egress HOST:PORT` picks a different reachable target. It warns when the
service account can run `sudo` without a password, because any agent could then
remove the floor. `remove` disables the unit and deletes only this table and its
files.

Confirm the rest of the ruleset is unchanged and that the service account now
fails fast:

```sh
ssh -t <host> 'sudo nft list ruleset | diff ~/nft-before.txt -'
ssh <host> 'curl -sS -m 5 http://169.254.169.254/; echo "exit $?"'
```

The diff should show only the added `agent_interface_metadata` table, and curl
should report a refused connection with exit 7, not a timeout. Three checks keep
a missing floor visible:

- App readiness reports `metadataFloor` as `fail` and returns 503 if the app
  process can connect to `169.254.169.254:80`.
- `release-app.py prepare` refuses a host where the SSH user, which is the
  service user, can connect to metadata or the boot unit is not enabled.
- `release-app.py verify` and the post-activation record step check the same
  thing as `metadataEgressFloor`.

The floor matches the socket owner's uid in the host's output hook. Traffic from
containers with their own network namespace would pass through the forward hook
instead and is not covered. Root processes, other accounts and `sudo` remain
outside it by design.

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
them with `journalctl -u <app service> -f -o cat`. Pino's `level` field is inside the JSON,
so journald priorities can't filter it; for warnings and errors only, use
`journalctl -u <app service> -o cat | jq -c 'select(.level >= 40)'`.
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
- `Could not deliver a notification`: that notification could not be processed. It
  retries like a failed send, and everything queued after it is still delivered.
- `Expired notifications`: pending notifications older than a day, matching the
  Web Push TTL, are marked `expired` instead of being sent late.
- `Readiness check degraded`, `alerting administrators`, `recovered`: see below.

`/api/health` is liveness only and always answers `{"ok":true}` while the process
runs. Deploys depend on that, including during a Hermes drain.

`/api/health/ready` returns 200 `{"ok":true}` or 503 `{"ok":false}`. It fails when:

- database: `SELECT 1` fails.
- hermes: Hermes has been disconnected for 5 minutes or longer. A Hermes update
  in progress counts as healthy.
- worker: no successful background pass for 2 minutes, after a 2-minute startup grace.
- metadataFloor: a TCP connect from the app process to `169.254.169.254:80`
  succeeded, so the [metadata egress floor](#metadata-egress-floor) is missing.
  A refusal or no answer within 1.5 seconds counts as blocked. The result is
  reused for 50 seconds, so every minute's check probes afresh. Only production
  probes; development and tests report `unconfigured`.

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

Releases and Hermes installs wait for the gateway to report no active agents.
`prepare-when-idle.py` prints which check refused and what the gateway reports on
each busy attempt. Hermes lists `active_work` only while it drains, so an empty list
is normal for a real turn.

The gateway can keep counting an agent after its turn ends. On October 22 and
November 2, 2026 it counted one with no turn records and no tool processes while the
household was idle; a restart cleared it each time. A working turn usually writes its
messages after each tool batch, but a long model call or a script-only routine can stay
silent, so silence alone never proves a leak. `prepare-when-idle.py` reports a count
that persists for 5 minutes with no message written in any profile and no live routine
run. With `--household-idle`, passed only after the household confirms nobody is
mid-conversation, Discord included, it restarts `hermes-gateway.service` once. The host
re-checks the count, messages and routine runs in the same command that restarts it.
A restart ends any real turn.

Old releases accumulate under `releases/`. The household host filled to 14 GB free
with 129 of them, below the update check's 20 GB minimum. `release-app.py activate`
now keeps the ten newest releases plus the live and previous ones, and removes the
rest.

See the [Linux installer contract](HermesUpgradeLinux.md) for host configuration
and recovery requirements. The [validation ledger](ledger/README.md) records
isolated execution separately from production activation and update checks.

## Native distribution

iOS users connect to this same HTTPS origin. Apple signing, APNs credentials and
physical-device notification acceptance are separate from hosting the web app.
The server reports push availability so the app can explain missing setup.
