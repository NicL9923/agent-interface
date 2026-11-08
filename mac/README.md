# WildBots for Mac

A menu bar app that lets your personal assistants run commands, read and write files in folders
you choose, and take screenshots on this Mac. The product description and the link protocol are
in [docs/MacLink.md](../docs/MacLink.md). The command sandbox and its provenance are in
[Sandbox/README.md](Sandbox/README.md).

macOS 14 or later, Swift 6 toolchain (Xcode 16 or later). No third-party packages.

## Layout

| Path | What |
| --- | --- |
| `Sources/WildBotsMacCore` | Everything testable headlessly: protocol codec, argument validation, policy and folder rules, descriptor-based file actions, the Seatbelt policy builder, the command runner, the invocation journal, the activity log, the dispatcher and the link client. |
| `Sources/WildBotsMac` | The SwiftUI menu bar app: screens, Keychain, sign-in browser, ScreenCaptureKit, screen lock, sleep assertion, notifications, login item. |
| `Tests/WildBotsMacCoreTests` | XCTest suite, including `SandboxProbeTests`, the adversarial probes that run the real `sandbox-exec`. |
| `Sandbox/` | Codex's Seatbelt policies, vendored unchanged. |
| `tools/build-app.sh` | Builds and signs `build/WildBots.app`. |
| `tools/embed-policies.sh` | Regenerates the embedded policy constants from `Sandbox/*.sbpl`. |

## Test

```sh
cd mac
swift test
```

The sandbox probes need macOS with `/usr/bin/sandbox-exec`, network access (one probe fetches
`https://example.com`) and Xcode or the Command Line Tools for `git` and `python3`. They use a
fake home folder in a temporary directory and never read the real one. A change to
`SandboxPolicy.swift`, `ProtectedPaths` or the vendored policies is not done until they pass.

On the household Mac mini, wrap builds and tests in the shared lock:
`~/.agents/tools/mac-heavy-lock.sh swift test`.

## Build and run

```sh
cd mac
tools/build-app.sh            # ad hoc signature, for local testing
open build/WildBots.app
```

An ad-hoc build works, but macOS ties Screen Recording and Files and Folders permissions to the
signature, so they reset on every rebuild. For a build you keep, sign with a Developer ID
Application identity:

```sh
WILDBOTS_MAC_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
WILDBOTS_MAC_VERSION=1.0 WILDBOTS_MAC_BUILD=1 tools/build-app.sh
```

The app uses the hardened runtime and is not App Sandboxed: it needs to start `sandbox-exec` and
read the folders you grant, and it confines assistants' commands itself.

## Notarize

```sh
ditto -c -k --keepParent build/WildBots.app build/WildBots.zip
xcrun notarytool submit build/WildBots.zip --keychain-profile wildbots-notary --wait
xcrun stapler staple build/WildBots.app
spctl --assess --type execute --verbose build/WildBots.app
```

Create the `wildbots-notary` profile once with
`xcrun notarytool store-credentials wildbots-notary --apple-id … --team-id …`.

## Where it keeps things

- Device credential and the server it belongs to: login Keychain, service `dev.agentinterface.mac.link`.
- Policy (folders, grants, pause), invocation journal and activity log:
  `~/Library/Application Support/dev.agentinterface.mac/`, owner-only. Commands cannot read or
  write it.
- Command temporary folders: `$TMPDIR/dev.agentinterface.mac.commands/<uuid>`, one per command,
  deleted when it ends.

## Manual acceptance on the MacBook Pro

Use a Developer ID build so permissions stick, and a staging or local app server with
`MAC_LINK_KEY` set. Do not link against production while testing.

1. **Install and link.** Move `WildBots.app` to `/Applications`, open it, enter the server
   address and choose **Link this Mac**. The system browser asks for the household Google
   account. Confirm the Mac appears in WildBots Settings > Macs on the web and iPhone, online, and
   that the app's Link screen says Connected.
2. **Folders.** Try to add the home folder, `~/Library`, `/Applications` and `~/.ssh`: each is
   refused with a reason. Add a project folder such as `~/dev/scratch`.
3. **Grants.** Under Assistants, add a personal assistant (the ones you own are offered after
   linking; others can be typed by ID). Leave everything off and ask it in a WildBots chat to list
   the folder: the chat reports `not_allowed`, and Activity shows the request with an **Allow**
   button. Allow files and commands.
4. **Files and commands.** Ask it to list, read and write a file, and to run `git status` and
   `python3 --version` in the folder. Ask it to `cat ~/.zshrc` and to write outside the folder:
   both fail. Activity shows each action with its command or path and never file contents.
5. **TCC.** If the folder is in Desktop, Documents or Downloads, macOS asks once for Files and
   Folders access for WildBots; allow it. For screenshots, choose **Allow screen recording…** in
   Options, enable WildBots in System Settings > Privacy & Security > Screen Recording, and quit
   and reopen the app. Options then shows Screen Recording as Granted. Ask for a screenshot: it is
   at most 1920 pixels wide.
6. **Screen lock.** Lock the screen (Control-Command-Q) and ask for a screenshot from the phone:
   the answer is `screen_locked`. A command still runs while locked.
7. **Unattended routine.** Create a scheduled routine that lists the folder. With **Also when
   unattended** off it fails with `unattended_not_allowed`; turn it on and it runs, and a
   notification says the assistant acted unattended.
8. **Pause.** Start `sleep 120` from a chat, then choose **Pause assistants** in the menu: the
   command stops with `paused`, and new requests are refused until you resume.
9. **Sleep.** Turn on **Keep this Mac awake while plugged in**. On power, `pmset -g assertions`
   lists a PreventUserIdleSystemSleep assertion from WildBots; unplug and it goes away within
   15 seconds. Close the lid without an external display: the Mac sleeps and WildBots shows it
   offline. Open the lid: it reconnects within seconds.
10. **Restart.** Turn on **Open at login**, restart and log in: the app reconnects without
    signing in again.
11. **Revoke.** Revoke the Mac in WildBots Settings > Macs on the iPhone: the app shows that it
    was unlinked, any running command stops, and the Keychain item is gone
    (`security find-generic-password -s dev.agentinterface.mac.link` finds nothing).
