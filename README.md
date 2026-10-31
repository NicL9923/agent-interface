# WildBots

WildBots is a web client and native iOS app for a shared Hermes installation. The repository and internal identifiers keep the original `agent-interface` name. Each bot has a
persistent conversation, configurable instructions and capabilities, and an avatar
that reflects its current state. Each household member has separate preferences,
drafts and notification subscriptions.

Household installation: [agentui.wildflowersranch.com](https://agentui.wildflowersranch.com).

The web home lists every assistant with its latest message. A dot marks a chat you
have opened before that has a newer message than your last read, on any of your
devices. Pin assistants to show them as large live avatars at the top. In a conversation, the assistant's avatar and
name in the header open its details: Pin, Artifacts, Settings, "Notify me about all
activity" and its home section. Long-press (right-click on a computer) an assistant
on home to pin it or move it to a section. Phones open on home and push into a
conversation; Back returns. The account button opens Settings, which also holds Hermes
updates, Computer, Integrations, the assistants you follow and your home sections.
Each assistant can be in one section. New assistants start with their name and look,
then role and model.

The self-hoster connects this server to Hermes once. Web users sign in to that
installation. iOS users enter its HTTPS address, then sign in to the same
household. The app keeps the sign-in alive while it is used, up to 90 days after
signing in with Google. The mobile app connects to this server, not directly to Hermes.

Web assistant settings load model options from the connected Hermes profile.
The selected provider starts expanded. Search the catalog, refresh it after
changing connected providers, and star models to keep personal favorites. Shared assistants keep one shared model. Existing selections remain
saved when a provider is unavailable, and Hermes model warnings still require
confirmation. In Advanced presentation, the model button in the web and iOS composers switches
the assistant's model from the same catalog without opening settings. Both pickers control reasoning effort and Normal/Fast/Ultrafast speed for the current
conversation. The native picker includes search, provider groups, refresh and model favorites. Hermes validates support for the selected model.

An assistant is either shared with the household or personal. A personal assistant
is private to its owner in WildBots: nobody else sees it in lists, Today, search,
notifications, automations, routines or group chats, or can open it. Anyone may make
a shared assistant personal after confirming it will disappear for everyone else;
only its owner can share it again. Personal assistants created before owners were
recorded stay visible to everyone. WildBots hides a personal assistant, but the
Hermes dashboard is household-wide, so anyone with dashboard access can still reach
its memory and logins.

Web Settings > Notifications shows whether this account has notifications enabled
on the current device. Turn the browser switch on or off there. The iOS app asks the
same question in its own card after household sign-in when the server supports Apple
push, shows the system permission prompt only after Enable, and has the same switch
in Settings. Manage device permission in iOS Settings. A new browser asks once
whether to enable notifications and explains where to change the setting later.
On iPhone or iPad, add the app to the Home Screen and open it before enabling
notifications.

A chat you have open and are using sends no notifications to any of your devices.
Reading a chat on one device stops its pending notifications to the others and
removes its delivered ones from your iPhone and iPad. A browser tab counts while
it is focused and has had input in the last five minutes.

The browser tab title, favicon and installed app, and the iPhone and iPad app icon,
show how many assistants have unread messages or a decision waiting for you. A web
approval notification offers **Review** and **Decline** where the browser supports
notification buttons, as the iOS notification does. Decline works without opening
the app and can only decline that one request.

## Run locally

Use Node 24.22 or 26.13 and npm. `.node-version` selects the tested Node 24 LTS
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

## Web UI components

Shared controls live in `src/components/ui`, with shadcn configuration in
`components.json` and Base UI handling context menus and popovers. Keep the
existing WildBots colors, typography and spacing when adding controls.

Base UI is not part of the first load. Import its components only from modules the
entry reaches through `import()`, such as the assistant menu in `src/app/BotMenuPopup.tsx`.
Until that menu has loaded, `src/app/BotMenu.tsx` stands in for it and catches the first
right click, menu key or long press, so none is lost. `npm run build` fails when Base UI
returns to the entry's static imports.

### Offline cache

`scripts/build-worker.mjs` turns `scripts/service-worker.js` into `sw.js`, and
`scripts/precache-plan.mjs` sorts the built files into three groups. The install step
fetches only the pages and the static import graph of both HTML entries, which is enough
to open offline without racing the first visit. Install fails, and the browser retries it
later while the old worker keeps serving, if any of those files is an error or comes back
as `text/html` in place of code. Lazy screens and libraries are fetched in the background,
three at a time, when the page posts `{ type: "WARM" }` to the active worker after it goes
idle. The worker runs that under `waitUntil` so the browser keeps it alive, never delays
activation for it, and skips files already cached, so any later page load finishes what a
stopped run missed. The terminal and remote desktop chunks wait for first use. A file that
was never warmed is kept after its first use, unless it is an error or `text/html`.
Installing a release copies every hashed `assets/name-HASH.ext` file already held by an
earlier release's cache instead of downloading it again. The pages, icons, manifest and
unhashed files are always fetched fresh. The worker's hashed-name rule must match
`src/server/static-cache.ts`; a test compares them.

Tailwind 4 uses the app's CSS tokens through `src/ui.css`. Utilities have a `tw:`
prefix so they cannot collide with existing semantic class names. Preflight is
omitted to preserve native control styling. Keep custom layout, avatar and
markdown CSS where it is clearer than utilities.

Standard shadcn color utilities map to the live WildBots palette: `primary` is
the brand green, `accent` is its soft hover background, and `muted` is a quiet
surface. Use `tw:text-muted-foreground` for subdued text or `tw:text-brand` for
the brand color. Dark variants follow the app's light, dark and system setting.

Preview additions with `npx shadcn@4.22.0 add <component> --dry-run --diff`, then adapt
the generated component to the existing controls, icons and styling. Registry
items can also change `src/ui.css`. The stock card leaves it alone, while custom
items that supply theme variables can append `:root` and `.dark` palettes.
Keep the existing token mappings and dark variant. Map any needed new colors
to app tokens instead of accepting those generated palettes. Do not run preset
or theme initialization over this file.

The `cn` helper and `@/` alias support generated shadcn components. Native
wrappers forward existing classes directly, so they do not load the class
merging helper at startup.

Use the shared `Button`, `Input`, `Textarea` and `NativeSelect` controls in the
migrated settings and panels. `Button` defaults to `type="button"`; form submit
actions must explicitly use `type="submit"`. The shared `Dialog` preserves the
native top layer and owns opening, closing and focus restoration. Pass `open`
for panels that stay mounted while hidden. Nested overlay wrappers inherit the
dialog as their portal container.

## Connect Hermes

Hermes runs separately from this application. Guided setup saves `HERMES_URL` and
`HERMES_TOKEN` on the app server. An existing HTTPS gateway is supported; cleartext
HTTP is restricted to loopback. Provider credentials remain in Hermes. Open
**Integrations** to inspect the selected profile's accounts, check their health,
and connect or reconnect supported services. Connection changes require an
integration administrator. See the [integration guide](docs/Integrations.md) for
supported services, one-time hosting configuration and device limitations.

The [shared computer](docs/SharedComputer.md) provides one persistent desktop and
browser for all assistants, with human takeover for every household member and a
real VPS terminal for terminal administrators. The iOS app shows the desktop on its
own Computer screen with Take over and Hand back; the terminal still opens in Safari.

The [capability matrix](docs/HermesCapabilityMatrix.md) records the tested upstream
revision, native integration probes, and the small revision-bound extension for
durable admission receipts and event discovery. Read its compatibility and
rollback instructions before using that extension. The app does not directly
edit Hermes databases or take over execution from an existing Hermes owner.
Setup connects to an existing compatible owner; it does not install Hermes or
change its supervisor. A missing add-on, incompatible revision, rejected token,
or unreachable gateway gets a distinct diagnostic. When Hermes rejects the server's
token, requests fail with 502 and keep people signed in to the app.

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

After a new release, the web app shows **Update available** at the top of home, and
above the conversation on phones, until you choose **Refresh**. An open tab or installed
app checks for a new release every 30 minutes and whenever it returns to the foreground.
Drafts are saved before it reloads. The iOS app shows the same notice with an **Update**
link when the host sets `IOS_APP_LATEST_BUILD` and `IOS_APP_UPDATE_URL`; see the
[native API contract](docs/native-api.md#app-updates).

During an outage, the app retains loaded conversations and personal drafts,
rechecks the connection automatically, and refreshes when the browser comes back
online or into view. Manual reconnect checks immediately. The transport bounds
stalled requests and backs off repeated failures. It never automatically replays
messages or configuration changes; uncertain admissions are reconciled through
Hermes's durable receipts.
Known native admission refusals return the message to its draft. Crashes and
unrecognized native errors keep the saved request ID for receipt checks.

## Household experience

The app opens **Today** unless you choose an assistant start page or follow a notification. Today shows pending decisions, scheduled work, recent results and files
across your assistants. **Mark caught up** shares your recap position between
web and iOS. Voice messages are transcribed into a draft for review before you
send. **Listen to reply** reads the latest reply with Hermes speech on web and iOS.

Hermes questions on web and iOS show each suggested answer as a card to tap, with
**Write my own answer** last. A question that allows several answers shows checkboxes.
On a computer, number keys pick an option. Choosing an answer moves on to the next
question, and Send answers waits until every question has one.

**Search & saved** searches native answers, attachment names, and routine previews across your visible assistants as you type. A match in an assistant's current conversation opens that chat at the message. Open original history, page through older messages, and save a conversation, reply, or routine output. Saved items belong to your account and hold references rather than copied transcripts.

Its **Automations** tab lists next runs, recent execution or delivery failures, result recipients, and pause/resume controls. Usage shows Hermes's recorded main-session tokens, reported cost, and estimates separately. Missing cost reporting stays unknown. Simple conversations show tool receipts with the native outcome and any reported result link.

Attach images, PDFs, and text files with the paperclip, by pasting a screenshot or copied file into the message box, or by dropping files anywhere on the conversation. Markdown and CSV files are sent as plain text. Each attachment shows a thumbnail or file card with its upload progress; select an image to preview it. A message holds up to 10 files of up to 20 MB each. Unsupported files are explained instead of uploaded, and a failed upload offers Retry and blocks Send until you retry or remove it, so a message never goes out without a file you meant to include.

An empty conversation on web and iOS offers a role discussion using the assistant's description and adds it to the draft. Settings include a start page, quiet hours in your timezone, and notification batching. Quiet hours delay notifications except security alerts; decisions and failures skip batching outside them. Digest notifications open Today.

The native iPhone app includes a share extension for webpages, photos, PDFs, and text. Choose an assistant, save the share, and open the app to review and add it to a draft. The extension shares no sign-in token. Existing draft content is kept, and nothing sends automatically. HEIC and other unsupported image formats convert to a bounded PNG. Device installation requires the app and extension to be signed with the shared App Group.

The iPhone and iPad app also works with Siri, Shortcuts and Spotlight: ask WildBots to open an assistant or Today, or to put a question in an assistant's draft for you to review and send. Assistant names show in Spotlight search, and the Assistants widget can be edited to show only the assistants you choose. None of these hold your sign-in token, and they clear when you sign out. An iPad with a keyboard opens pinned assistants with Cmd+1 to 9 and any destination with Cmd+K.

Assistant settings > **Memory** lets you inspect, correct and forget native
Hermes profile memory. Existing conversations keep their memory snapshot until
a new Hermes session starts. In **Details**, enable interactive replies to add
checklists, itineraries and reviewed calendar proposals to assistant answers.
Your checks and itinerary notes are saved for your account.

Assistant replies can also contain interactive charts, calculators, diagrams and
small tools inline on web and iOS. These generated views follow your theme and
resize to their content. **Reset view** starts over, and **View source** shows the
HTML. Their controls affect only the view; changes reset when you reopen the
conversation. Hermes receives the format instructions automatically in WildBots
conversations. See [inline views](docs/HouseholdExperience.md#inline-views) for
the reply format and supported behavior.

**Routines** includes morning brief, meal plan and VPS health recipes, schedule
previews in the actual Hermes timezone, and **Try once** with durable run
receipts. See the [household experience guide](docs/HouseholdExperience.md) for
controls, supported reply cards, voice requirements and recovery behavior.

Routine **Advanced** options include skills, model/provider pins, toolsets,
profile scripts, script-only runs and context from other routines. Assistant
settings > **Work** manages standing goals, native tasks and event triggers.
**Learning** previews installed skills and reviews proposed changes. New work
requires an explicit start. Memory edits apply to the canonical conversation at
the next safe turn boundary, with pending/applied status and preserved history.

Use **View results** beside a routine to read its saved runs, including trials.
Routine notifications name the routine and quote the start of its answer, or the
error for a failed run, and open this history directly. Results stay within the selected
Hermes profile; a run with only a saved preview says so.

**Group chats** lets 2–6 local assistants discuss a task in one room. Create a
named group, address assistants with `@handle` (typing `@` suggests members),
reply in a thread, approve a pending action or stop the discussion. Messages show
which household member sent them, and new messages arrive live. Hermes owns the persistent coordinator.
If that coordinator is unavailable, rooms remain readable and sending is disabled.
After an uncertain send or creation, retry the saved request to check its status
without creating a duplicate. Conversation activity keeps bot messages, scheduled-job handoffs, subagents,
background processes, and diagnostics in separate collapsed sections in both
presentations. Expand them to inspect the original input and results. Scheduled
answers stay in the conversation with a Scheduled label. Decisions and requests
for input stay visible. Unknown messages from other clients remain in chat;
only recognized automation sources move into activity.

Assistant settings > **Logins** manages the selected Hermes profile's encrypted
login vault. Native login, code, vault-unlock and secret requests appear inline
with masked fields, outside chat and drafts. Ownership and source controls follow
Hermes. See [passwords and logins](docs/PasswordsAndLogins.md) for storage scope,
external password managers and uncertain-request recovery.

## Chatting

Each finished reply offers **Copy reply**, **Share reply** where the device can share,
**Save reply** and **Quote in reply**. On a computer they appear when you point at or
tab to the reply; on touch screens and in the iOS long-press menu they are always
there. Select part of a web reply to quote just that part. Code blocks are colored by
language, and tables can be copied as Markdown or CSV.

When a reply fails, **Retry** under it sends your message again without touching
your draft. A failed turn can be retried once, by anyone, from any device: a second
tap, tab or phone gets the first retry's result instead of starting another turn.

After you send, your message moves near the top and the reply grows below it.
Scrolling up stops the view from following; it follows again once you return to
the end. Each finished turn folds its tool calls and delegated work into one row,
such as "Worked for 2m 14s · 3 tool calls". Expand it for the details. While the
assistant works, one live line shows its current tool and, in Advanced, its latest
reasoning. Decisions and requests for input stay outside the fold.

**Find in chat** (Cmd/Ctrl+F on web, Find on iOS) matches loaded messages at once and
adds older matches from the conversation's history; choosing one opens the chat at
that message. A status area above the message box gathers send problems, the
interrupted-task review, waiting decisions with **Review**, and connection trouble,
most urgent first.

On a computer, Cmd/Ctrl+K opens a command palette for assistants, Today, Group chats,
Search, Settings and appearance. Cmd/Ctrl+1 to 9 open pinned assistants in the
installed app (browsers keep those keys for tabs), Cmd/Ctrl+. stops the current
reply after asking, and `?` lists every shortcut. An iPad with a keyboard has Cmd+K
"Go to…" and Cmd+1 to 9. In an empty message box, Up recalls your earlier messages
in that chat. Pasting 32 KB of text or more attaches it as `Pasted text.txt`. Pinning
or moving an assistant on home shows Undo for five seconds. Web text follows the
browser's text size setting.

## Hermes updates and activity

Open Hermes and updates in web Settings, or Hermes updates in iOS
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

The add-on turns off the native Hermes dashboard's own updater, which would skip
qualification and disable the add-on. The dashboard hides its update control, and
its update routes refuse with a message pointing to the app. Running
`hermes update` on the host still bypasses the app; the capability matrix
describes recovery.

Conversations show an animated avatar inline after the latest message while
Hermes thinks or uses tools. Thinking keeps the character visible with a gentle
tilt and upward gaze. Completed work leaves the final reply without a separate
Done status. Tool calls and delegated work appear in counted accordions inside each turn's fold.
Advanced view adds tool inputs, outputs, errors and timestamps, plus reasoning
Hermes exposes. Approval buttons show submission feedback immediately. Stop
replaces Send while a response is active and the draft has no text or attachments;
adding a draft brings Send back for guidance. Sending spins the Send button; a
notice with Retry appears only when a send ends without a receipt. Replies do not
repeat the assistant's name, and tool-call rows without reply text stay in the
tool accordion. While a recognizable tool runs, the web avatar holds a small prop:
a magnifying glass for search and browsing, a laptop for terminal and code, a book
for reading, or a notepad for writing. Disconnecting marks activity unknown;
the last tool event is not evidence that execution is still running.

Mascot avatars offer eight everyday characters: Bear, Fox, Sprout, Panda, Raccoon,
Owl, Cactus and Dinosaur. They take whichever color you choose; a panda keeps its
white face and wears the color on its ears and eye patches. Ten seasonal characters
follow under their own heading in calendar order: Leprechaun, Easter Bunny, Bald
Eagle, Pumpkin, Bat, Ghost, Turkey, Santa, Rudolph and Snowman. Both web and native
iOS offer every character. Each keeps its character during working/thinking
animation and supports the existing eye and accessory controls. Choosing a seasonal
character applies its default color and preserves your other customization. Very
light heads get a soft edge so they stay visible on the light theme. All use
original artwork.

Open Artifacts from the assistant's details (tap its name in the conversation header) to browse its generated
outputs and shared attachments. Search filenames, filter by type, and preview
images, text, or supported media. PDFs and other files can be opened or downloaded.
External file sources open only when you choose their link.

## Validate

```sh
npm test
npm run test:py
npm run lint:py
npm run build
python3 .agents/tools/source-state.py
```

`npm test` runs the application tests with Vitest. `npm run test:py` runs every
Python test file it discovers in `tests/*_test.py`, `scripts/*-test.py` and
`scripts/spike/*_test.py`, one subprocess each, and fails if a test-looking file
sits outside those paths. Pass file paths to run a subset, for example
`npm run test:py -- tests/hermes_vault_test.py`. Use Python 3.14, which the
Hermes host runs. Test files use `unittest`, and a file passes only if at least
one test ran. A file whose tests all skip, such as the system terminal test
without `tmux`, shows SKIP locally and fails when `CI=true`.
`npm run lint:py` runs ruff for undefined names and likely bugs. Install the
version pinned in `.github/requirements-ci.txt`. CI runs both in its Python job.

The [validation ledger](docs/ledger/README.md) distinguishes application tests,
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
