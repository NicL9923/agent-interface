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
Copy the actual managed interpreter paths from the host's native launcher and PM
selection. Do not substitute the retired in-tree venv or a system Python.

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

## Cutover and recovery

The quiescence hook takes the persistent native dashboard admission gate and
requests the reversible native gateway drain. It requires a new drain
acknowledgement from the current systemd process, its exact code SHA and home,
and zero native chat, cron, API, or deferred work. Active or unknown work blocks
shutdown. Exit code `75` means the hook proved that its gate and drain were
released and that source, settings, and service processes stayed unchanged.
Other failures keep maintenance closed for installer review.

After quiescence, the backup hook stops the gateway and dashboard and creates
private cold archives of source, Git branch/configuration, and the shared home.
Before stopping either service, the helper imports the qualified candidate's
reachable Git objects from staging into the installed object store and proves
they can be read without upstream access. This bounded private pack transfer
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
