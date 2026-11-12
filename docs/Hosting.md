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

Mac links are off until `shared/app.env` has `MAC_LINK_KEY` and the environment both
Hermes units load, `shared/computer.env`, has the same value as
`HERMES_AGENT_INTERFACE_MAC_LINK_KEY` plus `HERMES_AGENT_INTERFACE_APP_URL` set to the
app's loopback address. The key is its own 32-byte base64url value, never the Hermes
service key. Caddy forwards every request with `X-Forwarded-For`, which the add-on's
`/api/agent-link/mac` route refuses, so only a process on this host can call it. See
[WildBots for Mac](MacLink.md#server-setup).

The app runs its own Node binary, kept under the application directory's `runtime/`.
`agent-interface.service` names it in `ExecStart` and `PATH`. Release builds, qualification and
the guarded deploy use the same binary, recorded as `node` in each release's deploy configuration.
To change it, as [issue #210](https://github.com/NicL9923/agent-interface/issues/210) asks for
24.22.2:

1. Install the new release from nodejs.org beside the old one under `runtime/`, after checking
   the archive against the official `SHASUMS256.txt`.
2. Point the service at it with a drop-in,
   `~/.config/systemd/user/agent-interface.service.d/20-node.conf`, keeping the unit's own
   arguments:

   ```ini
   [Service]
   Environment=PATH=APP_BASE/runtime/node-vX.Y.Z-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
   ExecStart=
   ExecStart=APP_BASE/runtime/node-vX.Y.Z-linux-x64/bin/node --env-file=APP_BASE/shared/app.env --import tsx src/server/index.ts
   ```

   The empty `ExecStart=` clears the unit's own command; without it systemd refuses a second one.
   Set `PATH` here only. systemd applies an `EnvironmentFile` after `Environment=`, so a file that
   sets `PATH` would override this, and releases refuse a service that has one.
   Run `systemctl --user daemon-reload`, since a restart alone keeps the command systemd already
   loaded. Then run `systemctl --user restart agent-interface.service` and check
   `/api/health/ready`. Confirm the process runs the new binary:
   `readlink -f /proc/$(systemctl --user show -p MainPID --value agent-interface.service)/exe`.
   To roll back, remove the drop-in, then reload and restart the same way.
3. Prepare the next release with `release-app.py prepare COMMIT --node ABSOLUTE_PATH`. The
   release records the binary that path resolved to when the host built it, and qualification,
   activation and recovery run that binary even if a symlink in the path is retargeted later.

Preparation refuses a runtime outside `package.json`'s `engines`, and one the app service is not
wholly on: by real path, its running process, the `node` that process's `PATH` finds, its
`ExecStart` and the `node` its configured `PATH` finds must all be that binary, and no
`EnvironmentFile` may set `PATH`. Activation and recovery check again before they change anything, and the build
and qualification refuse when `node` on their `PATH` is any other binary. A release can't build,
qualify or deploy with a different Node than production runs.

The app has its own pinned runtime, release directories, private
configuration and SQLite database under the host user's application directory.
It listens on loopback behind Caddy. The host's global Node installation remains
available to existing services. The app sends its own Content-Security-Policy,
Permissions-Policy and HSTS headers. Caddy should pass them through rather than
add its own, because browsers enforce every policy they receive.

On `SIGINT` or `SIGTERM`, the primary listener stops accepting connections and
gives active responses 25 seconds to finish. Responses that finish during shutdown
close their connections instead of keeping them reusable. After the grace period,
the server logs the remaining connection count and destroys those sockets,
including silent TCP peers and WebSockets that did not complete their close handshake.
The worker, runtime, and store then close through the normal cleanup hooks.
A separate 30-second process watchdog still exits with failure if shutdown or
cleanup remains stuck.

Hermes keeps execution, profiles, sessions, provider credentials, tools, memory
and scheduling. Its existing dashboard process must load the integration add-on;
starting another owner against the same Hermes home is not a deployment method.
The existing Google login, dashboard address, gateway service and unrelated Caddy
routes remain in place.

The deployed Hermes revision is `ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df`
([release receipt](evidence/production-release-d1d95d7f-20261106T024133Z.json)), with
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

## Live voice plugin

Live Talk mints short-lived OpenAI Realtime client secrets on the household
ChatGPT sign-in that Hermes holds for its launch profile. Hermes lets only code
inside an installed plugin whose `plugin.yaml` declares
`requires_auth: [openai-codex]` make such a request, and it attaches the
credential itself. The app's plugin is `src/hermes/wildbots_voice`. Its
`realtime.py` makes the one request; the add-on in `src/hermes/voice.py` loads
that file through the plugins link, so the frame Hermes checks is under the
plugins folder.

The guarded activation links `<HERMES_HOME>/plugins/wildbots-voice` to
`<app base>/current/src/hermes/wildbots_voice`. The link goes through
`current`, so every later activation moves it with the release. Activation
refuses before stopping anything if that path holds a folder or another link.
It never enables the plugin. Hermes itself lets a linked plugin make the
credentialed request whether or not it is enabled, so the add-on checks the
launch profile's `plugins.enabled` and `plugins.disabled` through Hermes's own
config readers on every status check and again right before each mint. Enabling
is the consent for the plugin to use the ChatGPT sign-in, so a person does that
once on the host, then restarts the dashboard. Disabling it refuses any mint at
once. The app keeps the last status it read and answers with it without waiting,
so a message send or a page load never waits on this check. Once that copy is 30
seconds old, the next read starts a refresh in the background and still answers
with the old status; reads after the refresh see the new one. Only the first read
after the app connects to Hermes waits. A failed status check counts as
unavailable, with its reason, until the next refresh succeeds, and a disconnect
drops the copy. A Talk start between disabling and that refresh is refused with
503 by the mint check. Enable the plugin with:

```sh
hermes plugins enable wildbots-voice
systemctl --user restart hermes-dashboard.service
```

The launch profile must be signed in to ChatGPT (`openai-codex`) in Hermes.
`POST /api/agent-interface/voice/status` on the service bridge reports
`{available, reason}`, and the app shows the reason in place of Talk:

| Reason | Meaning and fix |
| --- | --- |
| The plugin is not linked into Hermes | The link is missing. Activate a current release. |
| The plugin link is broken | The link's target is gone, usually a pruned release. Activate a current release. |
| The plugin links to a different release | The link resolves to another release than the running add-on. Activate the current release again. |
| The plugin manifest does not ask for the ChatGPT sign-in | The linked `plugin.yaml` lost `requires_auth`. Restore the release. |
| Enable the wildbots-voice plugin in Hermes | The launch profile's config does not enable it, disables it, or cannot be read. Run the enable command above. |
| This Hermes version cannot share its ChatGPT sign-in | Hermes lacks `hermes_cli.plugin_provider_requests`. Update Hermes. |

Status does not contact OpenAI or refresh the sign-in. Starting Talk can still
fail: signed out of ChatGPT answers 409 with "Sign in to ChatGPT in Hermes", a
plugin disabled since the last status check or refused by Hermes answers 503
with the enable command, and an OpenAI error answers 502 with only its HTTP status. No
secret or upstream body is logged or returned.

The browser sends its WebRTC offer straight to `https://api.openai.com`, which
the document Content-Security-Policy allows in `connect-src`. Caddy needs no
change.

### Talk reasoning effort

A spoken request that starts a new turn is sent to Hermes with `voice_turn: true`.
Hermes then runs that turn on its `auxiliary.voice_chat` route, which sets the
turn's reasoning effort and can name a faster model. A request that joins a
running turn changes nothing about that turn. Hermes's default effort for the
route is `none`. The household sets `low` in every profile, because spoken requests
still use tools. Hermes reads it at the start of each turn, so no restart is needed:

```sh
for home in ~/.hermes ~/.hermes/profiles/*; do
  HERMES_HOME="$home" hermes config set auxiliary.voice_chat.reasoning_effort low
done
```

Leaving `auxiliary.voice_chat.model` unset keeps the assistant's own model. An
add-on older than this flag ignores it, and Talk turns run at the profile's effort.

## Pages open across a deploy

A page that opened under one release keeps asking for that release's hashed `/assets/` files after a
deploy replaces it, and a lazy screen whose file is gone shows "This screen could not load". So the
guarded activation names the release it replaces: `Deployment.switch` in `.agents/tools/deploy_common.py`
writes `dist/previous-release.json` into the release going live, `{"assets": "<previous release>/dist/client/assets"}`,
before it moves `current`. The app reads that file when it starts, from beside the `dist/client` it
serves (the same base, so the two cannot name different `dist` directories). A request for a hashed name
(`assets/<name>-<8 characters>.<ext>`) that the live release lacks is answered from that directory, with
the same `immutable` cache headers as a live asset. Anything else still gets the uncached 404.

- Only a regular file directly inside that directory is served. A hashed name holds no slash, so a path
  cannot climb out, and a link that resolves outside the directory is refused.
- One release of grace. Each activation, a rollback included, names the release it replaced, and
  `release-app.py` keeps the rollback target, so the directory is there for as long as it is named. A pruned
  directory, a missing file or a malformed one only means no grace: the app starts, logs a warning for a
  malformed file and answers 404 as before.
- Nothing to configure on the host. The file comes from the release tooling, never from a guessed path,
  and a failed write to it never stops a cutover (the tool logs it).

Compression: the app does not compress anything (`@fastify/compress` is not installed, and the static
plugin serves no precompressed files). The JavaScript bundle is compressed in production only if Caddy
has an `encode` directive for this site. This repository holds no Caddyfile, so that is not checked here.
On the host, `curl -sI -H 'Accept-Encoding: gzip, br' https://APP_ORIGIN/assets/NAME.js` shows a
`Content-Encoding` header when it is on. `src/server/event-stream.ts` sends `Content-Encoding: identity`
on its event streams so that an `encode` directive leaves them uncompressed, which assumes one exists.

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
link-local `fe80::a9fe:a9fe`. TCP gets a reset, and everything else gets
admin-prohibited, so clients fail at once instead of hanging. Only those two
addresses are blocked. The rest of `169.254.0.0/16` stays reachable, and root,
including cloud-init, is not affected. The rules file loads only its own table in
one transaction and never flushes the ruleset, so ufw's iptables-nft rules stay
untouched.

`install` puts the floor in place five ways:

- The rules live in root-owned `/etc/nftables.d/agent-interface-metadata.nft`.
- When `/etc/nftables.conf` exists, a marked block at its end includes that file.
  Ubuntu's `nftables.conf` starts with `flush ruleset`, so the floor then loads in
  the same transaction as the flush, and any `nftables.service` start, restart or
  reload brings it back with no gap. The tool backs up the original file once to
  `/etc/nftables.conf.agent-interface.bak` and checks the edited file with
  `nft -c` before writing it. The markers are exact whole lines. The same text
  inside another line is ordinary content. The tool edits the file only when it
  holds no markers, or exactly one BEGIN line followed by one END line, and then
  removes exactly those lines. Otherwise it refuses and changes nothing, so a
  damaged or quoted marker can never make it delete other rules.
- Debian's `nftables.service` stops with a bare `nft flush ruleset`, and a
  restart stops it first. A managed drop-in,
  `/etc/systemd/system/nftables.service.d/agent-interface-metadata-floor.conf`,
  clears that `ExecStop=`. It runs `nft -f /etc/agent-interface/nftables-stop.nft`
  instead, which holds `flush ruleset` and an include of the floor file. The flush
  and the floor commit as one transaction, so no packet passes between them, and
  a stopped nftables leaves only the floor loaded. The stop file is checked with
  `nft -c` at install. It lives outside `/etc/nftables.d`, so a wildcard include
  there can never load its flush.
- The root oneshot `agent-interface-metadata-floor.service` loads the rules at boot
  either way, after `nftables.service` and `ufw.service`. It does not follow
  `nftables.service`: the include already covers that, and following it would
  carry an nftables restart into the household services. `RefuseManualStop=yes`
  blocks `systemctl stop` and `restart` of the unit. Reapply it with
  `systemctl reload`.
- A drop-in makes the service account's systemd manager, `user@UID.service`,
  require that unit and start after it.
- A sudo rule lets the service account run exactly
  `nft -j list table inet agent_interface_metadata`, read-only, so release checks
  can compare the live rules.

**The drop-in fails closed.** If the floor cannot load at boot, the service
account's manager does not start, and Hermes, the app and the shared browser stay
down. Find the cause with `sudo journalctl -b -u agent-interface-metadata-floor`,
fix it, then run
`sudo systemctl start agent-interface-metadata-floor.service user@UID.service`.
SSH sign-in and `sudo` for that account should still work without its manager,
but that is untested here, so keep the provider's console as the fallback. In an
emergency, `sudo metadata-egress-floor.py remove`, or deleting
`/etc/systemd/system/user@UID.service.d/agent-interface-metadata-floor.conf` and
running `systemctl daemon-reload`, starts the services without the floor.

Install it before preparing a release, from any checkout that has the tool. Before
the first release that carries it, copy the tool from the merged commit:

```sh
git show origin/main:.agents/tools/metadata-egress-floor.py | ssh <host> 'umask 077 && cat > ~/metadata-egress-floor.py'
ssh -t <host> 'sudo systemctl is-enabled nftables.service ufw.service; sudo nft list ruleset > ~/nft-before.txt'
ssh -t <host> 'sudo python3 ~/metadata-egress-floor.py install --user <service user>'
ssh -t <host> 'sudo python3 ~/metadata-egress-floor.py check --user <service user>'
```

Install is idempotent. A rerun rewrites nothing unless the uid changed, then
reloads the table, and it never restarts the unit. It checks the rules with
`nft -c` and the sudo rule with `visudo -c` before anything goes live, and it
refuses uid 0. `check` reports `mode.persistence`, either
`nftables.conf include and boot unit` or `boot unit only`. It exits 1 unless all
of these hold:

- The installed files are current.
- `nftables.conf` includes the floor last whenever that file exists or
  `nftables.service` is enabled.
- The unit is enabled and active, and the user manager requires it.
- The live table, read with `nft -j`, has exactly the expected uid, addresses,
  output hook and reject verdicts.
- As the service user, `169.254.169.254:80` is refused within a second, and
  `fe80::a9fe:a9fe` is refused on every interface with a link-local address,
  unless that interface has no route.
- DNS resolves and `github.com:443` connects. `--egress HOST:PORT` picks a
  different target.

Only a fast `ECONNREFUSED`, `EACCES`, `EPERM` or `EHOSTUNREACH` proves the floor.
A timeout, a slow error or anything else, such as `EMFILE`, is inconclusive and
fails. `check` warns when the service account can run `sudo` without a password,
because any agent could then remove the floor. `remove` drops the user-manager
requirement first, then the include, the table and the tool's files. It finds
every managed `user@*.service.d` drop-in by name rather than trusting the rules
file, so it also works when that file is missing. It never stops a unit.

When this was written, the household host had `nftables.service` disabled, so
the boot unit is what loads the floor there. The include and the stop file only
take effect if nftables is enabled later. None of this stops root: an
administrator can still delete the table on purpose, and readiness and release
checks report it when that happens.

Confirm the rest of the ruleset is unchanged and that the service account now
fails fast:

```sh
ssh -t <host> 'sudo nft list ruleset | diff ~/nft-before.txt -'
ssh <host> 'curl -sS -m 5 http://169.254.169.254/; echo "exit $?"'
```

The diff should show only the added `agent_interface_metadata` table, and curl
should report a refused connection with exit 7, not a timeout. Three checks keep
a missing floor visible:

- App readiness reports `metadataFloor` as `fail` and returns 503 unless every
  metadata attempt from the app process is explicitly refused.
- `release-app.py prepare` refuses the host unless the floor is enforcing live.
  That means the unit is enabled and active, the user manager requires it, the
  live rules match, and metadata is refused on IPv4 and on each link-local IPv6
  interface. The check runs as the SSH user, which is the service user.
- `release-app.py verify` and the post-activation record step check the same
  thing as `metadataEgressFloor`.

### Limits

The floor matches the uid that owns each socket, in the host's output hook. It
does not cover:

- A relay that runs as root or as another account and accepts connections from
  the service account, such as an open forward proxy on loopback. The relay's own
  connection to metadata is not the service account's.
- Containers with their own network namespace, whose traffic passes through the
  forward hook instead.
- Root processes, other accounts and anything run through `sudo`.

The host documentation lists Caddy, which runs as its own account, as a reverse
proxy to fixed upstreams. That makes it not an open relay. It also lists WireGuard
and the Hermes services, which run as the service account and are inside the
floor. It documents no forward proxy or container runtime. This repository cannot
prove that none exist, so review the listeners after installing:
`sudo ss -ltnup | grep -v 'users:(("<service user>"'`.

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
- metadataFloor: the app process connected to metadata, so the
  [metadata egress floor](#metadata-egress-floor) is missing, or could not
  confirm the floor. It tries `169.254.169.254:80` and `fe80::a9fe:a9fe` on each
  interface with a link-local address. Only `ECONNREFUSED`, `EACCES`, `EPERM` or
  `EHOSTUNREACH` within a second counts as refused. A timeout, `EMFILE` or any
  other error fails as inconclusive, except that a link-local interface with no
  route passes. The result is reused for 50 seconds, so every minute's check
  probes afresh. Only production probes; development and tests report
  `unconfigured`.

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

## Idle compaction

The add-on compacts each assistant's Bot Chat in the background once it has been idle
for 10 minutes and its next request would be larger than Hermes's own compaction target.
Smaller requests answer faster. Nobody waits on it: a message, a routine delivery, a goal
change or a maintenance lease stops a running compaction first. A message from another
Hermes client that queues behind it stops it too. See
[Idle compaction](HermesCapabilityMatrix.md#idle-compaction) for the rules and evidence.

It is on by default. To change the delay or turn it off, set this in
`shared/hermes-service.env`, the environment file the dashboard unit loads, then restart
the dashboard:

```sh
HERMES_AGENT_INTERFACE_IDLE_COMPACT_SECONDS=0    # off; any other whole number is the idle delay
```

A value that is not a whole number turns it off and logs an error. Hermes revisions
before `ed1afb0` never compact this way, because their manual compaction did not hold
the session (Hermes #133504). `agent-interface.capabilities` reports the delay in effect
as `idle_compaction_seconds`, and 0 when it is off. Hermes's own
`compression.idle_compact_after_seconds` stays 0: it compacts at the start of the next
turn, so a person would wait for it.

## History projection memo

An app open reads the assistant's whole history from Hermes, and Hermes projects every row for
display. During a turn the decorated-history cache is off, so a long chat paid that projection on
every open. The add-on cuts the history where Hermes's projection carries nothing across, at user
rows no later tool row reads a call from before, and keeps each piece's projection for the next open.
A piece whose rows, configuration, redaction state and projection arguments are unchanged reuses its
projection; only changed and new pieces are projected again. Every memo in the gateway keeps its pieces
within one budget of 192 million characters of rows, projections and tool rows (`PROJECTION_BUDGET` in
`src/hermes/extension.py`); when they pass it, the memo used least recently empties. A new stored session
starts empty. The longest chat measured, 8,021 rows, keeps 114 million characters, about 110 MB of the
gateway's memory. Without readable redaction state nothing is kept.

A restart empties every memo. The first open after one resumes the session through its memo, with image
URLs as every later open projects them, so the second open reuses what the first projected. A background
warm-up also starts two seconds after the add-on installs. It reads the canonical "Bot Chat" of the six
assistants with the most recent app sends, read-only from each profile's `state.db`, and projects each into
the memo its first open adopts, with that chat's journal tool records parsed. It works a piece at a time
under the assistant's open lock, and lets go whenever an open, an app request or send, or a native turn or
queued input appears, keeping what it did; the open takes over from there. A routine or bot delivery
counts as an open. It never takes room another memo holds and stops at the first chat that does not fit.
Its memos rank below every memo an open used, so they empty first, and a warmed chat nobody opened is
dropped whole once its memo empties. An assistant whose store cannot be read is skipped. It logs one line
with counts and seconds, and per skipped assistant its name and the exception type, never history. On the longest chat this cut the first open's add-on work from 7.5 s to 1.6 s
(`docs/ledger/20261112T161203Z-history-warm-up.md`). A Hermes without the reads it needs
(`SessionDB.get_messages_as_conversation` with compacted rows, `get_session_by_title`,
`get_compression_tip`, `hermes_cli.profiles.get_profile_dir`, its compaction display projection or
readable redaction state) logs one warning naming them and warms nothing. To turn it off, set this in
`shared/hermes-service.env` and restart the gateway:

```sh
HERMES_AGENT_INTERFACE_WARM_HISTORY=0    # off; anything else, or unset, is on
```

Shadow mode projects each open's history whole as well, answers with the whole projection, and logs a
warning with the first message and tool row where the memoized projection differed. Each open that
projected history also reports `app_projection_shadow`: pieces, pieces reused, and the two differences.
Release qualification runs with it on (`scripts/spike/run.py`). To turn it on in production, add this
to the dashboard's environment and restart it; it doubles the projection cost of every open:

```sh
HERMES_AGENT_INTERFACE_PROJECTION_SHADOW=1    # off unless exactly 1
```

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
