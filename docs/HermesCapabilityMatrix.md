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

The add-on runs `agent-interface.open` and `agent-interface.discover` on Hermes's RPC pool instead of the socket's read loop, with one lock per assistant, so one assistant's history read never waits on another's. It reuses decorated history for up to ten minutes while the session's history, journal, database files and redaction state are unchanged, or 30 seconds when it cannot read the redaction state. Each open reports its phase timings, which the app server sends as a `Server-Timing` header on conversation reads.

After the add-on admits an app message as steering, it closes that session's open clarify, secure-input, computer handoff, terminal and connection requests, except a login asked for by address that belongs to another member, so the blocked tool returns and native steering drains. It withdraws each exact request under the native `server_requests` lock with the same settlement as native `cancel`, and wraps tool dispatch so a result whose request was closed this way says the user replied in chat. When the household computer is configured, it also registers the `agent_interface.computer_handoff` server request contract and the `computer_request_handoff` tool, and likewise the `agent_interface.terminal_request` contract and the `computer_request_terminal` tool; a revision without the contract seam keeps the computer without those tools. It always registers the `agent_interface.connection_request` contract and the `request_connection` tool the same way, when the seam exists. These use private native seams, so a new Hermes revision needs qualification before release, as for the rest of the add-on. `tests/hermes_chat_reply_test.py` runs against a Hermes checkout's real `tui_gateway/server_requests.py` when `HERMES_SOURCE` names it.

The dashboard wrapper sets the native switch for externally managed installs, so
the native dashboard hides its update control and its check and install routes
refuse with a message directing administrators to the app. The service probe requires that switch on each
qualified revision. Command-line `hermes update` remains available to the installer.

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
| Routines and chosen recipients | Native cron store and official scheduler provider, native `bot-chat:<profile>` delivery through the live-owner mailbox | Passed native CRUD, atomic paused creation, pause/resume state transitions, actual provider execution, canonical bot delivery, durable completion discovery and outbox delivery only to the explicitly selected recipient. Routine participants are not inferred from the conversation. Hermes' unified gateway runtime retired the dashboard's mailbox consumer and sends deliveries only to its gateway authority, which refuses a Bot Chat the dashboard holds. On such a Hermes, `bot_delivery.py` keeps deliveries for add-on chats in the native mailbox and runs them in the dashboard, once each. The suite fires routines through the guarded native gateway, as production does. |
| Durable notifications | Add-on monotonic event journal plus profile-owned native cron execution ledgers | Passed cursor replay without duplicate events, approval/completion discovery and executor interruption discovery. Routine execution uses its own durable execution identity. Physical closed-phone Web Push is a separate acceptance gap. |
| Avatar editing and portraits | Native profile metadata and assets, `image.generate` | Passed geometric/mascot metadata and preservation during bot edits. Uploaded portraits use native profile assets. Native image capability probe and a real generation request refused the absent image backend. Live generation and generated-portrait acceptance require a configured backend. |
| Skill locks | Native skill lock record (`tools.skill_usage.set_locked`, keyed by skill directory, the record `PUT /api/skills/lock` writes), the dashboard's `_locked_index`, and the `skill_manage` lock preflight | A disposable home run against the 3a1e9ef source locked a skill through the add-on by its frontmatter name, listed it as locked, and saw native `skill_manage` and replayed approvals (single edit, delete and batch) refuse with `_locked` before any write; unlocking restored edits. An approval refused by a lock records a definite refusal. Locking needs an integration administrator, as the skill write policy does. Not run against a live profile. |
| Account usage | `agent.account_usage.fetch_account_usage` (read-only, per credential), `_fetch_portal_account`, `build_nous_credits_snapshot` and `redeem_codex_reset_credit`; `agent.credential_pool.load_pool(...).entries()`; `agent.account_usage_cache.has_account_usage` (built-in fetchers on Hermes before the cache); `hermes_cli.fallback_config.get_fallback_chain` and `resolve_entry_api_key`; `hermes_cli.auth.resolve_provider` for `auto` | Accounts are read the way Hermes's own model picker reads pooled credentials: each pool entry or fallback key is one account, keyed by Hermes's account identity, listed without selecting, rotating or refreshing a credential, and read with that exact credential. A reset is spent with the same credential, once per request ID: the add-on journal records the request before ChatGPT is asked, one reset runs at a time per account, and only a fixed sentence per outcome leaves the add-on. Nothing returned holds a credential, the provider's raw response or Hermes's account identity, only digests of them. `experience_probe.py` lists the fixture profile's account, reads it as a provider without usage, and refuses a reset for it, against a disposable home. Production revision `ed1afb0` was read for the same functions and the same guarded reset path. Live provider responses are an external acceptance step. |
| Conversation speed (Normal, Auto, Fast, Ultrafast) | `config.set`/`config.get` key `fast` in `tui_gateway/methods_config_set.py` `_set_fast` and `methods_config.py` `_cfg_get_fast`; `agent/fast_mode.py` `begin_turn` and `effective_request_overrides`; `hermes_cli/models.py` `resolve_fast_mode_overrides` | Read from production revision `ed1afb082e` source, not run. `config.set` accepts `auto` and `cold`, keeps the word in the session's `create_service_tier_override` and the live agent's `service_tier`, and echoes it. Only `fast` and `ultrafast` are checked against the model (`resolve_fast_mode_overrides`, plus `ultrafast_offered`), so a model without fast mode saves `auto` and never speeds up. `config.get` maps only `priority` to `fast` and `ultrafast`, so Auto and Cold read as `normal`, and it falls back to the profile default when the session's tier is unset, so a session pinned to Normal reads as the profile's speed. `config.set` with `status` changes nothing and echoes the live agent's tier, so the app reads every speed that way and uses `config.get` only on a Hermes without status. A Hermes before Auto answers `config.set` with code 4002 `unknown fast mode: auto`. `cold` is first-turn-only and not offered. The Fastify tests model this behavior with a fake; a real Hermes run is not recorded |
| MCP sign-in rejected | `mcp.servers.status` `needs_auth` through the in-process dispatcher | A disposable home call returned `needs_auth` for every configured server, and a server parked as native parks a rejected OAuth credential read `needs_auth: true` and showed as Expired. No live MCP OAuth service was configured. |
| Shared browser metadata floor | `browser_cdp_tool._fetched_param_urls`, `browser_url_policy.literal_targets_metadata` | The add-on wrapper applies native's CDP metadata scan to every `browser_cdp` call. With `HERMES_SOURCE` set to the 3a1e9ef source, `tests/hermes_computer_test.py` blocks `//169.254.169.254/`, `\\169.254.169.254`, userinfo forms, `http://2852039166/`, `http://[fd00:ec2::254]/` and `//0xa9fea9fe/` across `Runtime.evaluate`, `Page.navigate`, `Target.createTarget`, `Network.loadNetworkResource`, `Runtime.callFunctionOn` and `Page.addScriptToEvaluateOnNewDocument`; the earlier wrapper let six of those cases through. The wrapper also reads zero- and one-slash, backslash and escaped special-scheme forms such as `http:/169.254.169.254/`, which native's scan misses: of nine such real-module cases, native alone and the earlier wrapper let six through. |

### Group chat activity, settings and routine posts

Hermes `3a1e9ef50a570b1544795ddad197ad2dcde430ab` adds three room features the app uses where the gateway advertises them. None has a real-Hermes probe yet: the contracts below were read from that source, and application, contract-fixture and native unit tests exercise the app against them.

| Requirement | Official implementation | Recorded result |
| --- | --- | --- |
| Who is working in a room | `groups.state` `driver_status.member_activity` (member, status, thread, 0-based round, `started_at`, current `tool`) and `max_rounds` (`tui_gateway/contracts/groups_bot_relay.py`) | Application tests only. Older gateways omit both; the app then keeps the room-wide working line. The server's room watcher ignores each turn's `progress_at`, so a step inside one tool never wakes every viewer |
| Room purpose, shared notes and lead | `groups.context` with `event_id`, `purpose`, `notes`, `routing` (`everyone` or `lead`) and `lead_member_id`; `groups.state` returns `context` (`gateway/hosted_room_context.py`). Lead hand-offs are `room.assignment` events | Application tests only. Offered when `groups.capabilities.methods` lists `groups.context`; it is a room-log write, so it needs no running coordinator. The app always sends `routing`, since Hermes keeps the current routing only when it is omitted. Hermes limits purpose to 500 characters and trimmed notes to 4,096 UTF-8 bytes, which the server checks first |
| Routine results in a group chat | `deliver: room:<id>` beside `bot-chat:<profile>` in the comma-separated target list, plus `failure_deliver` and `origin` delivery (`cron/scheduler_delivery_room.py`, `cron/scheduler_delivery.py`), mirrored in `src/server/delivery-targets.ts` | Application tests only. The app edits only its own `room:<id>` targets and keeps any other target, including `room:<id>@<profile>`. A post starts a round only for the members it @mentions. Hermes writes it as `message.user` with a `cron:<job>` actor and the routine name as `display_name`, which the app shows as the routine's post. The app offers it with `groups.context`, which arrived in the same upstream change. Delivery errors name `room:<id>`; the app shows only rooms the reader can open |

### Progress lines

Read from the production revision `ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df`. A GPT model on the openai-codex route writes progress lines as phase `commentary` items in `messages.codex_message_items` and leaves `content` empty.

| Requirement | Official implementation | Recorded result |
| --- | --- | --- |
| Saved lines, shown by the profile's own policy | `agent/history_commentary.py` `project_history_commentary` adds `display_commentary` (visible, think-stripped, redacted strings) to assistant rows, plus `display_content` and `display_reasoning` without them. `tui_gateway/session_history.py` `_history_to_messages` applies it. Gates: `display.show_commentary` and `display.interim_assistant_messages`, both default true. A disabled or unreadable gate sends `[]`, and a `commentary_withheld` row sends none | The app reads only `display_commentary`, never `codex_message_items`. Application tests for a malformed field, a disabled gate, lines kept whole (a long or repeated one, which the stream would otherwise bring back as a reply), saved history pages and a window cut. Run against the production revision's real function and a copy of real rows, read-only |
| Live line | `agent/turn_tool_round.py` emits interim commentary after the database append; `tui_gateway/prompt_turn.py` sends `message.interim` `{text, already_streamed}` only when `_load_interim_assistant_messages()` is on | The frame is a structural change, so open chats read the saved row at once; the text itself comes from history, not the frame |
| Asking for the line | The add-on's `with_inline_guidance` adds `src/shared/progress-line-instructions.json` to the turn's ephemeral system prompt on every app turn | Python test for the wording, once per turn, app turns only |

<!-- Main assistant: begin --><!-- Main assistant: begin -->
### Main assistant check-ins and hand-offs

Read from the production revision `ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df` (an earlier version of this section named `3a1e9ef`, which production no longer runs).

| Requirement | Official implementation | Recorded result |
| --- | --- | --- |
| Check-ins every few hours | `cron/jobs.py` `parse_schedule`: "every 2h" is `{"kind": "interval", "minutes": 120}`, shown back as "every 120m" | Application tests with an in-memory cron store; no real-Hermes check-in probe yet |
| A check-in that finds nothing stays quiet | `cron/scheduler.py` `_is_cron_silence_response` suppresses delivery for `[SILENT]` and its bracketless forms (`gateway/response_filters.py`); `cron/scheduler_prompt.py` `_archive_answer` returns no answer for them, so the add-on's completion event has no body | The app treats a check-in event that is not completed, has no body, or matches the same silence forms as quiet: no notification and no Today entry. Application tests only |
| Hand-offs gated for shared assistants | `tools/bot_mode_dm.py` `message_agent_tool`, which `agent/inline_tool_executors.py` looks up by module attribute on every call, and `_resolve_local_name`, which prefers a profile ID over a name; `tools/clarify_tool.py` with the agent's `clarify_callback` | The add-on wraps `message_agent_tool` (`src/hermes/delegation.py`), resolves the target against the roster once and forwards that profile ID, never the words the model wrote. It drops the `teammates` list Hermes adds to some errors. Cron runs are not Bot Chat sessions, so `message_agent` is unavailable in check-ins |
| Every assistant's listed teammates | `tools/bot_mode_probe.py` `_build_section` lists every live profile with its description in each Bot Chat system prompt, cached by `get_bot_mode_protocol_section`; stored prompts rebuild when `capability_fingerprint` changes | The add-on filters that section to the profile's WildBots roster and mixes the roster into the fingerprint, so cached and stored prompts rebuild once. `tests/hermes_delegation_test.py` builds a real section from profile folders: unfiltered it lists "Dad private diary" to Mom's main assistant; filtered it does not |
| Routine deliveries a model can choose | `tools/cronjob_tools.py` `cronjob_manage` (actions create, list, update, pause, resume, remove, run, cancel, with `run_now` and `trigger` as `run`; `deliver`, `failure_deliver`: `bot-chat:<profile>`, `room:<id>`, `origin`, `all`, platform targets), validated in `tools/cronjob_job_args.py` only for existence; registry handlers run with the profile's home override (`agent/tool_executor.py` `propagate_context_to_thread`) | The add-on wraps the registry handler for main assistants only: list, pause, remove, cancel, and create with an explicit own-chat delivery and no script, monitor, working directory or context. Other assistants' calls go to Hermes unchanged. `send_message` is not an agent-callable tool at this revision |
| Hand-off transport | `tools/bot_mode_dm.py` `_dispatch` tries registered peers (`config.yaml` `bot_peers`) before local profiles, and the relay for a name it can't resolve locally | The add-on refuses an authorized ID that is a peer name or not a live local profile, and refuses when it can't read them |
| Roster protocol | `agent-interface.capabilities` reports `delegation: true` and `delegation_version: 2` | A version 1 add-on gets main rosters only; a policy without `main` is a main roster; only version 2 makes undescribed profiles reach nobody |
| Native job settings | Provider failures add `unreachable_retry` (a model outage) and `quota_hold_until` and `quota_hold_cron_expr` (a quota hold), from `cron.jobs.mark_job_run`. `cron.jobs.list_jobs` returns `base_url`, `monitor_script`, `monitor_url`, `workdir`, `skill`, `interpreter`, `repeat` and others the app's routine fields don't carry, beside scheduler bookkeeping such as `last_dispatch` (written by `get_due_jobs`), `fire_claim` and `canonical_completions` | `src/shared/hermes-job-fields.json` lists routine and bookkeeping fields; any other set field replaces a check-in. `tests/hermes_delegation_test.py` runs a real job through `cron.scheduler_tick.tick` and checks every field it carries mid-run and after completion is listed |
| Cross-profile routine delivery (known limit) | `cron/scheduler_delivery.py` `_deliver_to_bot_chat` admits any routine's result into another local profile's Bot Chat; a queued result keeps its destination after either profile's sharing changes | Not enforced for assistants other than a main one; main assistants deliver only to their own chat. Follow-up branch `t3/routine-delivery-privacy` |
| Older runs' Bot Chat receipts (known limit) | `cron/scheduler_delivery.py` `_record_delivery_verification` writes `last_delivery_queued` for the latest run and overwrites it on the next | Promotion's in-flight check is best-effort for each routine's latest run only, so an older run's unfinished delivery can stay hidden. Its content was made under non-main rules and would deliver either way, so activation adds no exposure; part of the cross-profile routine delivery limit on `t3/routine-delivery-privacy` |
| Copies a routine change doesn't reach | A run keeps the job it started with; `cron/delivery_queue.py` keeps unfinished deliveries in `cron/deliveries.db` (`pending`, `delivering`), a `pending` row surviving the run's wait; `cron/bot_chat_legacy.py` `defer` parks Bot Chat outputs for a target that isn't running in `cron/bot_chat_pending/`; `fire_claim` marks a claimed run. `last_delivery_queued` names Bot Chat receipts but stays on the job after they settle, so only the receipt in the target's `runtime/bot_live_delivery` mailbox (`tools/bot_live_delivery.py` `read_delivery_result`) says whether it is unfinished (`queued`, `claimed`). Each keeps the destination it had | Making an assistant main is refused while any of these is unfinished for it, or when they can't be read. The add-on's `agent-interface.routine_deliveries` reads both stores and resolves each queued marker against its receipt; a settled, failed, cancelled or ambiguous one, or a finished parked record, doesn't count. `tests/hermes_delegation_test.py` queues and parks real deliveries, and settles and fails real receipts, through ed1afb0's own code |
| Check-in jobs | `tools/cronjob_tools.py` update, resume and run, found by `cron.jobs.resolve_job_ref` | The add-on refuses them, for any assistant, on a job whose prompt carries the check-in marker, and pins other calls to the job it checked. Tested against the real resolver |
| `origin` delivery | With no recorded origin, Hermes posts to a configured platform's home channel | The app counts it as outside WildBots |
| Host-level tools | `terminal`, `execute_code`, `process_manage`, `write_file`, `patch` act on the whole host; `tools/file_tools.py` notes profiles are not isolated | For a main assistant only, the add-on refuses commands naming the Hermes CLI, a Hermes home or another profile's path, and file writes into another profile. This is a guard, not a boundary |
<!-- Main assistant: end -->

### Idle compaction

Read from, and probed against, the production revision `ed1afb082eb3e46cf2edae9d8f68fb67b09ee4df`.

Production evidence, read-only on November 9, 2026: the busiest Bot Chat (`20260929_225146_7e599c`) sent a 206,633-token prompt with 106 active rows. Each of three model calls in one spoken question took 8 to 13 seconds. Hermes compacts automatically only near its threshold (375K of a 500K window here), inside a turn someone is waiting on. Its five automatic compactions of that session took 220 to 290 seconds each and left 25,600 to 41,857 tokens (`agent.log` compression telemetry).

| Need | Hermes at `ed1afb0` | Add-on ([compaction.py](../src/hermes/compaction.py)) |
| --- | --- | --- |
| Compact without a turn | `session.compress` (`tui_gateway/methods_session.py`). `_manual_compress_turn` (`tui_gateway/session_compression.py`) holds `running` and `_manual_compress_active` for the whole compaction (Hermes #133504). The commit is in place: archived rows stay searchable. A turn-isolated session goes to the compute host, which can answer `pending` and cannot be stopped from the dashboard. Revisions `b9cb268` and `d23cc6b` lack the hold | Compacts each assistant's canonical session once it has had no frame, admission or native activity for `HERMES_AGENT_INTERFACE_IDLE_COMPACT_SECONDS` (default 600; 0 is off). It never starts beside running or queued work, an open request, an unsettled receipt, an interruption under review, a maintenance lease, a compute-host session or an unbuilt agent. It attempts each history version once. Off on Hermes without the hold |
| How large is too large | `estimate_request_tokens_rough`. The compressor keeps a tail of `threshold × target_ratio` (75K in production), lets optional rows reach 1.5 times that (`_tail_soft_ceiling`), and caps the summary at 5% of the window or 10K. The protected head and required anchors can exceed these | Due above the system prompt and tools plus 1.5 times the tail budget plus the summary cap: about 155K in production, where prompt and tools are about 32K. A compaction that leaves P tokens makes the next one wait until the request passes 2P, so it can never compact in a loop |
| A message during a compaction | Left alone, Hermes queues a `prompt.submit` or `session.steer` and runs it when the compaction ends (`_session_compression_in_flight`), up to 290 seconds later. `session.interrupt` deliberately does not stop a manual compaction. Every compaction publishes its own `CompressionCommitFence` on the agent (`agent/compression_facade.py`). `try_cancel_before_commit` never blocks: it cancels a pending commit, reports one already started, or answers `None` while a commit holds the fence. The summary call polls the fence and stops; Hermes rolls back and records `commit_fence_cancelled` telemetry. A cancel before the summary call starts leaves the transcript unchanged, which Hermes reads as no progress and answers with a 300-second backoff on its own automatic compaction; `_compression_working_attempt_generation` on the compressor changes when the summary starts. A stall fallback publishes a fresh fence for a summary that has not started. Hermes ends a manual compaction and admits the next turn under the session's `history_lock`, and `session.compress` resolves `_manual_compress_turn` on the server module | App messages, routine deliveries, goal changes and maintenance leases cancel it first, through that fence, once that fence's summary has started or reported progress. The add-on wraps `_manual_compress_turn` to name the thread Hermes holds the session for, and cancels only under `history_lock` while that is its own attempt's thread, so a cancel can never reach a later turn's compaction or another client's. The lock is taken with a 50 ms timeout and retried, so a busy lock cannot stretch the wait. The input then waits at most 30 seconds for Hermes to let go, and is admitted as an ordinary turn, never as steering: a steer into an idle session is rejected. A watcher cancels it within a quarter second when another client's input queues in Hermes. Maintenance cancels before taking its own lock, because Hermes's release of the session passes through it. No agent-wide stop is set. A cancel during a summary stream that has already stalled arms Hermes's stall cooldown, as a person's stop would |
| What clients see | The session reports `running`, and `status.update` frames say "compressing" | `agent-interface.open` reports it idle, its progress frames stay private, and discovery does not hold completed events behind it |
| Messages after a compaction | The commit archives every row and stores the kept head and tail again as new rows. Each copy keeps the original's `message_uid` (`agent/message_metadata.py`). Production's busiest session already shows 16 copies among its 106 visible rows | Every copy is shown under the earliest row ID with its `message_uid` in the same session. Receipts (request ID, sender, files, run), message IDs, reply-card state and Talk's anchored reads survive. This also repairs the same loss after Hermes's automatic compactions. The lookup took about 16 ms on production's busiest session, once per uncached open |

[compaction_probe.py](../scripts/spike/compaction_probe.py) runs real Hermes with a fixture provider that holds the summary call open while a gate file exists. During a held compaction, it checks four inputs: an app message, one sent with the steer flag, another client's native `prompt.submit` and a routine delivery. Each was admitted in about 0.1 seconds and answered within half a second, or delivered within about five seconds, on the uncompacted transcript, while the summary was still held. Without the add-on's steering correction, Hermes refused the steer-flagged message (`status: rejected`). The compaction never committed. A compaction left to finish committed. The app's message IDs, roles, text and anchored reads were unchanged, the model's next request carried the summary, and nothing compacted again. Receipt: [hermes-compaction-probe-ed1afb0.json](evidence/hermes-compaction-probe-ed1afb0.json).

Not covered: a summary that stalls before any input arrives, so the first fence the add-on sees is Hermes's stall fallback. Hermes exposes nothing that tells that fence from a primary already summarizing, so an input in the fallback's first moments, while it builds its prompt (about 0.3 seconds in production), can cancel it before its summary starts and add a 300-second backoff to the stall cooldown Hermes has already armed. Also not covered: a rotated (not in place) compaction's parent rows, compute-host sessions, which are never compacted, and memory-refresh status, which says "pending" while a compaction runs. Production's provider (ChatGPT Codex, `gpt-6.1-sol`) has not run an idle compaction; the probe's provider is the fixture.

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
drain marker cannot reopen Discord or cron during verification. On a Hermes with
a gateway session authority, the guard also refuses new authority admissions while
the lease is held, the way a native drain does. Temporary-host
tests do not prove a production systemd cutover or live Google/Discord recovery.

Install Node dependencies with `npm ci`, then run this from the repository with Python 3.14:

```sh
python3.14 scripts/spike/run.py
```

The launcher creates a marked disposable directory, clones the exact upstream revision, creates a virtual environment, installs constrained dependencies, writes a synthetic provider configuration, and chooses free loopback ports. The fixture uses the configured provider ID `spike-fixture`; a literal `custom` provider does not pass the native profile model-selection validator. The launcher starts the fixture and official isolated server directly so an existing machine-wide Hermes owner cannot redirect it.

The launcher runs the native probe, starts the add-on, exercises steering/approval/files, deliberately kills only its own executor, restarts it without replay, runs the official scheduler provider, runs the idle compaction probe in its own add-on gateway with a four-second delay, and runs the authenticated app probe. For the app's executor test, a marked private control directory carries a nonce request and atomic completion acknowledgement. All children stop on exit. The disposable private directory remains for inspecting logs and can be removed after inspection. Do not commit it. Probes refuse an unmarked home, a URL with user information, or a non-loopback target. They compare the authenticated native default profile path with the marked home before mutation. New profiles use `no_alias:true` so probes do not create machine-wide command wrappers.

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

Live Talk uses `hermes_cli.plugin_provider_requests.credentialed_provider_request`
from the WildBots voice plugin (`requires_auth: [openai-codex]`) to mint OpenAI
Realtime client secrets, with Hermes attaching the ChatGPT credential. The
session shape, the frame check through the plugins link and the browser's WebRTC
call were verified by hand against production Hermes and OpenAI. The application
tests use a fake `credentialed_provider_request` and never contact OpenAI, and no
isolated probe covers this seam yet. A host rehearsal showed Hermes mints for the
linked plugin even when it is not enabled, so the add-on gates on the plugin's
enabled state through `hermes_cli.plugins._get_enabled_plugins` and
`_get_disabled_plugins`, the readers Hermes's own loader uses; those private names
are checked against Hermes 0.15.2 source only, and their absence fails closed. An
older Hermes without the module reports live voice as unavailable. See
[Hosting](Hosting.md#live-voice-plugin).

A spoken Talk request that starts a new turn passes `voice_turn: true` to native
`prompt.submit`, which Hermes `ed1afb082e` stores for the turn
(`tui_gateway/methods_prompt.py` `session["voice_turn"]`) and binds through
`agent/voice_turn_route.py` `begin_voice_turn_route` to `auxiliary.voice_chat`: that
route's reasoning effort, and its model when one is set. The route is read from
config at each turn. A steer carries no mark. This was read from source, not run;
the add-on tests use a fake gateway.

The November 4 follow-up for Hermes 3a1e9ef adopts three native features and
degrades on an older revision. Without native skill locks, the overview omits
`lockSupported` and both clients hide the lock control. Without `needs_auth`
in `mcp.servers.status`, connection cards keep the earlier token rule. A
`tools.browser_session` revision without `literal_targets_metadata` and
`_fetched_param_urls` fails the shared computer's seam check, so the shared
computer stays off rather than run a weaker metadata check. The automation
probe now locks a skill, checks that an approved assistant edit to it is
refused, and unlocks it again.

The November 6 follow-up qualifies Hermes main `74915d7af8d3115c3eb821893f3c01ab783146a5`, which
contains v0.23.0. Upstream commits `e9f8551` and `1fcc57e` deleted the Bot Chat mailbox helpers
`has_mailbox`, `_scan_read`, `_next_sequence` and `complete_delivery` once the authority FIFO stopped
reading the mailbox. The add-on's own deliveries still use that directory, so `bot_delivery.ensure_helpers`
supplies the four over the native `_root`, `_locked`, `_read`, `_write` and `_delivery_id` that remain,
and keeps Hermes's own where they exist. Without it the guarded gateway refused to start. The full spike,
native and real-application probes passed against that revision in disposable homes.

The same follow-up adopts the native cron cancel route (`POST /api/cron/jobs/{id}/cancel`) and the job
list's `live_execution`. A routine with a run in flight shows Stop run on web and iOS; the schedule is
unchanged. Stop works during a trial too: the trial then ends, reads as failed with "This trial was stopped
before it finished.", and releases its maintenance reservation. In run history, an attempt Hermes records
as `cancelled` reads as Stopped and one recorded as `missed` as Didn't run wherever Hermes names the
attempt exactly: session execution IDs, ledger rows and native `exec:N` output rows. Output documents
matched by time still pair only with finished runs, so a stopped run never takes another run's document. Both routes exist at `ed1afb0` too.

The November 8 approval scopes work verified Hermes `ed1afb082eb3` with
`scripts/spike/approval_scope_probe.py`, which `run.py` now runs after the automation probe,
in a disposable home with the deterministic provider. An ordinary dangerous command offers
`once`, `session`, `always` and `deny`, keyed by its pattern (`recursive delete`). `session`
grants only that session; `always` also writes the pattern to the profile's
`command_allowlist`. The add-on's `approval_allowlist_remove` withdrew both the saved pattern
and the live session grant, so Hermes asked again at once, and `deny` blocked the command. With
`approvals.mode: smart` the guardian ran a command it approved without asking, and a command
it denied offered only `once` and `deny`; an unoffered `always` sent anyway was not saved
but still ran once, which is why the app server refuses unoffered choices. Clarify carried
`multi_select`, marked the first of several choices ` (Recommended)`, took a JSON array for a
multi-select answer and stripped the suffix from a picked answer. The add-on returned its
steering decision in the admission response, receipt lookup and history row. The older
qualified revisions `b9cb268` and `d23cc6b` build the same approval `choices` and clarify wire. They
do not reread `command_allowlist` once loaded, so the add-on also drops a removed pattern from
the dashboard process's permanent cache. `tests/hermes_automation_test.py` checks that removal
against the real `tools.approval` of each qualified revision when `HERMES_SOURCE` names its
checkout.
[Evidence](evidence/hermes-approval-scope-probe-ed1afb0.json).

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
