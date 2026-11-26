# WildBots

WildBots is a self-hosted web client and native iOS app for a household's AI assistants. The repository and internal identifiers keep the original `agent-interface` name. Each assistant has a persistent SQLite-backed conversation, configurable instructions, memory, skills, routines, custom MCP connections, encrypted website logins, live voice, and an expressive avatar that reflects what it is doing. Each household member has separate preferences, personal assistants, drafts, and notification subscriptions.

Household installation: [agentui.wildflowersranch.com](https://agentui.wildflowersranch.com).

## The story so far

This repository evolved through three distinct chapters:

1. **Household client for Hermes.** WildBots started as `agent-interface`, a web and native SwiftUI iOS client sitting in front of a shared upstream Hermes installation. That first chapter built the household experience: Google sign-in with an allowlist, personal vs. shared assistant privacy boundaries, Main Assistant and quiet check-ins, durable send receipts, offline service-worker caching, drawn animated avatars, Web Push and APNs/Live Activities, group chats, encrypted logins, and a shared VPS desktop + system terminal.
2. **Multi-harness & ACP wrapper.** Rather than staying tied to a single upstream agent daemon, we introduced a unified `HarnessDriver` architecture (`src/server/harness/`) that wraps modern CLI/protocol agents directly: **Antigravity** (ACP stdio JSON-RPC), **Codex** (app-server JSON-RPC), **Claude Code** (stream-json), **Grok**, and **Pi** (including automatic OpenRouter fallback). At the same time, we moved transcripts, message queues, persistent memory, skills, routines, group chat coordination, and AES-256-GCM encrypted secrets into WildBots' own SQLite database, exposed to every harness through a localhost **WildBots MCP** server (`src/server/mcp/wildbots-mcp.ts`).
3. **Native platform & Hermes retirement.** Once every household assistant, transcript, memory, routine, group room, and vault login was migrated to SQLite, we retired Hermes completely — removing the Hermes gateway client, Python add-on, upgrade runner, and migration scaffolding (~101,000 lines deleted), switching production to Bun 1.4.5, and wiring the remaining platform capabilities directly into `HarnessRuntime`:
   - **Native Shared Computer:** `Xtigervnc` + Chrome/Chromium DevTools Protocol (CDP) supervised directly by the server with a zero-dependency TCP-to-WebSocket RFB bridge (`/api/computer/desktop/ws`), human takeover / release control, and browser automation MCP tools.
   - **Vault-Safe Browser Sign-In:** Encrypted website logins (`bot_secrets` with AES-256-GCM) usable via `vault_list_logins`, `vault_login_fill`, and `vault_totp_fill` MCP tools — verifying exact origin match inside the browser page before filling, never exposing plaintext passwords or TOTP seeds to models or logs.
   - **Native Integrations & Custom MCP Manager:** Per-assistant API keys and custom HTTP MCP servers (`none` or encrypted `bearer` auth) managed through `/api/integrations*` and attached automatically to each assistant's harness sessions.
   - **Native Bot-to-Bot Delegation & Group Routine Delivery:** `delegationPolicy` enforcement, `message_bot` handoffs formatted as agent-exchange cards, Main Assistant activation & quiet `[SILENT]` check-ins, and scheduled routines delivering straight into group chats (with `@mention` wakeups).
   - **Single-command Rollback-Safe Deploys:** [`scripts/deploy.py`](scripts/deploy.py) archives a clean git commit, builds client + Bun server bundle, writes `dist/previous-release.json` for zero-downtime asset continuity, atomically swaps `current`, verifies `/api/health/ready`, and rolls back automatically on failure.

## Household experience

The web home lists every assistant with its latest message and unread indicator across devices, with pinned assistants as large live avatars at the top. Phones open on home and push into a conversation with native Back gestures and View Transitions. Each assistant can be **shared** with the household or **personal** to its owner — nobody else sees a personal assistant in lists, Today, search, notifications, routines, or group chats.

<!-- Main assistant: begin -->

Each member can make one of their own personal assistants their **main assistant**, on
web and iOS. It leads home with a **Main** mark, is first in the command palette, whose
Ask entry sends typed words to its draft, and hands specialist work to the member's
other assistants via `message_bot`. A hand-off to a shared assistant asks the member first, because the
whole household can read that chat. **Check in with me** in its details runs a quiet
routine every 1 to 4 hours that speaks only when something needs the member and stays
silent overnight in their timezone (`[SILENT]` suppresses delivery). A main assistant's routines post only in its own chat.
Every assistant receives and is enforced against its own delegation roster, so another member's personal assistant never appears in its instructions or
receives its messages. See [main assistant](docs/HouseholdExperience.md#main-assistant).
<!-- Main assistant: end -->

### Harnesses, models, and memory

- **Harnesses:** Assistants run on Antigravity (ACP), Codex, Claude Code, Grok, or Pi. When a primary harness fails before streaming a reply, WildBots can automatically fall back to a configured OpenRouter/Pi fallback model.
- **Models & inference:** Assistant settings and the chat header model chip (in Advanced presentation) pick models, reasoning effort, and speed tier where the harness supports them.
- **Memory & skills:** Each assistant keeps editable SQLite memory and skills (`Memory & learning` in settings), injected into its system prompt and readable/updatable via the `wildbots` MCP server.
- **Message queue & steering:** Harnesses with native steering accept mid-turn guidance; others queue messages cleanly above the composer so each waiting message can be edited, reordered, sent immediately, or cancelled.

### Group chats and routines

- **Group chats** let 2–6 assistants collaborate in one persistent room with `@handle` addressing, thread replies, shared purpose/notes, and optional lead routing. Rooms sit beside assistants on home with live previews and overlapping member avatars.
- **Routines** run on cron, interval, or one-shot schedules via `NativeScheduler` (`src/server/scheduler.ts`), supporting prompts, scripts, or script-assisted prompts.
- **Routine → Group delivery:** Routines can target one or more group chats (subject to household privacy rules so a personal assistant never leaks into a room others can open). Routine posts render under the routine's name with a `Routine` tag and wake assistants in the room only when explicitly `@mentioned`.

### Shared computer, vault, and integrations

- **Shared computer:** Enable with `COMPUTER_DESKTOP_ENABLED=true`. Supervises a loopback `Xtigervnc` display and persistent Chrome/Chromium profile controlled over CDP, streamed to web and iOS via `/api/computer/desktop/ws` with human **Take over** / **Hand back** and touch gestures on phones. Terminal administrators also get a fresh-auth-gated host shell (`/api/computer/terminal/ws`).
- **Encrypted login vault:** Assistant settings > **Access** stores per-assistant website logins and optional TOTP secrets encrypted at rest with AES-256-GCM (`WILDBOTS_VAULT_KEY`). Assistants can list metadata (`vault_list_logins`) and sign in on the shared browser (`vault_login_fill`, `vault_totp_fill`) only when the active page origin matches the saved origin; raw secrets are never exposed to `secret_get` or chat transcripts and are automatically redacted from logs.
- **Integrations & custom MCP:** Settings > **Integrations** manages per-assistant API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `BRAVE_API_KEY`, `GITHUB_TOKEN`) and custom HTTP MCP servers (`none` or encrypted `bearer` token). Added MCP servers are enabled and attached automatically to that assistant's harness sessions.

### Live voice, Today, Search, and interactive replies

- **Live voice & Talk:** Direct OpenAI Realtime and xAI Grok Voice power live spoken **Talk** sessions, plus OpenAI voice transcription and spoken replies on web and iOS.
- **Today & Search:** **Today** gathers pending decisions, scheduled work, recent results, and generated files across visible assistants with cross-device **Mark caught up**. **Search & saved** runs SQLite FTS over transcripts, attachments, and routine previews.
- **Interactive replies:** Assistants can emit inline HTML views (charts, calculators, diagrams), checklists, itineraries, forms, T3 Code thread cards, and email drafts.

<!-- BEGIN draft revisions -->

When an assistant revises an email draft from earlier in the chat, the new draft
marks the words it added and removed, with **Hide changes** to read it clean.
<!-- END draft revisions -->
<!-- BEGIN reply files -->

A reply whose turn produced files it does not already show as attachments lists
them as chips under it, up to four and then **+N more**. A chip opens Artifacts on
that file; **+N more** opens the whole list. Files you shared yourself are not chips.
<!-- END reply files -->

### Notifications & multi-account browsers

<!-- BEGIN device activity -->

Notifications go to the device you are using. While a browser window is focused
and touched in the last five minutes, or the iOS app is open and touched in the
last five minutes, only those devices get the alert; your other iPhones and iPads
get the new badge count silently, and other browsers update theirs when you next
open the app. With no device in use, or none of those able to receive it, every
device gets it as before. Security alerts always reach every device. See
[Device activity](docs/native-api.md#device-activity).
<!-- END device activity -->

Web Push notifications switch an open window directly to the chat without reloading. Shared browser profiles track account changes via `agent-interface:auth-epoch` and Web Locks so switching accounts unmounts previous state, clears cached rosters/themes/badges, and prevents cross-account leakage across tabs and back-forward cache restores.

## Run locally

Use Node 24.22+ (or 26.13+) and npm (`.node-version` selects the tested Node 24 LTS release), or Bun 1.4.5+ for the bundled production server.

```sh
npm ci
npm run setup
npm run build
npm start
```

- `npm run setup` configures a private `.env` with Google sign-in + `HOUSEHOLD_EMAILS` allowlist (or `LOCAL_DEV_AUTH=true` for loopback development) and checks harness availability.
- `npm run doctor` checks the active configuration, database, and available harness binaries.
- For hot reload, set `APP_ORIGIN=http://127.0.0.1:5173`, run `npm run dev` and `npm run dev:client` in separate terminals, and open port 5173.
- To build and smoke-test the Bun server bundle:

```sh
npm run build
npm run build:server:bun
npm run smoke:bun
```

## Deploy

Deploy any git ref to a Linux host with atomic symlink swap, `dist/previous-release.json` asset continuity, health check, and automatic rollback:

```sh
python3 scripts/deploy.py --host hermes-prod --ref main
```

Use `--dry-run` to preview the exact commit and release name without touching the remote host. See [docs/Hosting.md](docs/Hosting.md) for systemd service setup, backups, environment variables, and operational notes.

## WildBots for Mac

[`mac/`](mac/) holds WildBots for Mac, a menu bar app that lets your personal assistants run commands, read and write files in folders you choose, and take a screenshot on your Mac, unattended when you allow it. The Mac decides what each assistant may do and connects out to this server, so it needs no open port. Enable on the server with `MAC_LINK_KEY`; see [docs/MacLink.md](docs/MacLink.md).

## Native iOS

The SwiftUI app lives in [`ios/`](ios/). It uses the same authenticated API, bot settings, group chats, shared computer viewer, Siri/Shortcuts/Spotlight integration, Widgets, Share Extension, and APNs/Live Activities as the web client. See [ios/Parity.md](ios/Parity.md) and [docs/native-api.md](docs/native-api.md).

- **Direct LAN & tailnet routes:** Set `DIRECT_ROUTES=lan`, `tailnet`, or `lan,tailnet` (with `DIRECT_PORT`, default `3443`) so the iOS app connects directly over the household LAN or Tailscale using a pinned self-signed certificate while keeping sign-in on the HTTPS origin.
- **Update banner:** Set `IOS_APP_LATEST_BUILD` and `IOS_APP_UPDATE_URL` to notify iOS users when a new TestFlight build is available.

## Web UI architecture & offline cache

- **Shared controls:** `src/components/ui` (Tailwind 4 with `tw:` prefix + shadcn tokens mapped to WildBots CSS variables; Base UI menus stay lazily loaded outside the initial bundle).
- **Drawn avatars:** 54 flat-silhouette shapes across Classic, Objects, Creatures, and Seasonal, shared across web and iOS ([docs/AvatarShapes.md](docs/AvatarShapes.md)). Standalone specimen at `/avatar-specimen/` in Vite dev.
- **Service worker & fast boot:** `public/boot.js` starts `/api/bootstrap` and applies the saved theme before app JS loads; `scripts/service-worker.js` caches the app shell, warms lazy chunks in the background, serves retired assets from `dist/previous-release.json` across deploys, and offers **Refresh** when a new release installs.
- **Crash reports:** Web render/runtime errors and iOS MetricKit crashes/hangs report to `POST /api/client-errors`.

## Validate

```sh
npm run verify:ci          # lint, typecheck, build, and Vitest in parallel
npm run build:server:bun   # Bun server bundle
npm run smoke:bun          # Bun runtime smoke test
npm run test:py            # Python unit tests
npm run lint:py            # Ruff check (Python 3.12 target)
npm run test:e2e           # Playwright Chromium + WebKit smoke suite
.agents/tools/check-all    # Full local validation gate (handles WebKit container on Fedora)
```

- `npm run typecheck` uses pinned Oxc `tsrs --noEmit`.
- Vitest runs all application tests with `isolate: false` in shared workers. Replay file order with `npm test -- --sequence.shuffle.files --sequence.seed=731 --maxWorkers=1`.
- Direct-route tests listen on `127.0.0.2` (built-in on Linux; on macOS add `sudo ifconfig lo0 alias 127.0.0.2 up`).
- See [docs/ledger/README.md](docs/ledger/README.md) for validation logs and red-run proofs, and [docs/Dependencies.md](docs/Dependencies.md) for tool versions.
