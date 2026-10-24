# Native iOS client

WildBots' native SwiftUI client supports iPhone and iPad on iOS 17 or
later. It uses the same authenticated app server and canonical Hermes
conversations as the web client. There are no third-party dependencies or embedded
web views. Household sign-in opens Apple's system authentication browser.

Open `AgentInterface.xcodeproj` in Xcode and choose the shared `AgentInterface`
scheme. Connect to the self-hosted **app server**, for example
`https://agentui.wildflowersranch.com`. A bare host defaults to HTTPS. HTTP is
accepted only for localhost development. Hermes and provider credentials stay on
the server.

**Settings > Computer** opens the configured
app server's shared desktop and VPS terminal in the system browser. The browser
uses its own household sign-in; the native session token is never passed in the
URL. This keeps the native client free of embedded browser and terminal views.

On iPhone, home is the root of one navigation stack: Today, Group chats and Search push from it, and a chat opened from Today or Search goes back there. Drafts are kept as you move around. iPad keeps its sidebar.

Home opens with your avatar for **Settings**, Search, and New assistant.
Pin assistants from their card or by long-pressing an assistant, which also offers
**Move to section**. Pins appear as large animated avatars above the household
links; the remaining list shows each assistant's latest message and date. A chat with
a reply you have not read gets a dot and a bolder row, and VoiceOver reads it as
unread. Opening it clears the mark at once, before the server catches up. Settings
saves changes as you make them.

New assistant is two short steps: name and look, with the full avatar editor and a
live preview, then role and model. Create saves the assistant and then its avatar;
if the avatar save fails, the sheet stays open on that assistant's Avatar settings
with the chosen look and a retry. Portraits are added after creation. In Settings,
**Following N assistants** opens one list of assistants to follow, and **Home
sections** lists each section with its count. Tap a section to rename it, choose its
assistants or delete it. An assistant belongs to one section, so choosing it moves it.
Settings and Hermes updates show when the running and offered Hermes revisions were
released, with the short commit hash as a detail.

A conversation's header shows only the back button and the assistant's live avatar
and name. Tap it for the assistant's card: Find in loaded messages, Pin, Artifacts
and Settings, plus **Notify me about all activity** and its **Home section**. An
assistant sits in at most one section. Cmd+F still opens Find. While typing, the
keyboard button beside Send or a tap on the transcript puts the keyboard away.

Long-press a settled assistant reply to copy the whole answer, share it, or save a reference. Search opens a matching message when Hermes supplies a pointer, including after compression moves it to another history page.

The **Today** screen shows recent canonical events, new replies, pending decisions,
and current work. **Mark caught up** saves the signed-in account's recap position
on the app server. When more results are waiting, mark the displayed page caught
up to load the next page. Late imported events stay visible until acknowledged.
Assistant settings include **Memory** for inspecting and
editing the actual Hermes profile documents, plus routine recipes, timezone and
next-run previews, and a single-tap **Try once** action.

The conversation microphone records up to two minutes. An interrupted recording stays on this device for explicit transcription or discarding, including after reopening the app. Stopping normally transcribes the recording
and adds the text to the draft for review, as on the web. On iOS 26 and later, when Apple's speech model for
the device language is installed, the iPhone transcribes it and the audio never leaves the device; otherwise,
or when that finds no speech, the app server transcribes it. The first recording in a language asks iOS to
download its model for next time. The composer's
**Listen to reply** plays the latest reply through the server's configured Hermes speech and has an explicit Stop control. The paperclip
attaches photos, a new camera photo or files; you can also paste or drop images, and a hardware keyboard's Return sends. An empty conversation offers an editable role discussion. In Advanced presentation, the composer's
model picker searches the profile's model catalog, saves model favorites, and controls
conversation reasoning and speed. Hermes still requires confirmation for warned models. Interactive
reply instructions are opt-in in assistant settings. Checklists and itinerary
notes save to the signed-in app account; calendar proposals open Apple's event
editor for review and an explicit Save.

The **Assistants** widget (Home Screen and Lock Screen) shows who needs you, who is
working and recent conversations from a snapshot the app writes to the shared App
Group; it never holds a sign-in token and asks you to open the app once the
snapshot is 30 minutes old. One aggregate Live Activity shows working and waiting
assistants on the Lock Screen and in the Dynamic Island. It starts in the foreground
after you send, follows server pushes, and respects the device's Live Activities setting in iOS Settings.
On iOS 18 and later the server also starts it when work begins away from the phone, such as a routine or a
message sent from the web. Dismissing it keeps that work off the Lock Screen until a new run starts. When the server publishes a newer build, a banner and **Settings >
About** offer an Update button. Widget and Live Activity taps open
`agentinterface://open?bot=ID`, handled like a notification link.

Notifications show the assistant as the sender, with its avatar, like a person in Messages, so a Focus can
allow WildBots. A notification service extension adds the avatar from pictures the app keeps in the App
Group for the signed-in account; it never holds a sign-in token, and portrait avatars show initials.
Approval requests are Time Sensitive and break through Focus unless you turn that off in iOS Settings.

Edit the Assistants widget to choose which assistants it shows. With none chosen it
follows who needs you first, as before. Each row opens its chat. Neither the widget
nor the app's Siri and Shortcuts actions ever hold the sign-in token: they read the
same App Group snapshot, so their assistants are per account and disappear on
sign-out. **Open assistant**, **Ask assistant** and **Open Today** appear in the
Shortcuts app with phrases that name WildBots, such as "Ask Kitchen in WildBots".
On iOS 18 and later, the **Talk to assistant** control for Control Center, the Lock Screen and the Action
button opens a chosen assistant and starts a voice message (`agentinterface://open?bot=ID&listen=1`).
Ask puts your text in that assistant's draft, opens the chat, and never sends. If a
send to that assistant is still unsettled, the text waits, as text from a
notification's Reply and the Share inbox does, and it lapses after five minutes. Waiting
text joins the draft in the order it arrived, stays on the device for its own account
through a relaunch or sign-out, and never joins another account's draft. Assistant names (no previews) are also in
Spotlight search through Core Spotlight items, and leave it with sign-out or when an
assistant is removed.

Haptics are subtle: a light tap when a send is accepted, a soft success when a reply
finishes in the open chat, a firmer tap when an approval is decided, and an error
for a refused send or a failed approval or stop. Swipe an assistant row left to pin
or unpin it. With a hardware keyboard, Cmd+1 to 9 open pinned assistants in order,
Cmd+F finds in the open chat or opens Search, and Cmd+. asks before stopping active
work. Hold Command on an iPad to see them. Return still sends and Shift-Return
still adds a line.

The server must return `nativeAuthVersion: 1` from `/api/auth/config`. The
[native API contract](../docs/native-api.md) describes PKCE sign-in, bearer
sessions, revocation, and Apple push registration. Native tokens are stored in
Keychain and scoped to the normalized server origin. A sign-in lasts seven days; while
the app is in use with fewer than two left, it renews the same token, at most hourly,
up to 90 days after the Google sign-in. Sign-in keeps an ephemeral browser session on
purpose, so a shared iPad never hands one member's Google sign-in to the next. Drafts, pending admission
IDs, and read positions are scoped to the server and signed-in household member.

## Build and test

Run iOS builds on Nicolas's Mac mini as required by the machine-fleet skill.
List available simulators with `xcrun simctl list devices available`, then use
the repo's validation wrapper:

```sh
bash .agents/tools/validate-ios.sh SIMULATOR_UUID test
```

The wrapper holds the lock every checkout of this repository shares,
`.private/ios-validation.lock` in the main checkout, so two runs never drive
simulators at once; a second run exits at once instead of waiting. Do not wrap it
in `lockf` yourself. It refuses to boot a fourth simulator and shuts down the one
it booted. Tests run from a copy of the built `.xctestrun` that limits XCTest's
crash-report wait to 15 seconds, because the Mac mini otherwise waits about 300
seconds after every UI test. A failed test skips the `simctl diagnose` collector,
which stalls there for ten minutes; pass `-collect-test-diagnostics on-failure` to
keep it. Each run writes `.private/ios-<run>.txt` beside its result bundle with the
commit, the fingerprint of the iOS inputs, Xcode, the simulator and the test
summary. Another run with the same fingerprint, Xcode and runtime can reuse it.

The same wrapper accepts Xcode test filters. The parity suite exercises home,
pinning, Settings saves and recovery, the model catalog and inference controls,
conversation grouping, and Today. It uses synthetic transport fixtures.

```sh
bash .agents/tools/validate-ios.sh SIMULATOR_UUID test \
  -only-testing:AgentInterfaceUITests/ParityFlowTests
```

Or run directly from the repository root, without the shorter crash-report wait:

```sh
xcodebuild -project ios/AgentInterface.xcodeproj \
  -scheme AgentInterface -destination 'id=SIMULATOR_UUID' \
  -derivedDataPath .private/ios-build CODE_SIGNING_ALLOWED=NO test
```

Unsigned builds can run the fixture and transport tests. Real household sign-in
uses Keychain, which needs a signed simulator app. Local simulator signing can use
an ad hoc identity without an Apple account:

```sh
xcodebuild -project ios/AgentInterface.xcodeproj \
  -scheme AgentInterface -destination 'id=SIMULATOR_UUID' \
  -derivedDataPath .private/ios-build \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM= build
```

`AgentInterfaceTests` covers API contracts, draft/admission recovery, identity
changes, offline sign-out and change server, launch recovery, discarding unconfirmed sends, Markdown, avatar geometry and motion, notification routing, and the Siri, Spotlight and widget-selection surfaces.
`AgentInterfaceUITests` exercises native controls with an explicit Debug-only
transport fixture. These tests establish client behavior; they do not establish
Hermes execution or delivery from APNs. Release builds omit the fixture code.
`AutomationTests` holds transport responses until account/client changes, cancellation,
backgrounding or view dismissal occur. It checks that stale responses cannot publish
controls, notices, learning details or signing secrets, start follow-up reads, or replay
writes. Resume tests also check that unconfirmed request IDs survive reopening and that
confirmed receipts retire only their matching intent.

Server contract fixtures keep the app and server in step.
`tests/native-contract.test.ts` builds the real app server with a fully populated
Hermes test double, requests every endpoint the app decodes, and compares the
normalized responses with `ios/AgentInterfaceTests/Contract/*.json`.
`ContractFixtureTests` decodes each file into the app's own types and fails when a
fixture has no decoding check. After an intended API change, regenerate the files
with `UPDATE_CONTRACT=1 npx vitest run tests/native-contract.test.ts`, review the
diff, and update the Swift types and checks. GitHub CI runs `npm test` and the
Python checks. The native unit and UI tests run on the Mac mini that archives every
TestFlight build, with its own Xcode and iOS, through `.agents/tools/validate-ios.sh`;
an iOS change records those runs in its pull request. GitHub's macOS image runs an
older Xcode and iOS than the one we ship with, so `.github/workflows/ui-tests.yml` is
only a manual second opinion: `gh workflow run "iOS UI tests" --ref BRANCH -f
only=ClassName,ClassName/testMethod` runs just those tests. The UI tests skip
`LiveConnectionTests`, which compiles out without `LIVE_HERMES_UI_TESTS` and needs a
real local server, and `ScreenshotTourTests`, which only produces evidence. An activity state this app version does not
know decodes as "Status unknown" instead of failing the response.

Set `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `ios/tools/generate-project.py`;
the app and both extensions share them. `SystemSurfaceEvidenceTests` renders the widget,
Live Activity and update banner views to PNGs when run with
`TEST_RUNNER_AGENT_INTERFACE_EVIDENCE_DIR=/path/to/output`.

`AppStore` holds the app's state and uses Swift's Observation framework, so a view
renders again only when a property it read changes. Bookkeeping no view reads, such as
tasks, ETags and caches, is marked `@ObservationIgnored`. Transcript rows read the
connection and the assistant's name from the environment and use the store only in
their actions, so typing renders the composer, not the messages. Attachment uploads
(`AttachmentUploads`), the Hermes update panel (`HermesUpgrade`) and text waiting for a
draft (`DraftAdditions.swift`) live in their own files. `ObservedChanges.swift` in the
unit tests counts which store properties an action changed, and fails when a new
observed property is missing from its list.
Every target builds in the Swift 6 language mode with complete concurrency checking, so
a data race the compiler can see is a build error.

After adding Swift files, run `python3 ios/tools/generate-project.py` to regenerate
the checked-in Xcode project and shared scheme. The icon is original Core Graphics
artwork generated by `ios/tools/render-icon.swift`. Debug Settings includes an
avatar specimen for all nine activity states and all three avatar modes.

### Writing tests that do not race the app

A loaded Mac or a slower simulator exposes a test that races the app, so tests never assume timing.
Unit tests wait with `try await until { condition }` from `Waiting.swift`, which allows 10 seconds and
fails on timeout; never sleep a fixed time and then assert that something happened. A fixed sleep may only
prove that nothing happens, outlast a production timer or simulate latency. It must be clearly longer than
the interval it guards and carry an `Absence`, `Timer` or `Latency` comment on its line or the line before,
which `FixedWaitRuleTests` enforces. UI tests use `UITestSupport.swift`: `typeWhenFocused` to type, `tapWhenReady`
for menu items and anything that appears after an action, `wait(until:)` for a changed value, `shortcut(_:shows:)`
for key commands, `canTap` instead of `isHittable` (which fails outright while an element has no hit point,
also enforced by `FixedWaitRuleTests`), and `labeled` for system text written with typographic apostrophes.

## Install on a physical phone

Select your development team in Xcode, choose a bundle identifier registered to
that team, and enable the Push Notifications capability for that identifier.
After household sign-in, when the server supports Apple push, the app asks once in
its own card whether to enable notifications on this device, as the web does. iOS
shows its permission prompt only after Enable; "Not now" is remembered for the
account. Settings has a switch that registers or unregisters this device with the
server. The app reconciles registration on foreground and removes its server
registration if permission was denied. iOS Settings owns permission and Live
Activities, and Settings links there when iOS has denied it. Notifications group by
assistant. An approval request has Review, which opens the chat to see what it would
run, and Decline, which declines without opening the app. Both need the phone
unlocked. If a decline does not go through, a notification says so and opens
the chat. A finished reply has Reply, which adds
your text to that assistant's draft and opens the chat for you to review and send.
Batching, quiet hours,
and assistant following remain account preferences in WildBots. Devices that had
already allowed notifications stay enabled after updating. Debug signing uses the development APNs entitlement;
Release uses production. The server's configured APNs topic and environment must
match the signed app. Server setup is documented with the native API contract.
No team, signing credentials, or provisioning profiles are checked in.

## Publish to household TestFlight

Run `node .agents/tools/publish-ios.mjs` on the Mac mini. The command reads private
credentials from `~/.config/wildbots/apple/config.json`: `teamId`, `keyId`,
`issuerId`, `keyFile`, `signingP12`, `signingPassword`, and the two `testerEmails`. The existing team
distribution certificate can sign this app too. Keys and passwords stay outside Git.

One-time setup uses `setup` to register `dev.agentinterface.ios` and its share,
widget and notification service identifiers. In the Apple Developer website, register
`group.dev.agentinterface.shared` and assign it to all four identifiers. Also turn on
**Time Sensitive Notifications** and **Communication Notifications** for
`dev.agentinterface.ios`; the App Store Connect API cannot enable either. Apple then
invalidates the main app's old profile, and `prepare` creates a new one. Create
the app record in App Store Connect with the main bundle ID and SKU
`wildbots-ios`. This household uses **WildBots Household**, App Store Connect ID
`6823644380`. These website steps need an authenticated Apple session.
`prepare` creates or downloads the four App Store profiles and checks their group
membership, the main app's production APNs entitlement and its two notification
capabilities. It stops if the portal setup is incomplete.

After review and a clean commit, publish an explicit version and increasing build:

```sh
node .agents/tools/publish-ios.mjs archive 1.0 1
node .agents/tools/publish-ios.mjs upload 1.0 1
node .agents/tools/publish-ios.mjs distribute 1.0 1
```

The archive command uses the same version and build for all four bundles and
checks the exported IPA's signatures, profiles, App Group, push and notification entitlements.
Artifacts and private logs stay under `/Volumes/DevSSD/scratch/wildbots-testflight`.
An uncertain upload requires inspection, never an automatic second upload.
`distribute` may need to run later while Apple processes the build. It attaches
only the exact build to the internal **Household** group, then checks Apple's
installable state and reads back group membership. It writes `distributed.json`
only after those checks pass. Its update settings are a proposal for the next
guarded server deployment; it does not restart the live service.

Internal testers must accept an App Store Connect user invitation and a TestFlight
invitation. Give Kim the Marketing role with access to WildBots only. Enable
automatic updates in TestFlight on each phone. The Update button can open
`https://testflight.apple.com/v1/app/6823644380`. Apple's association file includes
`/v1/*` as TestFlight universal links, and this page offers the matching TestFlight
app link plus an App Store fallback. Verify the tap on an invited physical phone.
Internal groups have no public invitation link. Each build expires after 90 days;
the distribution receipt records its expiry. No scheduled renewal is installed.

Apple references checked October 16, 2026: [create an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/),
[App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups),
and [internal testers and build expiry](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).

The server owns execution and notification delivery while the app is closed.
The foreground client follows the event stream of the conversation on screen, including the iPad
detail pane, and reads it on each change notice, polling every 30 seconds while the stream is live and every
1.5 seconds without one, with backoff. Home, Today and Search leave the conversation alone; it is read
again as soon as it returns to the screen. Bootstrap refreshes every 45 seconds and on roster notices. Reads keep the last response and its ETag in memory, so an unchanged
response arrives as an empty 304 and is not decoded or applied again; sign-out and identity changes clear them. Today,
the group chat list and an open group poll only while the app is active, and refresh once on return. An
unconfirmed send is checked after 1.5, 5 and 15 seconds, then every minute, and at once after a change
notice from its conversation. The client preserves drafts and admission IDs; it never automatically resubmits a message.
Use authenticated Quick Look previews to share or save images, PDFs, and text files.

See [Parity.md](Parity.md) for implemented scope, observed validation, and
acceptance that requires a signed physical device or configured external service.

Recent messages can reopen without a network connection. The app keeps up to five chats, 100 visible messages per chat and 2 MB total, for at most seven days, in protected files excluded from backup. Copies are bound to the exact server and sign-in session; expired sessions do not restore them. Prompts for secure input, approvals, tool output, reasoning, streaming text, and credentials are excluded. Sending stays disabled until the selected chat has been revalidated. Signing out or losing assistant visibility clears the installation's old conversation copies.
