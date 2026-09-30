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
cp .env.example .env
npm run build
npm start
```

Open `http://127.0.0.1:3000`. For local browser testing, set
`LOCAL_DEV_AUTH=true` in `.env`. This exposes two explicitly named local test
identities. The server refuses that setting in production or on a non-loopback
host. With no Hermes connection, the app shows its disconnected state.

For hot reload, set `APP_ORIGIN=http://127.0.0.1:5173`, run `npm run dev` and
`npm run dev:client` in separate terminals, and open port 5173. Vite proxies API
requests to the app server. The built application serves its API and static files
from one Fastify process.

## Connect Hermes

Hermes runs separately from this application. Set `HERMES_URL` and
`HERMES_TOKEN` on the server. Keep provider credentials in Hermes, and establish
new provider or service connections through the official Hermes interface.

The [capability matrix](docs/HermesCapabilityMatrix.md) records the tested upstream
revision, native integration probes, and the small revision-bound extension for
durable admission receipts and event discovery. Read its compatibility and
rollback instructions before using that extension. The app does not directly
edit Hermes databases or take over execution from an existing Hermes owner.

Google sign-in requires `GOOGLE_CLIENT_ID` and an explicit comma-separated
`HOUSEHOLD_EMAILS` allowlist. Production requires HTTPS. Web Push additionally
requires the three `VAPID_*` settings in `.env.example`. Accounts, credentials,
runtime databases and private operating notes stay outside this repository.

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

The standalone [avatar specimen](avatar-specimen/index.html) is available at
`/avatar-specimen/` in the Vite development server. Its
[reference inventory](docs/AvatarReferenceInventory.md) records observed geometry,
controls, motion and reuse restrictions. All shipped avatar artwork is original.

The [settled plan](docs/Plan.md) remains the scope and acceptance brief.
Implementation and validation are local; production deployment is separate.
