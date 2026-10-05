# Hermes integration evidence

Validated September 30, 2026 against [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), revisions `b9cb268deffc97946ec11645aa622a7353dd0591` and `d23cc6b06455b8551fb6f61d3cad040a0e82f5b6`, using Python 3.14.7. The production revision also passed with the existing tracked OAuth repair, SHA256 `2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c`. The add-on reports the imported revision and repair hash. Other source revisions require a private receipt for that exact source, repair and application integration. The original constrained Python dependencies are recorded in [requirements.lock.txt](../scripts/spike/requirements.lock.txt). The validation ledger distinguishes ordinary virtual environments from Hermes's managed dependency generations.

The tests ran real Hermes, its AIAgent, native tools, native profile/session stores, and the official scheduler provider. The local OpenAI HTTP provider is a deterministic fixture. It proves integration behavior, not answer quality or compatibility with a live commercial provider. No production service or household profile was used. Application tests with a Runtime double remain separate from this evidence.

## Transport and ownership

The app connects to the official TUI gateway JSON-RPC WebSocket at `/api/ws` and uses authenticated native HTTP routes for files, profile deletion, and routine editing. Hermes runs under its own supervisor. Closing the browser or restarting the app does not create a second execution owner.

Guided host setup verifies that connection before saving `.env`; `npm run doctor`
performs the same read-only check. Diagnostics distinguish absent configuration,
invalid origins, rejected credentials, unreachable gateways, missing add-ons, and
incompatible contracts. Tokens remain server-side. Remote gateways require HTTPS;
HTTP is allowed only on loopback. Redirects are refused for authenticated HTTP reads.

The transport bounds opening/contract negotiation to ten seconds, reads to ten
seconds, and mutations to 45 seconds. An opaque opening failure can add a bounded
five-second native HTTP authentication check. Failed reconnects back off from one
to 30 seconds; an explicit reconnect bypasses the delay. Identical overlapping
reads share work. Mutations are never replayed. Socket events and pending requests
belong to their connection generation, so a late old-socket close cannot destroy a
replacement connection. Successful roster data remains visible during outages;
the UI marks activity unknown and preserves the loaded conversation and draft.

The revision-bound [add-on](../src/hermes/extension.py) adds durable admission, attribution, and event discovery through `agent-interface.capabilities/open/submit/receipt/discover`. Its private SQLite journal lives at `HERMES_HOME/runtime/agent-interface.db`. It writes no Hermes database rows. The adapter enables mutations only after the add-on reports a qualified revision. A native gateway without that contract stays unavailable with an explanation.

Updating Hermes outside the app can invalidate the running app's receipt. A native
dashboard restart then preserves the official interface while disabling the
unqualified add-on, including its private maintenance route. Installer recovery
first qualifies the unchanged current app against the installed native source.
The [recovery tool](../.agents/tools/recover-app-after-native-update.py) uses native
Google retirement and an owned gateway drain to replace that receipt and restart
both native services under a persistent lease. Existing guards and household
settings stay intact. A normal guarded app release follows only after recovery
verifies the restored maintenance route. `release-app.py recover` runs the whole
sequence from a staged copy of the live commit that `qualify-app-release.py` has
qualified.

Native `prompt.submit` supplies a durable `user_row_id` but no durable client request key. The add-on writes a FULL-synchronous receipt before calling native admission, compares retries against the original input and actor, and never automatically replays an uncertain submission. Each independent task has a distinct root request ID. Steering receipts join that root and bind to the actual canonical user row once native Hermes persists it. Sender attribution does not alter the message body or forge protected Hermes author metadata.

Native `message.complete` ends one turn before queued guidance or goal continuation drains. The add-on settles a task after native followups, updates only that root, and rejects a new independent admission during the small finalization interval. That rejection preserves the draft. Its keeper transport retains the native owner when every app connection closes.

After executor death, the journal marks unfinished receipts interrupted and projects the marker into the canonical conversation. Native automatic retry is disabled narrowly for app-owned sessions. A new turn requires explicit review; reconnecting does not retry it. The native probe waited five seconds after recovery and checked actual conversation-provider executions as well as native running state.

## Verified capabilities

| Requirement | Official implementation | Recorded result |
| --- | --- | --- |
| Canonical persistent conversations | `profiles.list(include_sessions)`, `session.create/resume/activate`, exact hidden `Bot Chat` title | Passed. Canonical identity survived reconnect, app restart, and executor restart. Native title is materialized before the first prompt. |
| Streamed answers and actual tools | Native `message.delta`, `tool.start/complete`, history and inflight snapshots | Passed with real terminal execution and native events. Tool results remain available through the durable sidecar. |
| Shared model, provider, instructions and metadata | `profiles.describe/configure`, namespace CAS revisions | Passed create/edit and preservation of avatar metadata. Partial native saves and explicit model confirmation are errors, never false success. New-profile failures roll back the request-created profile. |
| Guidance from two members | Native `session.steer` and persisted ordinary/steer user rows | Passed canonical text and sender attribution, with both participants linked to one task. Sequential tasks in the same conversation have distinct run IDs. |
| Approvals and clarification | `client.capabilities(server_requests:true)`, `request.answer`, native `open_requests` | Passed approval across disconnect/reconnect, another member approving once, stale answer refusal, actor persistence, and native clarification. Empty authoritative snapshots clear pending cards. Native login, code, vault unlock and secret requests use the separately scoped secure bridge described in [Passwords and logins](PasswordsAndLogins.md); unsupported setup and sudo requests use the official interface. |
| Passwords and logins | Existing native `vault.*` operations through a finite authenticated bridge; model-blind secure answers bound to the native canonical owner | Profile-scoped metadata and native storage, local removal, installed-source controls and four supported secure request forms. The validation ledger distinguishes the disposable native probe from web and iOS transport fixtures. |
| Independent work and app restart | Existing supervised native owner and add-on keeper | Passed while a slow task was active. Canonical history is owned by Hermes; the application has no history table. |
| Executor interruption and review | Native crash markers plus add-on epoch/receipt journal | Passed interrupted receipt, durable discovery, canonical interruption, no automatic continuation, unreviewed admission refusal, and reviewed fresh admission. |
| Duplicate or uncertain admission | Add-on request key, input digest, native row correlation | Passed duplicate receipt equality and exactly one canonical user row. Uncertain receipts never authorize automatic replay. |
| Image, PDF and text uploads | Native `file.attach`, selected image staging during serialized admission | Passed authenticated byte roundtrips for all three formats and real native reading of an uploaded text file. Images stay separate from other users' drafts. Active image injection is explicitly rejected, preserving its draft. Image-only canonical sender, registered image bytes, and empty friendly display passed. Preparation failure definitely rejects and removes only its partially staged images; the next admission succeeds. Scanned-PDF understanding was not tested. |
| Generated file delivery | Actual native tool output plus trusted output registry, signed opaque app file IDs | Passed real terminal creation and authenticated download of exact generated bytes. User text cannot mint file IDs. Registered outputs must resolve to regular files within the native workspace; hidden/sensitive paths and symlink escapes are excluded. Upload IDs are bot-scoped and survive app restart. |
| Tools, skills and existing connections | `profiles.describe`, `tools.configure`, `skills.manage`, profile MCP configuration | Passed catalog and toggle roundtrips, including all optional tools/skills off. Native `enabled_toolsets:[]` restores defaults, so the adapter instead writes explicit all-off through `tools.configure`. Hermes essential skills remain enabled and show as required. Existing MCP selections are supported; no live MCP service was configured in this fixture. |
| Routines and chosen recipients | Native cron store and official scheduler provider, native `bot-chat:<profile>` delivery | Passed native CRUD, atomic paused creation, pause/resume state transitions, actual provider execution, canonical bot delivery, durable completion discovery and outbox delivery only to the explicitly selected recipient. Routine participants are not inferred from the conversation. |
| Durable notifications | Add-on monotonic event journal plus profile-owned native cron execution ledgers | Passed cursor replay without duplicate events, approval/completion discovery and executor interruption discovery. Routine execution uses its own durable execution identity. Physical closed-phone Web Push is a separate acceptance gap. |
| Avatar editing and portraits | Native profile metadata and assets, `image.generate` | Passed geometric/mascot metadata and preservation during bot edits. Uploaded portraits use native profile assets. Native image capability probe and a real generation request refused the absent image backend. Live generation and generated-portrait acceptance require a configured backend. |

The native baseline is in [hermes-native-probe.json](evidence/hermes-native-probe.json). Lifecycle and recovery results are in [hermes-extension-probe.json](evidence/hermes-extension-probe.json). Scheduler results are in [hermes-routine-probe.json](evidence/hermes-routine-probe.json). The authenticated Fastify-to-Hermes application proof is in [app-probe.json](evidence/app-probe.json). These contain synthetic content and sanitized paths, not credentials.

The PR follow-up uses native dashboard job reads for routine listing and event discovery. The tool-facing list also probes machine-wide gateway liveness, which can delay other requests. An app probe timed out there under heavy host load. The fresh application probe passed after removing those repeated process checks from polling. Native execution and store ownership are unchanged.

## Reproduce safely

For a candidate outside the original revision allowlist, use a separate exact
checkout and explicitly request qualification:

```sh
python3.14 scripts/spike/run.py --qualification --revision EXACT_40_CHARACTER_SHA \
  --source /private/qualification/source --python /private/qualification/qualified-python
```

The managed qualification launcher activates a native PM generation built for
that source. It preserves the fixture's disposable Hermes home and propagates
activation to child tools. The supervisor never uses the probe-only revision
permit. The upgrade worker writes a production qualification receipt only after
the full real integration suite and configured host regressions succeed. See
[Linux upgrade hooks](HermesUpgradeLinux.md) for the private installer contract.

The dashboard's persistent maintenance lease fences synchronous RPCs, queued
native pool work and deferred session work at native admission. The separately
supervised gateway needs the persistent guard launcher so an expired native
drain marker cannot reopen Discord or cron during verification. Temporary-host
tests do not prove a production systemd cutover or live Google/Discord recovery.

Install Node dependencies with `npm ci`, then run this from the repository with Python 3.14:

```sh
python3.14 scripts/spike/run.py
```

The launcher creates a marked disposable directory, clones the exact upstream revision, creates a virtual environment, installs constrained dependencies, writes a synthetic provider configuration, and chooses free loopback ports. The fixture uses the configured provider ID `spike-fixture`; a literal `custom` provider does not pass the native profile model-selection validator. The launcher starts the fixture and official isolated server directly so an existing machine-wide Hermes owner cannot redirect it.

The launcher runs the native probe, starts the add-on, exercises steering/approval/files, deliberately kills only its own executor, restarts it without replay, runs the official scheduler provider, and runs the authenticated app probe. For the app's executor test, a marked private control directory carries a nonce request and atomic completion acknowledgement. All children stop on exit. The disposable private directory remains for inspecting logs and can be removed after inspection. Do not commit it. Probes refuse an unmarked home, a URL with user information, or a non-loopback target. They compare the authenticated native default profile path with the marked home before mutation. New profiles use `no_alias:true` so probes do not create machine-wide command wrappers.

A second run can reuse only dependencies and source from an existing marked directory, while creating a new disposable home and workspace:

```sh
python3.14 scripts/spike/run.py --reuse /absolute/path/to/agent-interface-spike-directory
```

Use `--app-only` with that command when only application code changed. It still starts a fresh isolated executor and performs the physical executor-restart application check. Routine probes use the official authenticated dashboard trigger to execute the native scheduler provider immediately; they do not wait for a calendar timer. Automatic timed execution requires a separately supervised native Hermes scheduler/gateway with that profile loaded. This application never executes routine jobs itself.

## Compatibility and rollback

The October 1 integration follow-up adds profile-scoped connection management
through the finite private service route. Credential writes delegate to native
provider and MCP handlers; Google Workspace reuses its existing grant file. The
selected-folder and Google Tasks adapters register in both dashboard and gateway
processes. See [Integrations](Integrations.md) for setup, permission meanings and
external-service acceptance limits. The integration probe exercises these native
seams in the disposable home before an update can qualify.

The household experience adds native memory inspection and guarded edits, schedule
previews, and durable manual trials through the official scheduler. The new
`hermes-experience-probe.json` exercises real profile scope, native revision
conflicts, paused trial execution and same-request deduplication in a disposable
home. Voice delegates to native audio routes. See
[Household experience](HouseholdExperience.md) for client behavior and limits.

New full spike runs save receipts in their disposable `evidence` directory,
printed at completion. Archive a successful run with
`.agents/tools/archive-spike-evidence.py` into a new `docs/evidence` directory;
the tool includes the service, integrations and experience probes and rejects replacement of
earlier evidence. Existing receipts above describe their original code states.

The production wrapper installs the add-on before the original `hermes dashboard` CLI starts. It preserves the dashboard UI, Google plugins, native lifecycle and owner registration. Keep the existing home, host, port and supervisor. Do not use the isolated spike launcher for a production dashboard.

Install an untracked module symlink beside the existing `hermes_cli` directory. Point it at the deployed release's wrapper so rollback follows the release link:

```sh
ln -s /path/to/current/src/hermes/dashboard.py /path/to/hermes-agent/agent_interface_dashboard.py
```

The PM-managed launcher supports `--run-module`. Preserve all existing dashboard options after the module name:

```sh
/path/to/existing/hermes --run-module agent_interface_dashboard dashboard --host 127.0.0.1 --port 9119 --no-open
```

The supervisor supplies `HERMES_AGENT_INTERFACE_TOKEN` through a private environment file. Generate 32 random bytes and encode them as unpadded base64url. The app server uses that same key as `HERMES_TOKEN`, with `HERMES_AUTH_MODE=service` and `HERMES_URL=http://127.0.0.1:9119`. Setup and `npm run doctor` forward the selected authentication mode. Keep `HERMES_SERVE_HEADLESS` unset. The wrapper refuses headless and isolated dashboard startup. If its source qualification or service key fails before installation, it logs a fixed warning and starts the original dashboard without the add-on. The app then fails closed because its capabilities are absent. Failures after hook installation stop startup rather than continuing with partial changes.

The service key grants gateway executor authority. It remains on the two servers and never enters a browser, mobile app, WebSocket URL or application notification. The add-on admits it only at `/api/agent-interface/service/` and `/api/agent-interface/service-ticket`, from a direct loopback peer without Origin, Cookie or forwarded headers. A finite method/path list dispatches the existing profile, file and cron handlers and the integration adapter. Only an authenticated private integration invocation can enter native sensitive OAuth handlers through that adapter. Original dashboard routes keep their existing Google authentication. The ticket endpoint issues a fresh native single-use WebSocket ticket with a 30-second expiry. Public reverse proxies must return 404 for `/api/agent-interface/service*`, even though Hermes also checks the key and peer.

The `static` authentication mode remains the default for isolated local fixtures with native session-token authentication. A Google-gated dashboard requires `service`; a copied expiring Google access token is not a service credential.

[Baseline application evidence](evidence/app-probe-b9-qualified.json) and [production application evidence](evidence/app-probe-d23-qualified.json) each record 13 passing groups. [Baseline service evidence](evidence/hermes-service-probe-b9c.json) and [production service evidence](evidence/hermes-service-probe-d23.json) exercise actual native HTTP and WebSocket handlers behind a verified-Google-session fixture. They check preserved Google cookie/bearer access, service guards, one-use tickets, native profile deletion and file-policy parity. The fixture uses no household credentials.

To qualify a separately prepared source checkout, the runner requires the exact tracked repair hash and creates a fresh marked home:

```sh
python3.14 scripts/spike/run.py --source /private/qualified-checkout --python /private/existing-spike/venv/bin/python --revision d23cc6b06455b8551fb6f61d3cad040a0e82f5b6 --source-patch-sha256 2b8335c692f100640e375ffd338f26f6d86195a4ff91c2000e3306bcea9d671c
```

Preserve the interpreter symlink path so Python recognizes its virtual environment. The production managed-runtime startup check is `python3 scripts/spike/dashboard_probe.py --ssh-host SSH_ALIAS`; it reads the installed launcher's exported runtime command and activates the installed dependency selection with lazy installs disabled. It then switches to a disposable home before importing the wrapper and native dashboard. It copies only the wrapper files into a disposable remote directory, checks the dashboard and private ticket endpoint on a free loopback port, then stops only its child process. [The managed-runtime receipt](evidence/hermes-dashboard-managed-probe.json) records the upstream revision, tracked repair hash and checks without private paths.

To roll back, restore the original supervisor command and previous app release. Preserve the private journal if a task was interrupted or its admission uncertain. The app disables unverified mutations when the add-on is absent. No database migration or Hermes-source patch needs reversal. The add-on uses upstream internal hooks and should become an upstream contract; it is not a portable plugin for arbitrary Hermes revisions.

Official documentation checked September 29, 2026: [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration), and [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server). Exact contracts came from the pinned source and runtime, because the documentation does not list every desktop method. Unverified environments include live provider/image backends, a live MCP service, timer-driven unattended scheduling, goal-mode continuation, compressed-history recovery, and physical-phone push delivery. These do not become passed checks merely because a deterministic fixture or browser test succeeded.
