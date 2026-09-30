# Hermes integration evidence

Validated September 29, 2026 against [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/b9cb268deffc97946ec11645aa622a7353dd0591), revision `b9cb268deffc97946ec11645aa622a7353dd0591`, using Python 3.14.7 on macOS. The exact Python dependencies are recorded in [hermes-environment.json](evidence/hermes-environment.json) and constrained by [requirements.lock.txt](../scripts/spike/requirements.lock.txt).

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

The revision-bound [add-on](../src/hermes/extension.py) adds durable admission, attribution, and event discovery through `agent-interface.capabilities/open/submit/receipt/discover`. Its private SQLite journal lives at `HERMES_HOME/runtime/agent-interface.db`. It writes no Hermes database rows. The adapter enables mutations only after the add-on reports the exact verified revision. A native gateway without that contract stays unavailable with an explanation.

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
| Approvals and clarification | `client.capabilities(server_requests:true)`, `request.answer`, native `open_requests` | Passed approval across disconnect/reconnect, another member approving once, stale answer refusal, actor persistence, and native clarification. Empty authoritative snapshots clear pending cards. Secret or new-connection requests direct to the official interface. |
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

Do not load this add-on into an already running native owner. Stop that owner under its existing supervisor, then launch the add-on from the verified Hermes environment with the same `HERMES_HOME`, token and loopback port:

```sh
/path/to/hermes-venv/bin/python /path/to/agent-interface/src/hermes/extension.py --port 19121
```

The environment must supply `HERMES_HOME`, `HERMES_SERVE_HEADLESS=1`, and the existing server token through `HERMES_DASHBOARD_SESSION_TOKEN`. Keep these in a private supervisor environment file. Set the application's `HERMES_URL` and `HERMES_TOKEN` to that owner. The launcher checks the upstream Git SHA before startup. A new revision needs compatibility probes before changing the constant.

To roll back, stop the add-on owner and start the original native owner with the same home and supervisor. Preserve the private journal if a task was interrupted or its admission uncertain. The app will disable unverified mutations when the add-on is absent. No database migration or Hermes-source patch needs reversal. The add-on uses upstream internal hooks and should become an upstream contract; it is not a portable plugin for arbitrary Hermes revisions.

Official documentation checked September 29, 2026: [Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode), [programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration), and [API server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server). Exact contracts came from the pinned source and runtime, because the documentation does not list every desktop method. Unverified environments include live provider/image backends, a live MCP service, timer-driven unattended scheduling, goal-mode continuation, compressed-history recovery, and physical-phone push delivery. These do not become passed checks merely because a deterministic fixture or browser test succeeded.
