# Shared household computer

Open **Computer** in the web app to watch the household's persistent desktop and
browser. Every assistant uses this computer while keeping its own Hermes profile,
model, memory, and tool settings. Tabs and website sign-ins survive app reconnects.
Browser work uses one control lock across the dashboard, Discord, scheduled work,
and subagents.

Choose **Take over** before clicking or typing on the desktop. Assistants pause
their computer actions while a person controls it. Choose **Hand back** when done.
A second household member can watch, but cannot steal another person's control.
After a lost connection, the desktop reconnects in watch mode; take over explicitly
to resume input. Closing the last desktop attachment normally hands control back.

On a phone or tablet, in the web app and the iOS app, touch works like this:

- Tap clicks where you tapped, and one finger drags. A quick second tap on the same
  spot double-clicks.
- Two-finger tap, or press and hold, right-clicks. Two fingers scroll.
- Pinch zooms the view, not the desktop. Zoomed in, two fingers pan instead of
  scrolling. **Reset zoom** zooms back out.
- **Trackpad mode** turns a finger into a trackpad: it moves a pointer, a tap
  clicks there, and double-tap and hold drags. **Recenter pointer** brings the
  pointer back on screen.
- **Copy to** this device copies what was last copied on the desktop. **Paste
  from** this device puts the device's clipboard on the desktop's clipboard and
  types it into the selected field, up to 8192 characters.

The **?** button explains these. On the web, the touch buttons sit below the
desktop; in the iOS app, the bottom bar holds the keyboard and clipboard, and its
**⋯** menu holds trackpad mode and zoom. Mouse and keyboard input are unchanged.

An assistant can ask for a person from the conversation with its
`computer_request_handoff` tool, for a CAPTCHA, a sign-in that needs a phone, a
purchase confirmation or a choice only a person should make. The tool exists only
when the household computer is configured. Its card shows the assistant's reason
and what it wants done. **Take over** opens the computer and takes control in one
step, on the web and in the iOS app. Handing the computer back answers the
request, whichever screen hands it back, including closing the last desktop view.
**Not now** declines it, and sending a message instead closes it. If someone else
has control, the card says who; if the computer is not running, it says why. A
request nobody takes over closes after 10 minutes. Each result tells the
assistant what happened; after a hand back it is told to look at the screen again
before acting, because the person may have changed it. Any takeover answers every
open handoff, since each asked a person to use the same computer.

While an assistant's running tool uses the browser or desktop, its live row in
the conversation offers **Watch**, which opens the computer without taking control.

An assistant can also ask for a person at the system terminal with its
`computer_request_terminal` tool, for a step that needs a real shell on the Hermes
host, such as a command that needs `sudo` or an interactive sign-in like
`gh auth login`. The tool exists only when the household computer is configured. It
takes a reason, what to do and an optional one-line command of up to 500 visible
characters. Its card shows all three, with a **Copy** button for the command, and
warns that the assistant cannot see the terminal. **Open terminal** opens the
Terminal tab with the command offered beside the shell. **Paste at prompt** pastes it
without running it, and the person reads it and presses Enter. Nothing is pasted on
its own, because the persistent shell may still be running a program that waits for
a single key, which pasted text could answer. A command with a line break or a
hidden character is refused by both the add-on and the app, because a pasted newline
would run it. **Done** tells the assistant the person finished; its result says the
assistant cannot see the terminal or its output and must check the outcome itself.
Every other result tells the assistant that whether anything ran is unknown.
**Not now** declines, and sending a message instead closes the card. A request
nobody answers closes after 30 minutes. Only terminal administrators can open the
terminal or press Done, so everyone else sees why the buttons are off and can still
choose Not now. Opening the terminal from the card follows the usual rules,
including the sign-in confirmed in the last 2 hours. The ask never pauses the
assistant's desktop and browser actions, because the terminal is a separate shell.

The **Terminal** tab opens a real shell on the Hermes VPS. Its host and starting
folder appear above it. Each terminal administrator gets a separate persistent tmux
session. Closing the panel or reconnecting preserves the shell and running commands;
its separate terminal supervisor also preserves them during app restarts and deployments.
**End shell** explicitly ends that session. This shell has the existing VPS service
account's access. The app's service/provider environment is removed before launch.

Only the shell is restricted. The shared desktop, including **Take over**, stays
available to every household member. `COMPUTER_TERMINAL_ADMINS` lists who may open
the shell. It defaults to the integration administrators, must be part of
`HOUSEHOLD_EMAILS` in production, and an empty value turns the shell off for
everyone. Other members see why the Terminal tab is unavailable.

Opening or reconnecting a shell needs a sign-in confirmed in the last 2 hours, in
the browser or app that opens it. Signing in counts. After that, the Terminal tab
asks you to confirm it's you with Google again. An open shell is not cut at the 2 hour mark; only a new
attachment asks again. Each attachment is logged with the person, address and
browser or app, never the ticket, and sends one "System terminal opened" alert to every
terminal administrator per confirmed sign-in, even during quiet hours. When the
app starts, it ends shells that belong to anyone who is no longer a terminal
administrator. It skips that cleanup until at least one administrator has signed
in, so a new database or a mistyped list cannot end the owner's shell.

The iOS app's **Settings > Computer** shows the desktop through `/native/computer`
and types with the system keyboard while the person has control. The page's
`desktopInput` sends nothing unless that viewer is connected with control. The
terminal opens in the app too, through `/native/terminal`, for terminal
administrators. The app first asks you to confirm it's you with Google in its own
sign-in sheet, which follows the same 2 hour rule. The page never shows the web
keyboard; the app's keyboard types, with Escape, Tab, Control, the arrows and Paste
above it. See [the native API](native-api.md#system-terminal).

## Host setup

The existing Hermes installation must use the qualified dashboard and gateway
wrappers. Install TigerVNC/Xfce using the native `tools.bot_desktop.runtime` distro
package list, `tmux`, and a sandboxed distro Chrome browser. Ubuntu's setup uses
Google's official stable Debian package. The supervisor preserves Chromium's
sandbox rather than adding `--no-sandbox`.

Run `.agents/tools/setup-shared-computer.py` on the Linux host as the existing
Hermes account. It backs up changed settings privately and stages:

- `shared/computer.env`, loaded by dashboard and gateway user-unit drop-ins.
- `HERMES_AGENT_INTERFACE_COMPUTER_HOME`, an owner-only resource home separate
  from conversational profiles, and a fixed loopback-only CDP origin.
- The `hermes-computer.service` user unit and native supervisor module symlink.
- An independent `agent-interface-terminal.service` unit owning the tmux server.
- The app's terminal environment settings in its private `shared/app.env`.
- Private browser, terminal, and workspace directories under `shared/computer`.

No live service is restarted by staging. Prepare and qualify the new app release,
then activate it through `release-app.py`. Run the setup tool with `--start` to
enable its computer supervisor. Verify that desktop availability and browser
readiness are true in `/api/computer`, and exercise both desktop streaming and a
terminal detach/reconnect. VNC uses a private Unix socket; CDP listens only on
loopback. Neither needs a public firewall or Caddy port.

Control and attachment requests require household authentication. Terminal
requests also require a terminal administrator's recent sign-in, confirmed in the
browser or iOS app that asks. Browser writes
use the app's existing Origin and CSRF checks. Streaming uses a session-bound,
single-use ticket expiring after 30 seconds and checks session revocation while
connected. The permanent Hermes service key remains on the server.

Full-call locking covers browser/desktop tools, including the default
`browser_exec` backend. Native task cleanup detaches from the supervisor's browser.
The qualification probe checks native tool routing and leases in a disposable
home; actual display hardware, browser readiness, and system shells require the
separate host acceptance checks.

## Profile authorization for local networks

The shared browser uses a CDP attachment. Native Hermes normally treats CDP
attachments as external and blocks private addresses even when a profile selects
`browser.cloud_provider: local`. A profile can explicitly authorize the
supervisor-owned browser's native local-network behavior in its own `config.yaml`:

```yaml
browser:
  agent_interface:
    allow_local_network: true
```

Merge this into the existing `browser` mapping. The setting defaults off and
requires the YAML boolean `true`. It is read from the active profile on every
decision, including multiplexed gateway turns. There is no global profile list.
For Patch, the operator adds this mapping only to
`/home/nicolas/.hermes/profiles/patch/config.yaml`. Keep the existing
`cloud_provider: local`, `engine: chrome`, and both private-URL permission flags
unchanged at false. This branch does not change that live file.

Authorization takes effect only when the effective native terminal backend is
`local` and the browser has verifiable supervisor provenance. Routed profiles
must carry their own native terminal policy; missing or refused policy never
falls back to the launch profile's local environment. Remote and container
terminals remain restricted.

Use a literal loopback CDP origin such as `http://127.0.0.1:9222` for this
authorization. A hostname cannot prove which listening address discovery used.
The supervisor publishes an owner-only `bot-desktop/computer-browser.json` in
the shared computer home after launching Chrome. The adapter verifies the
supervisor and browser's live PIDs, birth times, Unix ownership, parent-child
relationship, ownership of the actual loopback listening socket, debugging port,
and Chrome's unpredictable browser websocket ID
from fixed-origin discovery. Discovery accepts no proxies, redirects or external
websocket origin. Missing, stale, malformed or mismatched registration refuses
the extra local classification. An arbitrary loopback CDP listener has no trust.
The supervisor removes registration on shutdown and replaces it on startup.
The record shares the existing service-account trust boundary. Processes with
that Unix account's full authority are not isolated from one another.

This is native local-network behavior for the authorized profile, including
private/LAN/Headnet addresses. It is not a KVM hostname allowlist.

The control that keeps agents away from the cloud metadata service is the host's
metadata egress floor, an nftables table that rejects every connection the
service account's processes open to `169.254.169.254` or `fe80::a9fe:a9fe`.
That account runs Hermes, the app, this browser and agent terminal tools, so the
floor also covers runtime-built URLs, `curl` and Python tools. The app's
readiness check fails unless its metadata attempts are explicitly refused.
Release preparation and verification refuse a host whose live floor does not
match. A relay running as root or another account, such as an open proxy on
loopback, is outside this boundary. See
[Hosting](Hosting.md#metadata-egress-floor) for installation and limits.

The literal checks below are defense in depth. Hermes keeps the metadata floor in
navigation, redirect checks and `browser_exec`. The add-on dispatch wrapper also
blocks metadata URL literals in `browser_cdp` before the household browser
operation starts.

The wrapper applies native Hermes's own CDP metadata floor.
`browser_cdp_tool._fetched_param_urls` names every URL a fetching method's
parameters carry, including scheme-relative `//host` and `\\host` forms and
hosts after userinfo. `browser_url_policy.literal_targets_metadata` judges each
one, including IPv6 and decimal, hex and octal IPv4 spellings, without DNS.

The wrapper also finds special-scheme forms that native's scan misses but
WHATWG URL parsing still reads as an authority. For `http`, `https`, `ws` and
`wss`, these are zero or one slash (`http:/169.254.169.254/`,
`HTTP:169.254.169.254/`), backslashes (`http:\\169.254.169.254`), and the
JavaScript spellings `\/`, `\t`, `\n` and `\r`. It reads each authority as
WHATWG does:

- The userinfo ends at the last `@` before the first `/`, `\`, `?` or `#`.
- A bracketed IPv6 host stays whole.
- When an `@` follows a quote or space, the wrapper judges both readings. It
  never judges a host cut short.
- CSS `url()` and `@import`, unquoted HTML attributes and `srcset` end a URL
  at `)`, `;`, a quote, `,`, `>`, `}` or whitespace. The authority is also
  read cut at the first of those, before the userinfo split, so an `@media`
  rule after the URL is not taken for userinfo. Each host is also judged
  cut at the same characters.
- Every scheme occurrence is read on its own, including one inside another
  URL's query, so an earlier URL in the same text never hides a later one.
- Delimiter positions are found once per text, so the scan stays near
  linear: a 1 MiB script holding 58,252 schemes takes about 0.1 s. A host
  over 1,024 characters is blocked unless it holds a character no IPv4 or
  metadata-name spelling has, so leading zeros, percent-encoding or long
  userinfo can't hide an address.

A host WHATWG rejects can't fetch anything and passes. So `{https:[]}` and
`JSON.stringify({http:[]})` still run. Rejected hosts include an unclosed,
empty or invalid bracketed host, an empty host, a non-numeric port and a
forbidden code point.

An accepted host is judged by native in its plain form, after
percent-decoding. A non-ASCII host first goes through the `idna` package's
UTS 46 mapping, the mapping WHATWG domain-to-ASCII uses. So `%E1%B4%B9` and
mathematical or fullwidth digits read as WHATWG reads them. If `idna` is
missing or can't map the host, the call is blocked. An IPv6 host is also
judged by any IPv4 address it embeds: mapped, translated, IPv4-compatible,
NAT64 `64:ff9b::/96` and 6to4.

Hostnames are judged literally, as native judges `//host`, so a name that
only resolves to a metadata address is not caught here. JavaScript `\u` and
`\x` escapes, and URLs built at run time, are not decoded.
Text input, block lists and cookie scopes stay unscanned, as in native.
Native `browser_cdp` repeats its own floor, which lacks the extra forms. A
`tools.browser_session` revision without these helpers fails the seam check,
so the shared computer stays off until it is qualified. The
older `browser_tool_*` revisions keep the earlier check of
`browser_console(expression=...)`, CDP `Page.navigate` and CDP
`Runtime.evaluate` with the http(s) literal scanner. These are literal
checks, not an egress firewall. Native local classification skips the
current-page metadata check before content tools, and computed or obfuscated
JavaScript URLs can escape the literal scan. The nftables floor is what stops
those. Native website-policy checks and their caching are unchanged. Human
takeover, operation locks, recovery fences,
and TLS validation also remain in force. The wrapper uses the revision-qualified
`browser_tool_cloud._is_local_backend` seam because this native revision has no
owned-browser provenance hook. Qualification must cover changes to this seam.

A device certificate the browser does not trust yields a certificate error.
Fix the certificate on the device before trusted access or credential entry.
Certificate administration remains separate from this integration change.

### Qualification, activation and rollback

Run `python3 scripts/run-python-tests.py` and `ruff check .`. The existing
`scripts/spike/computer_probe.py` exercises real native dispatch and leases.
`scripts/spike/computer_local_network_probe.py` additionally launches disposable
Chrome and exercises real native preflight, profile consent, provenance,
terminal policy, metadata/website checks, human control, and invalid TLS.
The qualification runner always runs the coordination probe. When Chrome is
available through `HERMES_COMPUTER_PROBE_BROWSER`,
`AGENT_BROWSER_EXECUTABLE_PATH` or PATH discovery, it also runs the local-network
probe in its own marked home and collects
`hermes-computer-local-network-probe.json` in the evidence directory. Otherwise
that receipt records `status: "skipped"` and the missing executable reason.
A skipped browser probe does not establish browser policy or TLS acceptance.
Use an isolated Python environment with the exact native revision and approved
repair. Set `HOME` and `HERMES_HOME` to the same disposable directory containing
`.agent-interface-isolated` with `agent-interface-disposable-spike`, point
`PYTHONPATH` at that native checkout, set `PYTHONDONTWRITEBYTECODE=1` and
`HERMES_DISABLE_LAZY_INSTALLS=1`, and set `HERMES_COMPUTER_PROBE_BROWSER` to a
sandboxed Chrome executable. On the Mac, keep the home, TMPDIR and browser
profile under `/Volumes/DevSSD/scratch/patch-local-browser/`. The existing short
Unix-socket namespace remains under `/tmp/agentui-computer-*`; browser data and
downloads stay in the disposable home. The probe writes a JSON receipt there.

The October 18 Mac rehearsal used this existing constrained interpreter and
read-only native checkout. Its disposable homes were created with mode 0700
and the marker above. Run from the implementation worktree:

```sh
TMPDIR=/Volumes/DevSSD/scratch/patch-local-browser/tmp python3 scripts/run-python-tests.py
/Volumes/DevSSD/caches/wildbots-ci-venv/bin/ruff check .

env -i \
  PATH=/Volumes/DevSSD/scratch/credential-input/venv/bin:/opt/homebrew/bin:/usr/bin:/bin \
  HOME=/Volumes/DevSSD/scratch/patch-local-browser/home \
  HERMES_HOME=/Volumes/DevSSD/scratch/patch-local-browser/home \
  TMPDIR=/Volumes/DevSSD/scratch/patch-local-browser/tmp \
  PYTHONPATH=/Volumes/DevSSD/scratch/credential-input/hermes \
  PYTHONDONTWRITEBYTECODE=1 HERMES_DISABLE_LAZY_INSTALLS=1 \
  HERMES_COMPUTER_PROBE_BROWSER=/Volumes/DevSSD/caches/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-mac-arm64/chrome-headless-shell \
  python3 scripts/spike/computer_local_network_probe.py

env -i \
  PATH=/Volumes/DevSSD/scratch/credential-input/venv/bin:/opt/homebrew/bin:/usr/bin:/bin \
  HOME=/Volumes/DevSSD/scratch/patch-local-browser/coordination \
  HERMES_HOME=/Volumes/DevSSD/scratch/patch-local-browser/coordination \
  TMPDIR=/Volumes/DevSSD/scratch/patch-local-browser/tmp \
  PYTHONPATH=/Volumes/DevSSD/scratch/credential-input/hermes \
  PYTHONDONTWRITEBYTECODE=1 HERMES_DISABLE_LAZY_INSTALLS=1 \
  python3 scripts/spike/computer_probe.py
```

The full Chrome for Testing builds timed out on `Page.navigate` in this Mac
rehearsal. The headless shell completed native `browser_exec` navigation and
returned `net::ERR_CERT_AUTHORITY_INVALID` for the self-signed TLS fixture, with
zero HTTP requests reaching it. This checks real browser TLS enforcement, but
does not qualify a headed production display or prove access to the actual KVM.

The release owner must obtain fresh full native qualification for the final
merged integration inputs. Prepare with
`.agents/tools/release-app.py prepare MERGED_COMMIT --host home-hermes-vps --app-base APP_BASE --qualification RECEIPT`,
then activate the prepared name through `release-app.py activate NAME`. Use its
controlled, idle-gated drain and activation. Stage Patch's config change before
the final prepare so its profile hash matches. Do not manually restart dashboard
or gateway. The computer supervisor adopts the new release at its next idle
check while holding the operation lock. Until it restarts and publishes the new
registration, local-network admission stays blocked.

After activation, run `release-app.py verify NAME`; verify sign-in, original
Google/Discord connections, clear maintenance, computer readiness, and the new
supervisor registration. Check Patch's admission and an unauthorized profile's
denial in fresh turns, metadata/website refusals, and human takeover/handback.

On the Linux host, as the service account, verify cross-process provenance using
the live gateway's executable and environment. This read-only checker must print
`verified_local_browser=True` while the supervisor and gateway user units are
running separately. It checks the existing registration and browser, without
launching a browser, changing configuration or restarting a service:

```sh
python3 - <<'PY_GATEWAY_CHECK'
import os
from pathlib import Path
import subprocess

pid = int(subprocess.check_output([
    "systemctl", "--user", "show", "hermes-gateway.service", "--property=MainPID", "--value"
], text=True).strip())
assert pid > 0, "Gateway is not running"
proc = Path(f"/proc/{pid}")
assert proc.stat().st_uid == os.getuid(), "Run as the gateway service account"
env = dict(item.split("=", 1) for item in (proc / "environ").read_text().split("\0") if "=" in item)
env["PYTHONDONTWRITEBYTECODE"] = "1"
source = Path.home() / ".hermes/hermes-agent"
code = """
import importlib.util, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import hermes_bootstrap
path = (Path(sys.argv[1]) / 'agent_interface_gateway.py').resolve().with_name('computer.py')
spec = importlib.util.spec_from_file_location('gateway_computer_check', path)
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
setting = addon.configured()
assert setting is not None, 'Gateway has no configured shared computer'
computer = addon.Computer(*setting, None, None)
assert computer.state.is_dir(), 'Supervisor state is missing'
verified = computer.verified_local_browser()
print(f'verified_local_browser={verified}')
assert verified, 'Gateway-side provenance check failed'
"""
python = str((proc / "exe").resolve())
subprocess.run([python, "-I", "-c", code, str(source)], env=env, cwd=source, check=True)
PY_GATEWAY_CHECK
```

This runs an independent checker in the gateway's runtime context. Confirm
Patch's admission in a fresh gateway turn as well; the command does not execute
inside the already-running gateway. Expect a certificate error for a device
until its untrusted certificate is repaired.

To revoke access, set only Patch's `browser.agent_interface.allow_local_network`
to false or remove it. New decisions refuse without a restart; an already
admitted operation must finish under its existing lease. For a code rollback,
prepare the previous known-good source with its matching qualification through
the same `release-app.py` flow and activate only after fresh idle admission.
Let the supervisor adopt that release at idle. Do not switch release symlinks,
delete registration/recovery records, or restart services around the guards.
An uncertain activation stays under maintenance for the release owner's review.

If a browser action times out, the coordinator blocks new bot and human input
until it verifies native daemon shutdown and closes the interrupted action's
recorded tabs. Other bot tabs and the supervised browser remain open. Watching
still works. **Take over** retries recovery safely; ordinary Python errors do not
trigger this fence. If recovery keeps failing, inspect
`journalctl --user -u hermes-computer.service` on the host, restart that service,
wait for browser readiness, then choose **Take over** again. Restarting the shared
computer closes its desktop applications and open tabs; its browser sign-ins
remain on disk. Keep the private `bot-desktop/computer-recovery.json` record until
the coordinator proves recovery. Deleting it bypasses the input safeguard.

Hermes updates, recoveries and app releases restart the gateway, not the shared
computer. The computer supervisor checks once a minute. Once the running gateway
uses a Hermes revision that differs from the supervisor's but matches the
installed source, or the app release changes, the supervisor exits with status 75
at the next idle moment. It waits while a member has control, a bot action is
running or a browser recovery is pending. It also holds the action lock while
shutting down, and systemd starts it again on matching code. Desktop applications
close; the browser reopens its last session with sign-ins intact.
