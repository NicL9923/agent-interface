#!/usr/bin/env python3
"""Stage private shared-computer state and user units on the Hermes Linux host.

Does not restart Hermes or the app. Activate the qualified app release through
release-app.py first, then run this tool with --start to enable the computer.
Desktop packages and a sandboxed /usr/bin/google-chrome must already be installed.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-base", type=Path, default=Path.home() / ".local/share/agent-interface")
    parser.add_argument("--start", action="store_true")
    args = parser.parse_args()
    if os.getuid() == 0 or not args.app_base.is_absolute():
        parser.error("Run as the existing Hermes service account with an absolute app base")
    base = args.app_base.resolve()
    shared, source = base / "shared", Path.home() / ".hermes/hermes-agent"
    if not (shared / "app.env").is_file() or not (source / ".hermes/bin/hermes").is_file():
        parser.error("The existing managed Hermes and app installation are required")
    required = ("Xvnc", "xfwm4", "xfce4-panel", "xfdesktop", "xfsettingsd", "dbus-run-session", "xauth", "xdpyinfo", "setxkbmap", "xprop", "tmux", "google-chrome")
    missing = [name for name in required if not shutil.which(name)]
    if missing: parser.error("Install missing computer dependencies: " + ", ".join(missing))
    computer = shared / "computer"
    for path in (computer, computer / "terminal", computer / "workspace"):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = path.lstat()
        if path.is_symlink() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            parser.error("Computer state must be private and owned by the service account")
    units = Path.home() / ".config/systemd/user"
    backup = base / "operations" / ("computer-setup-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
    backup.mkdir(mode=0o700, parents=True)
    def write(path, contents):
        if path.exists(): shutil.copy2(path, backup / (path.parent.name + "-" + path.name))
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".computer-new")
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as handle: handle.write(contents)
        temporary.replace(path)
    env_file = shared / "computer.env"
    write(env_file, f"HERMES_AGENT_INTERFACE_COMPUTER_HOME={computer}\nHERMES_AGENT_INTERFACE_COMPUTER_CDP_URL=http://127.0.0.1:9223\nAGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome\n")
    for name in ("hermes-dashboard", "hermes-gateway"):
        write(units / (name + ".service.d") / "computer.conf", f"[Service]\nEnvironmentFile={env_file}\n")
    app_env = shared / "app.env"
    terminal_keys = {"COMPUTER_TERMINAL_ENABLED", "COMPUTER_STATE_DIR", "COMPUTER_TERMINAL_CWD", "COMPUTER_PYTHON"}
    lines = [line for line in app_env.read_text().splitlines() if line.split("=", 1)[0] not in terminal_keys]
    lines += ["COMPUTER_TERMINAL_ENABLED=true", f"COMPUTER_STATE_DIR={computer / 'terminal'}",
              f"COMPUTER_TERMINAL_CWD={computer / 'workspace'}", "COMPUTER_PYTHON=/usr/bin/python3"]
    write(app_env, "\n".join(lines) + "\n")
    target = base / "current/src/hermes/computer_host.py"
    link = source / "agent_interface_computer_host.py"
    if (link.exists() or link.is_symlink()) and (not link.is_symlink() or link.resolve() != target.resolve()):
        parser.error("The computer supervisor module path is already occupied")
    if not link.is_symlink(): link.symlink_to(target)
    write(units / "hermes-computer.service", f"""[Unit]
Description=Shared household Hermes computer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory={computer / 'workspace'}
Environment=HERMES_HOME={Path.home() / '.hermes'}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
EnvironmentFile={env_file}
ExecStart={source / '.hermes/bin/hermes'} --run-module agent_interface_computer_host
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
""")
    write(units / "agent-interface-terminal.service", f"""[Unit]
Description=Persistent household system terminals
After=network-online.target

[Service]
Type=simple
WorkingDirectory={computer / 'workspace'}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/python3 {base / 'current/src/server/terminal-host.py'} --serve --socket {computer / 'terminal/tmux.sock'} --cwd {computer / 'workspace'}
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=default.target
""")
    subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
    if args.start:
        if not target.is_file(): parser.error("Activate the qualified release before starting its computer supervisor")
        terminal_active = subprocess.run(["systemctl", "--user", "is-active", "--quiet", "agent-interface-terminal.service"]).returncode == 0
        server_exists = subprocess.run(["tmux", "-N", "-S", str(computer / "terminal/tmux.sock"), "show-options", "-s"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if server_exists and not terminal_active:
            parser.error("An existing terminal server needs an explicit handover before its supervisor can start; its human shells were preserved")
        subprocess.run(["systemctl", "--user", "enable", "--now", "hermes-computer.service", "agent-interface-terminal.service"], check=True)
    print(json.dumps({"staged": True, "started": args.start, "backup": str(backup), "desktop": "One shared household computer", "cdp": "Loopback only", "terminal": "One persistent tmux shell per member"}))


if __name__ == "__main__": main()
