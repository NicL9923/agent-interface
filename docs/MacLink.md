# WildBots for Mac

WildBots for Mac is a menu bar app that lets your personal assistants work on your
Mac: run commands, read and write files in folders you choose, and take a
screenshot. It works while nobody is at the Mac, for scheduled routines, when you
allow that. The Mac connects out to the household app server, so it needs no open
port and works on any network.

Everything an assistant may do is decided on the Mac, in the app. The server can
refuse a request early, but it can never allow more than the Mac allows.

## Using it

1. Install the app, open it from the menu bar and enter the household address, for
   example `https://agentui.wildflowersranch.com`.
2. **Link this Mac** opens the system sign-in browser. Choose your household Google
   account. The app enrolls the Mac and keeps its own credential in the Keychain;
   your sign-in session is ended once the Mac is linked.
3. Add folders under **Folders**. Assistants can read and write only inside them.
   Your home folder itself, `~/Library`, `/Applications`, `/opt`, volume roots and
   the system folders cannot be added.
4. Under **Assistants**, allow each personal assistant what it may do:
   - **Files**: read and list files, and separately **Write files**.
   - **Run commands**: a shell confined to your folders.
   - **Screenshot**: an image of the main display, including every visible app.
   - **Also when unattended**: allow the above in scheduled and messaging runs, when
     nobody is in a WildBots chat with the assistant.
   Nothing is allowed until you allow it.
5. In WildBots, open the assistant's settings and turn on the **WildBots Mac** tools.

Only your own personal assistants can use your Mac. Shared assistants, other
members' assistants and personal assistants without a recorded owner are refused.

The menu bar icon fills in while an assistant is working. **Pause assistants**
stops every running action and refuses new ones until you resume. **Activity**
lists recent actions: which assistant, what it did, when, and the outcome.
**Notify me when an assistant acts unattended** is on by default.

**Keep this Mac awake while plugged in** stops idle sleep while the app is linked
and on power. It cannot stop sleep when you close the lid without an external
display, choose Sleep, or the battery runs low. A sleeping Mac is offline, and
assistants are told so. Commands and files work while the screen is locked;
screenshots do not. After a restart the app reconnects once you log in.

To unlink, choose **Unlink this Mac** in the app, or **Revoke** beside the Mac in
WildBots Settings > Macs on the web or iPhone. Either one revokes the Mac on the
server, stops its running actions and deletes its credential. If the app cannot
reach the server, it still forgets its credential and asks you to revoke it in
Settings.

## What confines an assistant

- **Folders.** File actions open each path component from the granted folder with
  `O_NOFOLLOW`, so a symbolic link or a renamed directory cannot lead outside it. A
  file with more than one hard link is refused, because another name for it may
  live outside your folders. Protected paths are refused even inside a granted
  folder: `.ssh`, `.gnupg`, `.aws`, `.gcloud`, `.azure`, `.kube`, `.docker`, `.netrc`,
  `.git-credentials`, `.config/gh`, Keychains, `~/Library/LaunchAgents`, browser
  profiles, Mail, Messages and this app's own settings.
- **Commands** run with `sandbox-exec` under a closed-by-default policy adapted from
  [Codex's macOS sandbox](https://github.com/openai/codex/tree/main/codex-rs/sandboxing/src)
  (Apache-2.0). They can read the system and developer tool folders, read and write
  your granted folders and a private temporary folder, which `TMPDIR` names, and
  open network connections. They cannot write `/tmp`, read the rest of your home
  folder, connect to local Unix sockets such as `ssh-agent` or Docker, send Apple
  Events to other apps, reach other services by Mach lookup, or change this app's
  settings. Each command runs `/bin/zsh -f` with a clean environment and no startup
  files; Git and Python come straight from the selected Xcode's tools, because the
  `xcrun` shims write a cache outside the sandbox. A timeout, or the command
  finishing, ends its whole process group. A command that cannot be sandboxed does
  not run.
- **Unattended** is a separate switch per assistant. Hermes marks scheduled runs,
  and the Mac refuses them unless that switch is on.

Limits worth knowing:

- Hermes runs every household profile as one Unix account on the server. A process
  there that reads the link key can claim to be any assistant. The Mac still only
  serves your personal assistants' grants, and its activity log and unattended
  notifications show every action, but the assistant name is not proof of which
  agent asked. See [Shared computer](SharedComputer.md) for the same boundary.
- Anything an assistant can read it can send elsewhere, through its own replies or
  the network. Grant narrow folders.
- A command can leave behind a script, Git hook or build step in your folder that
  you later run outside the sandbox. Review changes in granted folders as you would
  any contributor's.
- A process that starts its own session can outlive its command.

## Server setup

The app server and the Hermes add-on share a dedicated link key. It is different
from the Hermes service key and grants only Mac actions.

1. Generate 32 random bytes encoded as unpadded base64url (43 characters).
2. Add `MAC_LINK_KEY=<key>` to the app's private environment.
3. Add `HERMES_AGENT_INTERFACE_MAC_LINK_KEY=<key>` and
   `HERMES_AGENT_INTERFACE_APP_URL=http://127.0.0.1:<app port>` to the private
   environment that both the Hermes dashboard and gateway units load, such as
   `shared/computer.env`.
4. Restart both. Without the key the server reports Mac links as unavailable and
   the Hermes tools do not appear.

## Protocol, version 1

### Enrollment

`POST /api/mac/devices` with a native bearer session confirmed within the last 2
hours (signing in counts) and JSON `{ "name": "Nic's MacBook Pro", "model":
"Mac16,7", "osVersion": "27.0.1", "appVersion": "1.0" }`. `name` is 1 to 64
characters; the others are optional, up to 64 characters each. The response is
`201 { "deviceId": "mac_…", "credential": "…", "name": "…" }`. The credential is 32
random bytes in base64url and is shown only once; the server stores its SHA-256.
Each enrollment creates a new device. A revoked device stays revoked. A person may
have at most 5 linked Macs. The app then signs its native session out with
`POST /api/auth/logout`.

`GET /api/mac/devices` lists the signed-in person's Macs:
`{ "available": true, "devices": [{ "id", "name", "model", "osVersion",
"appVersion", "createdAt", "lastSeenAt", "online", "state" }] }`. `available` is
false with a `reason` when the server has no link key. `DELETE
/api/mac/devices/:id` revokes one of your own Macs; another person's Mac answers
404. Web requests use the usual CSRF checks.

### Link socket

`GET /api/mac/link` upgrades to a WebSocket with the header
`Authorization: Device <deviceId>.<credential>` and no `Origin` or `Cookie`. A
missing, malformed, unknown or revoked credential closes with 4401; a person no
longer in the household closes with 4403; link keys not configured closes with
4404. Frames are JSON text, at most 8 MiB.

A new socket for a device replaces the old one, which closes with 4409. Every
message the server handles belongs to its socket's generation, so a late close of
an old socket never marks the new one offline. The server pings every 20 seconds
and drops a socket silent for 60 seconds; the app reconnects with backoff from 1 to
60 seconds, at once after wake or a network change.

Mac to server:

- `{"type":"hello","protocol":1,"appVersion":"1.0","state":{…}}` first, then the
  results it has not had acknowledged.
- `{"type":"state","state":{…}}` whenever the state changes. State is
  `{"paused":false,"screenLocked":false,"screenPermission":"granted"|"denied"|"unknown",
  "folders":[{"name":"dev","path":"/Users/nic/dev"}],
  "grants":[{"assistantId":"patch","abilities":["files_read","files_write","run","screenshot"],"unattended":true}]}`.
- `{"type":"result","id":"…","ok":true,"value":{…}}` or
  `{"type":"result","id":"…","ok":false,"error":{"code":"…","message":"…"}}`.

Server to Mac:

- `{"type":"welcome","protocol":1}` after a valid hello.
- `{"type":"invoke","id":"…","assistantId":"patch","assistantName":"Patch","scheduled":false,"action":"run","args":{…},"timeoutMs":130000}`.
- `{"type":"ack","id":"…"}` once a result is recorded, including a result the server
  cannot read, which fails its call instead of dropping the link. Error messages are
  at most 2000 characters from the Mac; the server shortens anything over 4000. The Mac keeps a result until
  it is acknowledged and sends it again after reconnecting.
- `{"type":"revoked"}`, then close 4401. The Mac deletes its credential and stops
  running actions.

The Mac pings every 20 seconds as well and drops a link that has been silent for 60.
After 4403 or 4409 it waits for the person to reconnect; after 4404 it keeps trying.
`DELETE /api/mac/link` with the same `Authorization: Device …` header revokes the
Mac itself, for **Unlink this Mac**.

The Mac journals each invocation ID before it starts work. An ID it has already
accepted is never run again: it answers with the recorded result, or
`in_progress`. If the app quit during an action, that action's result is
`uncertain`. Unacknowledged results are kept for 7 days and accepted IDs for 30.
The Mac runs at most 4 actions at once and answers `busy` beyond that.
It starts or refuses an invocation as it arrives and never queues one. The server
sends invocations only over a live link and never holds one for a Mac that is
asleep or offline.

### Actions

| Action | Ability | Arguments | Result |
| --- | --- | --- | --- |
| `run` | `run` | `command` (1 to 16384 characters), `cwd` (absolute, or relative to the first folder; default the first folder), `timeoutSeconds` (1 to 600, default 120) | `exitCode`, `timedOut`, `stdout`, `stderr`, `stdoutTruncated`, `stderrTruncated`, `durationMs`, `cwd`. Each stream keeps its last 64 KiB. |
| `read_file` | `files_read` | `path`, `offset` (default 0), `length` (1 to 1048576, default 262144) | `path`, `size`, `sha256` of the whole file, `offset`, `encoding` (`utf8` or `base64`), `content`, `eof` |
| `write_file` | `files_write` | `path`, `content`, `encoding` (`utf8` default or `base64`), `expectedSha256` (replace only that version), `createOnly` (fail if it exists). Content up to 1 MiB decoded. Its folder must already exist. | `path`, `size`, `sha256`, `created` |
| `list_dir` | `files_read` | `path` (default the first folder), `offset` (default 0), `limit` (1 to 500, default 200) | `path`, `entries` of `name`, `type` (`file`, `dir`, `link`, `other`), `size`, `modified`; `total`; `nextOffset` when more remain |
| `screenshot` | `screenshot` | none | `pngBase64`, `width`, `height`, at most 1920 pixels wide |

Paths are absolute or start with `~/`; relative paths resolve against the first
folder. A file over 1 GiB is `too_large`, because its whole content is hashed. The
Mac refuses argument names an action does not take, and a result too large for an
8 MiB frame is `too_large`. Error codes from the Mac: `not_allowed`, `unattended_not_allowed`,
`paused`, `outside_folders`, `protected_path`, `not_found`, `not_a_file`,
`not_a_directory`, `too_large`, `conflict`, `exists`, `hard_link`, `busy`,
`in_progress`, `uncertain`, `permission_needed`, `screen_locked`,
`invalid_arguments`, `sandbox_unavailable`, `failed`.

### Hermes to the app server

The add-on calls `POST /api/agent-link/mac` on the app's loopback address with
`Authorization: Bearer <MAC_LINK_KEY>`. The server accepts only a loopback peer
with no `Origin`, `Cookie`, `Forwarded` or `X-Forwarded-*` header, and compares the
key in constant time. The body is
`{"invocationId":"…","assistantId":"patch","scheduled":false,"device":"…"?,"action":"…","args":{…}}`.
`assistantId` is the profile of the running Hermes session, never a model argument.
`action` is `list` or one of the actions above.

The response is `200 {"ok":true,"value":…}` or `200 {"ok":false,"error":{"code","message",…}}`.
Server error codes: `link_unavailable`, `assistant_not_personal`, `no_mac`,
`choose_mac` (with `macs`), `mac_offline` (with `lastSeenAt`), `not_allowed`,
`unattended_not_allowed`, `mac_busy`, and `uncertain` when the Mac disconnected or
timed out and did not report back before the deadline, so the action may have run.
A dropped connection keeps the call waiting for the Mac to reconnect and resend its
result until the deadline. The server never sends an invocation twice.

`list` returns the person's Macs with `name`, `online`, `lastSeenAt`, `paused`,
`screenLocked`, the folders, and what this assistant may do on each.
