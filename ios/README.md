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

**Your preferences > Computer > Open computer in browser** opens the configured
app server's shared desktop and VPS terminal in the system browser. The browser
uses its own household sign-in; the native session token is never passed in the
URL. This keeps the native client free of embedded browser and terminal views.

The sidebar's **Today** screen shows recent canonical events, new replies, pending decisions,
and current work. **Mark caught up** saves the signed-in account's recap position
on the app server. When more results are waiting, mark the displayed page caught
up to load the next page. Late imported events stay visible until acknowledged.
Assistant settings include **Memory** for inspecting and
editing the actual Hermes profile documents, plus routine recipes, timezone and
next-run previews, and a confirmed **Try once** action.

The conversation microphone records up to two minutes, transcribes on the app
server, and opens an editable transcript before adding it to the draft. **Read
aloud** uses the device's iOS voice with an explicit Stop control. The composer's **+** menu attaches files and lists starter actions; starters also
appear as chips in an empty conversation. In Advanced presentation, the composer's
model menu switches the assistant's model, with Hermes confirmation when required. Interactive
reply instructions are opt-in in assistant settings. Checklists and itinerary
notes save to the signed-in app account; calendar proposals open Apple's event
editor for review and an explicit Save.

The **Assistants** widget (Home Screen and Lock Screen) shows who needs you, who is
working and recent conversations from a snapshot the app writes to the shared App
Group; it never holds a sign-in token and asks you to open the app once the
snapshot is 30 minutes old. One aggregate Live Activity shows working and waiting
assistants on the Lock Screen and in the Dynamic Island. It starts in the foreground
after you send, follows server pushes, and can be turned off in **Preferences >
Lock Screen**. When the server publishes a newer build, a banner and **Preferences >
About** offer an Update button. Widget and Live Activity taps open
`agentinterface://open?bot=ID`, handled like a notification link.

The server must return `nativeAuthVersion: 1` from `/api/auth/config`. The
[native API contract](../docs/native-api.md) describes PKCE sign-in, bearer
sessions, revocation, and Apple push registration. Native tokens are stored in
Keychain and scoped to the normalized server origin. Drafts, pending admission
IDs, and read positions are scoped to the server and signed-in household member.

## Build and test

Run iOS builds on Nicolas's Mac mini as required by the machine-fleet skill.
List available simulators with `xcrun simctl list devices available`, then use
the repo's validation wrapper:

```sh
bash .agents/tools/validate-ios.sh SIMULATOR_UUID test
```

Or run directly from the repository root:

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
changes, offline sign-out and change server, launch recovery, discarding unconfirmed sends, Markdown, avatar geometry and motion, and notification routing.
`AgentInterfaceUITests` exercises native controls with an explicit Debug-only
transport fixture. These tests establish client behavior; they do not establish
Hermes execution or delivery from APNs. Release builds omit the fixture code.

Server contract fixtures keep the app and server in step.
`tests/native-contract.test.ts` builds the real app server with a fully populated
Hermes test double, requests every endpoint the app decodes, and compares the
normalized responses with `ios/AgentInterfaceTests/Contract/*.json`.
`ContractFixtureTests` decodes each file into the app's own types and fails when a
fixture has no decoding check. After an intended API change, regenerate the files
with `UPDATE_CONTRACT=1 npx vitest run tests/native-contract.test.ts`, review the
diff, and update the Swift types and checks. CI runs `npm test` and the native unit
tests on GitHub's `macos-26` image. An activity state this app version does not
know decodes as "Status unknown" instead of failing the response.

Set `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in `ios/tools/generate-project.py`;
the app and both extensions share them. `SystemSurfaceEvidenceTests` renders the widget,
Live Activity and update banner views to PNGs when run with
`TEST_RUNNER_AGENT_INTERFACE_EVIDENCE_DIR=/path/to/output`.

After adding Swift files, run `python3 ios/tools/generate-project.py` to regenerate
the checked-in Xcode project and shared scheme. The icon is original Core Graphics
artwork generated by `ios/tools/render-icon.swift`. Debug preferences include an
avatar specimen for all nine activity states and all three avatar modes.

## Install on a physical phone

Select your development team in Xcode, choose a bundle identifier registered to
that team, and enable the Push Notifications capability for that identifier.
The app requests notification permission only after the person chooses to enable
device notifications. Debug signing uses the development APNs entitlement;
Release uses production. The server's configured APNs topic and environment must
match the signed app. Server setup is documented with the native API contract.
No team, signing credentials, or provisioning profiles are checked in.

## Publish to household TestFlight

Run `node .agents/tools/publish-ios.mjs` on the Mac mini. The command reads private
credentials from `~/.config/wildbots/apple/config.json`: `teamId`, `keyId`,
`issuerId`, `keyFile`, `signingP12`, `signingPassword`, and the two `testerEmails`. The existing team
distribution certificate can sign this app too. Keys and passwords stay outside Git.

One-time setup uses `setup` to register `dev.agentinterface.ios` and its share and
widget identifiers. In the Apple Developer website, register
`group.dev.agentinterface.shared` and assign it to all three identifiers. Create
the app record in App Store Connect with the main bundle ID and SKU
`wildbots-ios`. This household uses **WildBots Household**, App Store Connect ID
`6823644380`. These website steps need an authenticated Apple session.
`prepare` creates or downloads the three App Store profiles and checks their group
membership and production APNs entitlement. It stops if the portal setup is incomplete.

After review and a clean commit, publish an explicit version and increasing build:

```sh
node .agents/tools/publish-ios.mjs archive 1.0 1
node .agents/tools/publish-ios.mjs upload 1.0 1
node .agents/tools/publish-ios.mjs distribute 1.0 1
```

The archive command uses the same version and build for all three bundles and
checks the exported IPA's signatures, profiles, App Group and push entitlements.
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
The foreground client polls canonical conversation state with bounded requests
and backoff. Reads keep the last response and its ETag in memory, so an unchanged
response arrives as an empty 304; sign-out and identity changes clear them. It
preserves drafts and admission IDs; it never automatically resubmits a message.
Use authenticated Quick Look previews to share or save images, PDFs, and text files.

See [Parity.md](Parity.md) for implemented scope, observed validation, and
acceptance that requires a signed physical device or configured external service.
