# Agent Interface

A web client and native iOS app for a shared Hermes installation. Each bot has a
persistent conversation, configurable instructions and capabilities, and an avatar
that reflects its current state. Each household member has separate preferences,
drafts and notification subscriptions.

Household installation: [agentui.wildflowersranch.com](https://agentui.wildflowersranch.com).

The self-hoster connects this server to Hermes once. Web users sign in to that
installation. iOS users enter its HTTPS address, then sign in to the same
household. The mobile app connects to this server, not directly to Hermes.

## Run locally

Use Node 24.21 or 26.10 and npm. `.node-version` selects the tested Node 24 LTS
release. The lockfile pins application dependencies. See the
[dependency record](docs/Dependencies.md) for versions and verification.

```sh
npm ci
npm run setup
npm run build
npm start
```

Setup asks for the existing Hermes gateway address and token, then checks access
and compatibility before saving a private `.env`. Token entry is masked. Choose
Google sign-in for the household, or explicitly enable local test accounts for
development. A failed check leaves the previous configuration intact.

Open the app address printed by `npm start`, normally `http://127.0.0.1:3000`.
Household members only need to sign in; they never enter the Hermes token.
Local test accounts are refused in production or on a non-loopback host.
An unconfigured installation explains how to start setup from its sign-in page.

After changing configuration, restart the app. Use `npm run doctor` for a
read-only check of the active configuration and Hermes connection. It exits with
a failure status and an actionable explanation when something needs attention.
Exported environment settings override `.env`; setup reports conflicting keys
before writing so a saved change cannot silently be ignored.

For hot reload, set `APP_ORIGIN=http://127.0.0.1:5173`, run `npm run dev` and
`npm run dev:client` in separate terminals, and open port 5173. Vite proxies API
requests to the app server. The built application serves its API and static files
from one Fastify process.

## Connect Hermes

Hermes runs separately from this application. Guided setup saves `HERMES_URL` and
`HERMES_TOKEN` on the app server. An existing HTTPS gateway is supported; cleartext
HTTP is restricted to loopback. Keep provider credentials in Hermes, and establish
new provider or service connections through the official Hermes interface.

The [capability matrix](docs/HermesCapabilityMatrix.md) records the tested upstream
revision, native integration probes, and the small revision-bound extension for
durable admission receipts and event discovery. Read its compatibility and
rollback instructions before using that extension. The app does not directly
edit Hermes databases or take over execution from an existing Hermes owner.
Setup connects to an existing compatible owner; it does not install Hermes or
change its supervisor. A missing add-on, incompatible revision, rejected token,
or unreachable gateway gets a distinct diagnostic.

For a Google-protected Hermes dashboard, run this app on the same host and use
the private service connection described in the capability matrix. This keeps
the permanent server credential separate from expiring household Google
sessions. The original dashboard retains its Google sign-in and address.

Google sign-in requires `GOOGLE_CLIENT_ID`, the app origin registered in the
Google OAuth client's authorized JavaScript origins, and an explicit comma-separated
`HOUSEHOLD_EMAILS` allowlist. Setup collects the client ID and household emails;
Google's external configuration remains a separate step. Production requires HTTPS. Web Push additionally
requires the three `VAPID_*` settings in `.env.example`. Accounts, credentials,
runtime databases and private operating notes stay outside this repository.

During an outage, the app retains loaded conversations and personal drafts,
rechecks the connection automatically, and refreshes when the browser comes back
online or into view. Manual reconnect checks immediately. The transport bounds
stalled requests and backs off repeated failures. It never automatically replays
messages or configuration changes; uncertain admissions are reconciled through
Hermes's durable receipts.

## Validate

```sh
npm test
npm run build
python3 .agents/tools/source-state.py
```

The [validation ledger](docs/ValidationLedger.md) distinguishes application tests,
real Hermes execution using a deterministic local provider, visual checks, and
acceptance that needs a physical phone or configured external service. Tests with
a runtime double do not prove Hermes integration. Simulated push checks do not
prove delivery to an installed phone app while it is closed.

Pull requests run the application tests, production build and Python syntax checks
on both supported Node versions. Native builds and simulator tests run on the
Mac mini using Xcode 27.0. The isolated Hermes probes remain a separate
explicit run using the capability matrix's reproduction instructions.

The standalone [avatar specimen](avatar-specimen/index.html) is available at
`/avatar-specimen/` in the Vite development server. Its
[reference inventory](docs/AvatarReferenceInventory.md) records observed geometry,
controls, motion and reuse restrictions. All shipped avatar artwork is original.

The [settled plan](docs/Plan.md) remains the scope and acceptance brief.
Nicolas authorized hosting this application at `agentui.wildflowersranch.com`
on the existing Hermes VPS. The [deployment record](docs/Hosting.md) tracks
that installation and any remaining acceptance steps.

## Native iOS

The SwiftUI app lives in [`ios/`](ios/). It uses the same authenticated application
API, bot configuration and canonical conversations as the web client. Its
[parity record](ios/Parity.md) distinguishes implemented features, simulator
checks and external acceptance.

Connect to the app server's HTTPS origin. HTTP is limited to loopback development,
including an iOS simulator on the server's Mac. A physical phone needs an HTTPS
address it can reach. Household sign-in opens the system authentication browser;
the resulting app token stays in Keychain, scoped to that server.

Native notifications require the `APNS_*` settings in `.env.example` and a signed
app whose bundle ID and APNs environment match the server. The
[native API contract](docs/native-api.md) documents sign-in, expiry and device
registration. Apple signing and closed-app notification delivery on a physical
phone remain external acceptance work. Adding the app does not deploy the server
or configure an Apple account.

The [runtime assessment](docs/HarnessAssessment.md) records the tradeoffs in
keeping Hermes, replacing it, or wrapping existing executors such as Codex and
Claude Code. Hermes remains the current execution owner.
