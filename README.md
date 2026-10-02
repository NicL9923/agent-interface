# Agent Interface

A web client and native iOS app for a shared Hermes installation. Each bot has a
persistent conversation, configurable instructions and capabilities, and an avatar
that reflects its current state. Each household member has separate preferences,
drafts and notification subscriptions.

Household installation: [agentui.wildflowersranch.com](https://agentui.wildflowersranch.com).

The self-hoster connects this server to Hermes once. Web users sign in to that
installation. iOS users enter its HTTPS address, then sign in to the same
household. The mobile app connects to this server, not directly to Hermes.

Web assistant settings load model options from the connected Hermes profile.
The selected provider starts expanded. Search the catalog, refresh it after
changing connected providers, and star models to keep personal favorites. Shared assistants keep one shared model. Existing selections remain
saved when a provider is unavailable, and Hermes model warnings still require
confirmation.

Preferences > Notifications shows whether this account has notifications enabled
on the current device. Turn the switch on or off there. A new browser asks once
whether to enable notifications and explains where to change the setting later.
On iPhone or iPad, add the app to the Home Screen and open it before enabling
notifications.

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
HTTP is restricted to loopback. Provider credentials remain in Hermes. Open
**Integrations** to inspect the selected profile's accounts, check their health,
and connect or reconnect supported services. Connection changes require an
integration administrator. See the [integration guide](docs/Integrations.md) for
supported services, one-time hosting configuration and device limitations.

The [shared computer](docs/SharedComputer.md) provides one persistent desktop and
browser for all assistants, with human takeover and a real VPS terminal in the UI.

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

## Hermes updates and activity

Open the connection status in the web sidebar, or Hermes updates in iOS
Preferences. Administrators can check the next official Hermes revision before
choosing to upgrade. Checking stages the exact source and tests it in a disposable
home. It never installs an update. Progress survives closing the client and
restarting the app server. An uncertain request is reconciled without replay.

The installer must enable the [Linux upgrade hooks](docs/HermesUpgradeLinux.md)
and administrator allowlist first. Installation waits for native work to finish,
backs up the current source and runtime, and verifies the original sign-in and
connections before releasing maintenance. Failed verification restores the
previous version when rollback is safe. A failed or uncertain recovery keeps
maintenance closed. Administrators can retry a failed update, request safe
cancellation, or restart and verify Hermes when the recorded operation allows it.
Cancellation restores the previous version when needed; recovery never clears
maintenance without verifying the resulting runtime. Unverifiable legacy failures
still require installer repair. The app does not silently update Hermes.

Conversations show an animated avatar inline after the latest message while
Hermes thinks or uses tools. Thinking keeps the character visible with a gentle
tilt and upward gaze. Completed work leaves the final reply without a separate
Done status. Advanced view adds collapsed tool inputs, outputs, errors and
timestamps, plus reasoning Hermes exposes. Disconnecting marks activity unknown;
the last tool event is not evidence that execution is still running.

Avatar settings include Pumpkin, Santa, Rudolph, Turkey and Easter Bunny
in both web and native iOS. The web picker groups these under Seasonal. Each keeps its character during
working/thinking animation and supports the existing eye and accessory controls.
Choosing a seasonal character applies its default color and preserves your other
customization. All five use original artwork.

Open Artifacts in the conversation header to browse that assistant's generated
outputs and shared attachments. Search filenames, filter by type, and preview
images, text, or supported media. PDFs and other files can be opened or downloaded.
External file sources open only when you choose their link.

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
