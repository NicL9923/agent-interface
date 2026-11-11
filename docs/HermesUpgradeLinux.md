# Linux Hermes upgrade hooks

The web and iOS update buttons use an installer-owned worker. The Linux hook in
`scripts/hermes-upgrade-linux.py` supports one Hermes home, one managed source
checkout, and the existing dashboard and gateway user services. It leaves the app
service running so stopping Hermes cannot kill the upgrade worker.

The managed-runtime mode builds a separate candidate dependency generation before
qualification. It copies the enabled plugin dependency sources and recorded
extras into an isolated home. The installed native interpreter and dependency
content must match that tested generation before services restart. The simpler
worker mode supports only unchanged dependency inputs and refuses other targets.

Detached workers address the current Unix user's systemd bus at
`/run/user/UID/bus`; they do not require a login shell's environment. Runtime
fingerprints include dependencies exposed by the selected PM generation's `.pth`
files. Duplicate source-tree `egg-info` is excluded only when the generation
attests the same editable package through installed `RECORD` metadata. PM's
editable workspace snapshots retain both source identity and tree-byte checks.

The candidate checkout has its own complete Git object store. The worker fetches
the exact candidate SHA and the installed tag object identities from official
Hermes upstream. It copies no object alternates or partial-clone settings from
the live checkout. Full ancestry and the same tags preserve native version and
plugin compatibility decisions. A shallow installed checkout requires installer
repair before qualification. The qualification record binds these history and tag facts, so
changing them requires a fresh check.

## Private configuration

Keep both configuration files owned by the app/service user with mode `0600`.
Keep the state and staging directories at `0700`. Staging must be outside the
live Hermes home, including its recovery archives. Paths below are placeholders.
At setup, copy the actual managed interpreter paths from the host's native launcher
and PM selection. Do not substitute the retired in-tree venv or a system Python.
Hermes updates move the store interpreter between tool versions. The helpers then
refresh these paths themselves, as [interpreter paths](#interpreter-paths) describes.

The platform configuration can live at
`/home/installer/.config/agent-interface/hermes-linux.json`:

```json
{
  "source": "/home/installer/.hermes/hermes-agent",
  "hermesHome": "/home/installer/.hermes",
  "managedLauncher": "/home/installer/.hermes/hermes-agent/.hermes/bin/hermes",
  "managedPython": "/home/installer/.hermes/tools/python/EXACT_TOOL_VERSION/bin/python3",
  "serviceEnvFile": "/home/installer/.config/agent-interface/hermes-service.env",
  "qualificationReceipt": "/home/installer/.config/agent-interface/hermes-qualified.json",
  "maintenanceFile": "/home/installer/.hermes/agent-interface-maintenance.json",
  "stageRoot": "/home/installer/.local/share/agent-interface-upgrades/stages",
  "systemctl": "/usr/bin/systemctl",
  "dashboardUnit": "hermes-dashboard.service",
  "gatewayUnit": "hermes-gateway.service",
  "appUnit": "agent-interface.service",
  "dashboardPort": 9119,
  "dashboardOrigin": "http://127.0.0.1:9119",
  "discordConnections": ["discord", "second-profile:discord"],
  "drainAcknowledgeSeconds": 15,
  "gatewayStartSeconds": 120,
  "verificationSeconds": 120,
  "regressionPython": "/usr/bin/python3",
  "regressionCommands": {
    "sharedOAuth": ["/usr/bin/python3", "/home/installer/private-tests/shared-oauth.py"],
    "googleAuth": ["/usr/bin/python3", "/home/installer/private-tests/google-auth.py"]
  },
  "googleVerificationCommand": ["/usr/bin/python3", "/home/installer/private-tests/live-google-check.py"]
}
```

The two Discord keys must match the native `gateway_state.json` platform keys.
Regression commands must be Python argv whose first entry matches the fixed
`regressionPython`. The hook replaces that entry with the qualified candidate
interpreter, including its staged dependencies. Fixtures use
`HERMES_UPGRADE_STAGE_SOURCE`. Their `HERMES_HOME` points at a disposable directory;
they must not refresh live model-provider OAuth grants. Both the shared OAuth
multiprocess repair tests and the installed Google allowlist plugin tests are
required. The repository cannot supply the host's private plugin or session.

The fixed Google verification command reads an existing session from a private
file or stdin. It checks authenticated HTTP and a newly connected, freshly
issued-ticket WebSocket through the original Google authentication path. It must
print exactly this JSON and exit successfully only when both checks pass:

```json
{"authenticatedHttp": true, "freshWebsocket": true}
```

It must never print session values, refresh tokens, cookies, or ticket values.
The helper separately checks that anonymous `/api/config` and `/api/profiles`
requests fail and that both original Discord connections return to `connected`.

The service environment file must already be loaded by the existing dashboard
unit and contain these bare assignments:

```dotenv
HERMES_AGENT_INTERFACE_TOKEN=GENERATED_32_BYTE_BASE64URL_KEY
HERMES_AGENT_INTERFACE_MAINTENANCE_FILE=/home/installer/.hermes/agent-interface-maintenance.json
```

The helper reads the token locally. It uses a direct loopback service ticket and
passes the key to the native maintenance request through stdin. Neither the
browser nor a public admin command receives it. A missing maintenance extension,
wrong service configuration, or unavailable native work record stops the upgrade.

## Interpreter paths

A Hermes update can move the native store interpreter. The Oct 30, 2026 update
moved it from Python 3.14.7 to 3.14.9 while the host configuration still named
3.14.7. So `managedPython` is not authoritative for an operation's checks.

Each operation asks the native launcher for its interpreter when maintenance
starts. The helper requires it inside `HERMES_HOME/tools` and records it in the
operation's platform record. Later hooks at the original revision compare the
launcher's answer with that record, so a change during the operation still stops
it. Native PM sync runs in the recorded interpreter. A record from an older helper
has none; sync then uses `managedPython`, and the tool store still bounds the check.

After `finish` releases maintenance, the platform helper asks the launcher again.
It points every string value that names a Python 3 interpreter inside the tool store
at the launcher's answer, whichever version it named before. That covers
`managedPython`, `regressionPython` and regression argv entries, so positions left
on different old versions all follow. Other tool-store binaries, such as Chromium,
stay as they are. It checks the result as it checks any configuration, then
atomically rewrites the file with mode `0600`. After a rollback the launcher reports the
restored interpreter, and the file follows it. The worker does the same for
`qualificationPython` and its hook argv after a released install, a restored
install or a recovery. Both refreshes replace only tool-store paths, so a system
bootstrap interpreter stays as configured. They are best-effort and write to the
update's private log. A failed refresh never fails an update that already succeeded.

The rewritten files change the host fingerprint. The next check binds it afresh, and
a release prepared before the refresh must be prepared again.

## Persistent gateway gate

Before enabling upgrades, the installer must add a source-side
`agent_interface_gateway.py` symlink to `src/hermes/gateway_guard.py` in the app
release. Bind that managed link in the worker configuration alongside the existing
dashboard link. Keep the gateway unit's existing native arguments and change only
its entry module:

```text
/home/installer/.hermes/hermes-agent/.hermes/bin/hermes --run-module agent_interface_gateway
```

The wrapper reexecutes the selected native store interpreter into the original
`gateway/run.py` in the same process. Hermes' process identity checks therefore
recognize the gateway owner, and the existing native arguments keep their meaning.
The gateway unit must receive the same fixed
`HERMES_AGENT_INTERFACE_MAINTENANCE_FILE` path as the dashboard. The wrapper checks
the source qualification, closes native admission before adapters and cron start,
and retains the gate when the ordinary drain marker expires or the host reboots.
It defers native startup resumes while maintenance is held. Existing native
execution, lifecycle, and shutdown remain with Hermes.

The guard also fences idle commands and internal messages before native preflight.
Its status stamp counts inbound calls that already entered preflight; the helper
requires that count and native active work to reach zero before stopping services.
The helper requires a guard stamp in the active gateway status record. It refuses
to stop an unwrapped gateway. Malformed or unreadable lease files keep admission
closed until the installer repairs them.

## Worker hooks

Use fixed absolute argv in the private worker configuration. The hook shape is:

```json
[
  "/usr/bin/python3",
  "/home/installer/apps/agent-interface/scripts/hermes-upgrade-linux.py",
  "--config",
  "/home/installer/.config/agent-interface/hermes-linux.json",
  "quiescence"
]
```

Use that shape for `quiescence`, `backup`, `install`, `verify`, `rollback`, and
`finish`. The worker's `regressions` setting is a list containing one argv with
its final argument set to `regressions`. Configure its `source`, `stageRoot`, and
`qualificationReceipt` to match the platform file. Set worker `managedLauncher` and `managedHome` to the same native launcher and
shared home to enable isolated PM qualification. Keep `qualificationPython` as
the trusted Python 3.14 bootstrap interpreter, not an activated dependency
generation. The worker then creates a candidate launcher
in the marked staging directory and binds its interpreter and dependency content
fingerprint. The platform helper compares the actual installed native generation
with that fingerprint after PM sync and after restart.

List indirectly referenced private regression scripts and the Google verification
script in worker `qualificationFiles`. Their exact bytes must remain unchanged
between qualification and install. The worker also binds its configuration,
platform helper, and directly referenced hook files.

The app starts the worker as its own transient systemd user unit when it runs
under systemd, through `systemd-run --user`. The app's service has a private
`/tmp`, which a user manager builds from a user namespace. On hosts that restrict
unprivileged user namespaces through AppArmor, a sandboxed Chrome started inside
that namespace aborts, so a worker started as the app's child would always fail
the local-network probe. Started outside the app's namespace and cgroup, the worker
also keeps running if the app restarts. Without systemd the app spawns it directly.

On a host that requires a specific sandboxed browser for the local-network probe,
qualify the app release with `--computer-probe-browser /absolute/direct/ELF`.
The receipt's optional `computerProbeBrowser` metadata carries that selection
through controlled activation and later in-app updates. The worker reads the
owner-private deployed receipt and checks the requested path, canonical executable
and a fresh content hash for every qualification. A browser update between checks
can change the hash at the same canonical path. Missing files, launcher scripts,
malformed metadata and retargeted symlinks stop the check. Changes during a check
prevent a receipt; changes before install require another check. The install
also checks after backup and verification, before reopening work. Other probes
keep the pinned PM Chromium. Older receipts without this metadata keep their
existing default. There is no additional worker setting.

For an installation with an approved source repair, save the original
`git diff HEAD --binary` bytes in an owner-only immutable file. Set worker
`approvedPatchFile` to that absolute path and `requiredPatchSha256` to its SHA256.
The worker proves that applying those exact bytes to the current upstream tree
produces the installed tracked tree. Temporary indices and object stores leave
the installed Git index, working files and objects alone. Extra local edits fail
that proof.

The candidate receives the same original patch bytes. Its resulting Git diff can
have different line numbers and blob IDs after upstream edits; the qualification
record binds that candidate fingerprint separately from the current fingerprint.
The native receipt and installation use the candidate fingerprint. Rollback uses
the original installed fingerprint. A configuration without `approvedPatchFile`
keeps the stricter requirement that the current diff's raw SHA match the configured
repair SHA.

Upstream sometimes edits lines beside the repair, for example a linter rewriting
a signature directly above a repaired import. Git's patch and three-way merge both
refuse that. With an approved artifact, the worker then merges line by line from
the installed upstream file, the installed repaired file and the candidate file:

- A repair edit that replaces lines applies only if those exact lines survive
  unchanged and contiguous in the candidate.
- An insertion needs both neighboring lines unchanged and still adjacent.
- Each edit also needs an unchanged line within three lines on each side at the
  same relative offset, or the file boundary at the same distance.
- The edited block with a line of context must be unique in both files, and the
  replaced lines must appear exactly once upstream.
- Added repair files may not collide with a different upstream file.
- Deletions, mode changes, binary edits and conflicting upstream edits still
  require review.

The merged candidate must have exactly the approved repair's added and removed
lines, per file and in order. It still runs the full host regression suite before
it can be installed. The staging check notes when this happened.

The original artifact may no longer apply to a merged tree, so the qualification
receipt records `repairArtifactSha256`, the approved artifact it was proven
against. The next update accepts a merged installation only when the deployed
receipt binds that exact installed revision and repair hash to the configured
artifact, and its changed lines still match. App release qualification carries
the binding forward after the same proof. Diffs are parsed by hunk counts, so
payload lines that look like file headers are still compared. App release
qualification rebuilds its disposable checkout from the installed, proven repair
rather than the original artifact.

These rules stop accidental misplacement. They do not defend against a hostile
upstream that deliberately copies a repaired function and rewrites the original.
Upstream code already runs with full privileges once installed, so trust in the
official repository is the boundary. The host regression suite exists to catch a
repair that no longer takes effect.

## Intermittent integration failures

The real integration suite starts a gateway, provider and many probes, and a
probe can occasionally fail for timing reasons. When the suite fails, the worker
reruns it once in fresh isolated homes. A pass on the rerun counts, but the
integration check says it needed one and both runs stay in the private log. A
second failure fails the check. The qualified Python helper prints the full
traceback for any wrapped error, so a one-line failure such as
`Permission denied: '/'` can be traced from the log.

## Cutover and recovery

The quiescence hook takes the persistent native dashboard admission gate and
requests the reversible native gateway drain. It requires a new drain
acknowledgement from the current systemd process, its exact code SHA and home,
and zero native chat, cron, API, or deferred work. Active or unknown work blocks
shutdown. Exit code `75` means the hook proved that its gate and drain were
released and that source, settings, and service processes stayed unchanged.
A failed baseline also exits `75`: those checks run before the gate is taken and
change no Hermes source, setting or service. They include reading the private
service key and finding no existing `.drain_request.json`. Renew that session with `.agents/tools/renew-google-verification-session.py`. On Nov 6, 2026 an expired Google verification session failed
the baseline, the hook reported it as an interrupted install, and the app refused
chat sends until the record was reviewed by hand. The hook writes the refusal's
cause to the private log. Other failures keep maintenance closed for installer review.

Exit `75` after the gate request also needs the add-on's acquire handler to have
returned, since a release cannot remove a lease the handler writes afterwards. The
handler first refuses at once, without stopping anything, if the request would be refused
anyway. Otherwise it stops each running idle compaction, one at a time for up to 30 s
each, so the hook waits up to 120 s for its answer. The add-on also accepts a `deadline`
on acquire, the seconds the caller will wait, and writes no lease after it passes; it
reports that as `maintenance_deadline` in its capabilities. The deadline starts when the
handler starts, after the request crossed the socket, so a caller sends less than its own
read timeout, with a margin of a few seconds, or a lease can still land just after it gave up. The hook does not send one yet, so
everything below still applies to an acquire the hook gave up on. A request fails in one of three
ways, and the hook reads each differently. The add-on answered with an error: its
handler returned. The service ticket or the socket failed before the request was
sent: the add-on never saw it. Or no answer came back after the request may have
reached it: the handler can still be running, and an acquire handler can still
write the lease. Each way the acquire ends:

| Acquire ends with | Hook | `platform.json` phase | Lease | The app shows |
| --- | --- | --- | --- | --- |
| This operation's lease, no busy work | Drains the gateway and continues | `quiescent` | Held | The install continues |
| The add-on's exact busy answer | Releases, proves nothing changed, exits `75` | `rejected` | None | Stopped before installation, Hermes open |
| A success answer that fails the hook's checks | Releases, proves nothing changed, exits `75` | `rejected` | None | Stopped before installation, Hermes open |
| The service ticket or the socket failed before the request was sent | Releases, proves nothing changed, exits `75`; a release that also fails exits `1` | `rejected`, or `acquiring` after the `1` | None | Stopped before installation, Hermes open; or failed, held for review |
| Any other error answer | Exits `1` without a release; the log names the error code | `acquiring` | None from this operation | Failed, held for review |
| No answer, then this operation's lease within five minutes | Releases, proves nothing changed, exits `75` | `rejected` | None | Stopped before installation, Hermes open |
| No answer, and by then no lease, or a lease that names another operation or cannot be read | Exits `76` without a release, and never touches that lease | `acquire_unanswered` | None yet, or another operation's | Failed, held: "Hermes did not answer the request to pause…" |

A failed ticket or connection that fails the same way for the release (a wrong
service key, a dashboard that is down) exits `1` at once, with no five-minute
watch. After a lease, a failed drain, active work or a slow drain acknowledgement
also releases and exits `75`. A protected setting or the source changing while the gate
was requested is released but still exits `1`, because live state changed. A release
with no answer exits `1` and keeps maintenance closed. The worker treats `76` like
any held failure, with the message above. The hook does not release after an
unanswered acquire: if the lease appears later, the app's Cancel restores Hermes
under it and releases it through the verified recovery path. See "Unanswered
maintenance acquire" below for what to do when no lease appears.

A failed cold backup
names its cause before restarting the services, and a restarted gateway gets
`gatewayStartSeconds` to report, so a slow start cannot hide the original failure.
Verification allows a just-started gateway its whole `verificationSeconds`.

After quiescence, the backup hook stops the gateway and dashboard and creates
private cold archives of source, Git branch/configuration, and the shared home.
Before stopping either service, the helper checks that it can read every file both
archives will include, so an unreadable file such as a root-owned operation copy fails
without downtime. It then imports the qualified candidate's
reachable Git objects from staging into the installed object store and proves
they can be read without upstream access. The regressions check already made
the same transfer while the household worked normally, so after the drain the
backup copies only what changed since. A candidate far ahead of the installed
revision can lack over 100,000 objects, which took about five minutes to pack and
index on the Hermes host. A timeout names the command that ran out of time, never
its arguments. This bounded private pack transfer
changes no installed branches, tags, Git configuration, index, or working files.
It avoids fetching missing objects during checkout while Hermes is offline.
The install hook checks out the already-qualified SHA, applies the identical
OAuth repair, including staged additions in Git's index. The worker holds and
refreshes the native update lock from before quiescence through finish or verified
rollback. Platform children borrow that ownership through
`HERMES_UPDATE_HANDOFF_PID` and call native PM dependency sync directly. The
transaction refuses to evict enabled plugins. It avoids the CLI's automatic
update tail, fetching a moving branch, and automatic stash restoration. Settings hashes include model defaults,
disabled skills, profile environment files, the Google plugin, and service keys.
Verification also checks the existing user unit files and actual managed runtime.

If verification fails, rollback checks archive hashes before replacing source.
It restores the old Git checkout, repair, launchers, managed dependency generations,
and tool selection. It restores the recorded static profile settings and plugin files. Current
sessions and rotating OAuth grants stay in place. The cold home archive is recovery evidence and never gets
replayed wholesale over refreshed credentials. Failed rollback verification
keeps the gate closed and requires installer review.

The final hook releases admission only after verification succeeds. The private
worker record remains the source of update progress. Temporary-host tests exercise
source cutover, cold archives, native service control, active-work refusal,
rollback, and token preservation. They do not establish a live deployment receipt.

Run them with:

```sh
python3 -m unittest discover -s tests -p hermes_upgrade_linux_test.py
```


## Failed updates and recovery controls

The administrator can retry a failed check, cancel an update, or restart Hermes
services during a recoverable failed installation. Both clients use
`POST /api/hermes/upgrade/control` with `action`, the displayed `operationId`, and
a UUID `requestId`. Actions are `retry`, `cancel`, and `restart_service`. The API
returns `canRetry`, `canCancel`, and `canRestartService`; clients show only the
actions permitted by the saved record. A stale operation ID cannot control a
newer update. Reusing a request ID reconciles that request, including a worker
that failed to start.

Retry restores and verifies the previous installation when maintenance is held,
then starts a fresh qualification with a new operation ID. It does not replay an
installation. Restart services keeps the recorded installed or restored source,
restarts the existing Hermes user units under the owned gate, verifies the source,
runtime, sign-in and connections, then releases maintenance. The app unit keeps
running.

Cancellation is cooperative. The worker finishes the current fixed command and
checks the saved cancellation intent at its next safe boundary. Clients report
that wait. Cancellation during qualification leaves the live installation alone.
During installation it restores the saved baseline when necessary, verifies it,
and releases maintenance. Once admission release starts, the worker completes
that release; it does not guess whether stopping Hermes would interrupt newly
admitted work.

The worker saves the original qualification receipt and installation intents in
`recovery.json` before its first host hook. The platform saves its baseline,
archive hashes and phase in `platform.json`, including a release intent before
opening admission. A detached worker holds `worker.lock`; its hook processes
inherit the lock so a surviving hook blocks a competing recovery after the worker
dies. A separate guardian owns and refreshes the native Hermes update marker. A
pipe inherited by the worker and its hooks keeps that guardian alive until every
hook exits, so an external native updater cannot claim a dead worker's marker. An app restart reads those files and never installs an update automatically.
An interrupted control remains recoverable with the same request ID or a new
explicit action after the worker is gone.

The existing fixed Linux `finish` hook enables recovery automatically when its
argv names `scripts/hermes-upgrade-linux.py`. The worker uses that same argv with
`recover` or `restart_service` as the final action. Other installer hooks must
provide fixed `hooks.recover` and `hooks.restart_service` argv to enable recovery.
Recovery rejects changed service identities, active or unknown native work, lost
gate ownership, incomplete archives, and uncertain admission release. These
failures leave maintenance closed.

Older interrupted installations may have a saved platform baseline but no saved
original qualification receipt. Service recovery can verify the installed source
when its exact deployed receipt still exists. Restoring the baseline also requires
its original receipt, bound to that source and the current integration digest.
The worker never manufactures qualification evidence. Missing evidence or an
ambiguous release requires installer review. Updating the app's qualification
inputs requires new real integration evidence before enabling host recovery.

Repair hashes cover `git diff HEAD --binary` text. Every helper, worker and release tool
pins `core.abbrev=10`, the length all recorded hashes used, so a growing object store or a
local Git setting cannot change a hash for identical content. Release preparation points
the worker's hooks at the new release's platform helper, the same file activation checks
against `fixedHelperSha256`.

The staged candidate also receives what a live reset keeps outside Git: gitignored build
output such as the dashboard's `web_dist`, and directories an older revision left behind.
Hermes's package manager snapshots both into its editable workspace, and setuptools records
those directories as namespace packages, so without them a qualified runtime never matches the
installed one. Caches, `.hermes`, `venv` and the names the snapshot itself skips are not
copied. An ignored Python file or link requires installer review, except inside a Hermes product
build: `ui-tui/dist` or `hermes_cli/web_dist`, untracked and holding a `hermes-build.json` receipt
for that product with its source and output hashes. The TUI copies its tracked helper scripts there. Hermes rebuilds such output when its receipt no longer
matches the tracked sources, so its code never runs unqualified. On Oct 13, 2026 this was
proven by rebuilding the installed revision this way: its fingerprint equalled the live one.

Disk space is checked twice before it can matter. A check refuses to stage without
`minimumFreeBytes` free (20 GB by default), after removing older stages: the two newest probe
stages and the newest install stage, the latest recovery point, are kept, along with any stage
a pending install or open maintenance window needs. The cold backup totals what both archives
will read and refuses, before stopping Hermes, unless that much plus `backupReserveBytes` (5 GB)
is free. If a backup still fails, Hermes is restarted before anything is written, because a full
disk can make even logging fail. On Oct 13, 2026 a backup filled the disk with services stopped
and the household lost its assistants for 84 minutes.

Verification first waits up to `dashboardStartSeconds` (600 by default) for the dashboard to
answer at all. The first start after an update builds the web UI before listening, which took
70 seconds on Oct 14, 2026; verification that asked sooner got a refused connection and rolled
back an update that was working. The Discord connection check runs after this wait, so a
long build cannot leave it stale.

The source archive leaves out Git's object store, and archives use fast gzip. Installation only
adds objects, so rollback keeps the live store, replaces everything else from the archive, and
then proves the baseline tree is complete offline. If a crash or damage lost objects, rollback
copies the baseline's history back from the staged repository first. On Oct 14, 2026 the backup
archived a 6.3 GB object store at full compression, which took 29 of the 31 minutes Hermes was down.

### Unanswered maintenance acquire

The update shows as failed with "Hermes did not answer the request to pause for
this update and may still pause itself." Hermes changes stay paused in the app.
The quiescence hook already watched five minutes for a late lease before it
exited, and it requested no drain.

1. Reload the update page. If it offers Cancel, use it. Hermes's late acquire took
   the lease, and Cancel verifies Hermes on its unchanged source and releases the
   lease. Nothing else is needed.
2. Otherwise, on the Hermes host as the account that runs Hermes, read the app's
   `status.json` for `operationId` OPERATION and `qualification.stage` STAGE. Then
   read `STAGE/platform.json`. Continue only if it names OPERATION with phase
   `acquire_unanswered`, the Hermes home has no `.drain_request.json`, and
   `maintenanceFile` does not exist. If `maintenanceFile` holds exactly
   `{"operationId": "OPERATION"}`, go back to step 1. Stop and investigate a lease
   that names another operation or does not parse.
3. Let the old acquire finish. Its handler keeps running inside the add-on after
   the hook gave up. It stops each assistant's idle compaction in turn, waiting at
   most 30 s for each canonical Bot Chat session, so it runs at most 30 s times
   the number of assistants (Hermes profiles with a Bot Chat). At least 300 s have
   passed since the request by the time exit `76` shows. With 9 assistants or
   fewer it has finished by then, with time to spare for the handler's own
   overhead. With more, wait a further 30 s for each one past 9. The add-on logs nothing when the handler finishes, so the lease file
   is the only sign: after the wait, check that `maintenanceFile` still does not
   exist. If it exists now, go back to step 1. A lease that the old acquire writes
   after step 5 releases would stay behind and close Hermes again.
4. Write this operation's lease in the same directory as `maintenanceFile`, mode
   600:

   ```sh
   umask 077
   printf '{"operationId": "%s"}' OPERATION > MAINTENANCE_FILE.OPERATION
   mv MAINTENANCE_FILE.OPERATION MAINTENANCE_FILE
   ```

5. Reload the update page and use Cancel. Recovery drains the gateway, verifies
   Hermes, sign-in and both Discord connections, releases the lease, and completes
   the app's update record. Writing the lease hands that cleanup to the tested
   recovery path instead of hand edits to `status.json`, the request receipt and
   `platform.json`. While the lease exists, Hermes refuses new chats and Discord
   messages; the app was already refusing sends.

A held failure from any other acquire error, or from a release with no answer,
names its cause in the private log under the generic held message. Fix that cause
first, then follow the same steps, accepting phase `acquiring` in step 2. A service
key that the dashboard rejects does not get this far: the request is never sent,
the hook's release fails the same way, and the update fails with exit `1` and
phase `acquiring`. Repair the key in the service environment file, or bring the
dashboard back, before anything else. Writing a lease then would break Cancel,
which verifies Hermes through the same key and cannot, so the lease would block
every chat and Discord message.

A lease that names another operation is not yours to delete. It can belong to a
guarded app release or another update that is running now. Read its `operationId`
and compare it with this update's OPERATION from step 2. If they differ, stop: ask
the installer to check whether that operation is still running, and leave the file
alone. Only a lease that names this OPERATION is this update's.

## App release tooling

App releases and native recovery run from `.agents/tools`. The bootstrap, guarded deploy
and recovery tools share one module, `deploy_common.py`, for commands under the held update
claim, user systemd, readiness, Google and gateway checks. Each tool imports it from its own
directory. Recovery refuses unless its SHA256 matches the `deployFunctionsSha256` that its
read-only check pinned. Every native call sets `HERMES_HOME` to the configured home before
Hermes bootstrap pins the process identity, as the gateway wrapper does, so an inherited value
cannot send a drain request to another home.

The guarded activation, `deploy-guarded-app-release.py`, checks under the update claim that
the maintenance gate is free and nothing is busy, that the gateway is idle, and that Google
sign-in and the app work. `--check` stops there and changes nothing. Where those checks find
Hermes busy (the add-on's busy list, the gateway's agents or work, the dashboard's agents or
sessions) or cannot reach it (the status request fails before it is sent), activation exits `75`
with nothing changed, so `release-app.py activate` leaves the stage prepared to run again.
`--check` keeps failing with exit `1` at the same checks, which `prepare-when-idle.py` reads
by the fence's name. A gate held by another operation is not busy work, since the tool found no
lease at the configured path a moment earlier: that is a concurrent or misconfigured operation, it
fails with exit `1` (the table below), and `prepare-when-idle.py` does not retry it. Activation then:

1. Writes the blocked update status. From here the app refuses sends, update checks and
   installs with "Hermes is being upgraded. Your draft is saved; send it after the update finishes."
2. Journals `maintenance-acquiring` and takes Hermes's maintenance lease while the app still
   runs. A send admitted since the check, or any other active work, makes this refuse. The
   add-on's busy answer is asked again, up to three attempts two seconds apart, because the
   app's own five-second poll holds a reservation and can make an idle app look busy once.
3. Reads the gateway's published record with the lease held. A Discord turn runs in the
   gateway, not in the add-on's sessions, so the add-on's busy list never names it; the
   lease admits no new turn, so a count above zero, listed active work or an unreadable record
   refuses here, before the app stops.
4. Journals `owned-maintenance-acquired`, stops the app, requires every update request the app
   admitted to be complete, and writes the blocked status again, so an app request that was
   already past its own checks cannot leave its status behind.
5. Backs up the app, drains the gateway, stops the native owners and switches the release.

When the add-on answers acquire with its busy refusal on all three attempts, with a lease that
fails the tool's checks, or the gateway then counts active work, the add-on's handler has
returned. Or the request was never sent: the tool's last stdout line from `NATIVE` is
`{"unsent": true}` because the service ticket or the connection failed, so the add-on never saw
it and no lease can appear. The tool then releases, which removes this operation's lease if
acquire took one, and requires no lease to remain, the blocked status to be its own and no update
request to be pending. It then restores the saved status, journals `maintenance-refused` and
exits 75. Nothing stopped, so the household keeps the app and the work that refused the lease
finishes as usual; `release-app.py activate` leaves the stage prepared to run again. An unsent
acquire whose release is unsent too cannot prove that, and exits 2 like a failed release.

| The tool ends with | Exit | The app and the stage |
| --- | --- | --- |
| Preflight finds Hermes busy, or the status request is never sent | `75` (`1` under `--check`) | Nothing changed; stage stays `prepared` |
| Any other preflight failure: a lease held by another operation, a stale gateway heartbeat, the gateway not running, a git or repair mismatch, a status request that failed with no marker or answered an error | `1` | Nothing changed; `release-app.py` marks the stage `needs-review` |
| The add-on's exact busy answer on three attempts | `75` after a release | Saved status back, app running; stage stays `prepared` |
| A success answer that fails the tool's checks | `75` after a release | The same |
| The gateway counts an agent or lists work after the lease | `75` after a release | The same |
| The acquire request was never sent | `75` after a release | The same; if the release is unsent too, exit `2` |
| An acquire with no answer | `2`, after one release attempt | Blocked status kept, held for review; see below |
| Any other error answer, a failed release or fence | `2` | Blocked status kept, held for review |
| Activation finished | `0` | Stage `activated` |

Any other failure journals `maintenance-held-needs-review`, exits 2 and keeps the blocked status,
with the app possibly still running behind it. That includes a failed release, any other error
answer, a send that failed after it may have reached Hermes, and a status file that changed after the tool wrote the blocked status. The tool leaves a
changed status file as it found it: those bytes are the app's, so leave them in place and never
write the blocked status back over them.

Acquire waits up to 120 s for its answer, because the add-on first stops any running idle
compaction, one at a time and for up to 30 s each. With no answer by then, the handler may still
be running and can write the lease after any release, so the tool never reports this as nothing
changed. It tries one release, then exits 2 with `Stopped at fence: Hermes answered maintenance
acquire.` The app, dashboard and gateway keep running, and the app refuses sends with the
draft-saved message. On the host:

1. Wait five minutes after the tool exited, so any acquire still running has ended. Do not skip
   this: a status restored while the acquire is still running lets the app accept sends under a
   lease that then appears. If idle compactions are still running one after another, wait until
   they stop.
2. Read `maintenanceFile`. If it holds exactly `{"operationId": "OPERATION"}` for this
   operation, the late acquire took the lease: delete the file. Stop and investigate a lease that
   names another operation, or a `.drain_request.json` in the Hermes home.
3. If `upgradeStateDir/status.json` still has `"phase": "blocked"` and this `operationId`, replace
   it with `appBase/operations/continued-OPERATION/previous-status.json` through a temporary file
   in the same directory as `status.json` and `mv`, keeping mode 600. Leave any other content in
   place.
4. Prepare the commit again. The needs-review stage stays as the record.

Before this order, the app stopped first, so a send in that window made the acquire refuse with
the app already down and the operation held for review.

Host programs travel as Python source in `REMOTE*` string constants, which `compileall`
cannot see. `tests/host_programs_test.py` finds every such constant, composes it exactly as
it is sent, including `release-app.py`'s prelude and payload line, compiles it and refuses a
name that is read but never bound. A program sent to `remote()` under any other name fails
that test, and every tool script gets the same undefined-name check.

Cutover guards in the release tools are `fence(condition, why)` calls, not `assert`, which
`python -O` or `PYTHONOPTIMIZE` would remove. A tripped fence raises `Fence`, a subclass of
`AssertionError`, so existing review paths treat it as before, and the operator's failure
line ends with `Stopped at fence: why`. Host programs sent as source keep their `assert`
guards, and the shared refusal that starts each one exits before any work when assertions are
disabled. Native one-line calls run with `-I`, which already ignores `PYTHONOPTIMIZE`.

After a successful activation, `release-app.py` records the release itself. It writes the
production receipt and ledger entry, then commits them on `docs/record-NAME` from the latest
`origin/main` in a temporary worktree under the checkout's ignored `.private`, pushes and opens
the docs PR for review. The branch and the ledger check are keyed by the release, so a second
release of the same commit is recorded separately. Reruns reuse an existing PR, pushed branch or
recorded entry. A git or gh failure leaves the release recorded and prints the manual steps.

The install resolves exactly the dependencies qualification built. With plugin members, native
PM seeds an install's resolution from the prior generation's lock and takes the newest release
wherever that lock no longer fits, while the isolated stage, which has no prior generation,
seeds from the checkout's `uv.lock`. So during maintenance the install sync points PM's prior
lock, through PM's own facts writer, at a copy of the stage's resolved lock, and uv keeps every
version it holds; the cold backup holds the original facts. On Oct 14, 2026 live took
nemo-relay 0.10.1, released hours earlier, where qualification had built 0.10.0, and every
install failed its runtime fingerprint and rolled back.
