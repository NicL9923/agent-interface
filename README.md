# Agent Interface

An installable web client for a shared Hermes installation. Each bot has a
persistent conversation, configurable instructions and capabilities, and an avatar
that reflects its current state. Each household member has separate preferences,
drafts and notification subscriptions.

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
on both supported Node versions. The isolated Hermes probes remain a separate
explicit run using the capability matrix's reproduction instructions.

The standalone [avatar specimen](avatar-specimen/index.html) is available at
`/avatar-specimen/` in the Vite development server. Its
[reference inventory](docs/AvatarReferenceInventory.md) records observed geometry,
controls, motion and reuse restrictions. All shipped avatar artwork is original.

The [settled plan](docs/Plan.md) remains the scope and acceptance brief.
Implementation and validation are local; production deployment is separate.
