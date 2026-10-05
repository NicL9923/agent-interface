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

Opening or reconnecting a shell needs a browser sign-in confirmed in the last
2 hours. Signing in counts. After that, the Terminal tab asks you to confirm it's
you with Google again. An open shell is not cut at the 2 hour mark; only a new
attachment asks again. Each attachment is logged with the person, address and
browser, never the ticket, and sends one "System terminal opened" alert to every
terminal administrator per confirmed sign-in, even during quiet hours. When the
app starts, it ends shells that belong to anyone who is no longer a terminal
administrator. It skips that cleanup until at least one administrator has signed
in, so a new database or a mistyped list cannot end the owner's shell.

The iOS app's Preferences offers **Open computer in browser**. It opens the same web
workspace in the system browser, which needs its own household Google sign-in.
The shell opens only there; the iOS app's own session cannot request one.

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
requests also require a terminal administrator's recent browser sign-in. Browser writes
use the app's existing Origin and CSRF checks. Streaming uses a session-bound,
single-use ticket expiring after 30 seconds and checks session revocation while
connected. The permanent Hermes service key remains on the server.

Full-call locking covers browser/desktop tools, including the default
`browser_exec` backend. Native task cleanup detaches from the supervisor's browser.
The qualification probe checks native tool routing and leases in a disposable
home; actual display hardware, browser readiness, and system shells require the
separate host acceptance checks.

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
