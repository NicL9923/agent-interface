#!/usr/bin/env python3
"""Run release-app.py prepare until the household's assistants are idle.

The guarded preflight refuses while Hermes is busy. This retries only that
refusal, discarding each refused stage, and stops on any other failure.

The messaging gateway can keep counting an agent after its turn has ended (Oct 22 and
Nov 2, 2026). A real turn usually writes to its session after each tool batch, but a long
model call or a script-only routine can stay silent, so silence alone never proves a leak.
This reports a count that persists through QUIET_MINUTES with no message written and no
live routine run. Only with --household-idle, which the operator passes after the household
confirms nobody is mid-conversation, does it restart the gateway, once per run, after the
host re-checks those conditions in the same command that restarts it.
"""
import argparse
import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

import host_access

TOOL = Path(__file__).with_name("release-app.py")
# Either native admission owner can report work. Retry only their no-change preflight refusals.
# Only the fence's own refusal counts. A traceback that merely quotes the fence's source line,
# as when the gate's status call itself failed on Nov 2, 2026, is a real failure.
BUSY = re.compile(r'Fence: (?:maintenance gate inactive with no busy work|gateway reports no active agents or work)')
DISCARD = re.compile(r"Discard with: release-app\.py discard (release-[\w-]+)")
# How long a counted agent must persist with no message written and no live routine run
# before it is reported as leaked, and restarted with --household-idle.
QUIET_MINUTES = 5


HOST_CHECK = r"""
import glob, json, os, sqlite3, subprocess, sys, time
home, restart_after = os.path.expanduser(sys.argv[1]), float(sys.argv[2])

def read():
    state = json.load(open(os.path.join(home, "gateway_state.json")))
    newest, unreadable, routines = None, False, 0
    profiles = [home] + sorted(glob.glob(os.path.join(home, "profiles", "*")))
    for root in profiles:
        sessions = os.path.join(root, "state.db")
        if os.path.exists(sessions):
            try:
                with sqlite3.connect("file:" + sessions + "?mode=ro", uri=True, timeout=2) as c:
                    t = c.execute("select max(timestamp) from messages").fetchone()[0]
                if t is not None and (newest is None or t > newest):
                    newest = t
            except Exception:
                unreadable = True
        ledger = os.path.join(root, "cron", "executions.db")
        if os.path.exists(ledger):
            try:
                with sqlite3.connect("file:" + ledger + "?mode=ro", uri=True, timeout=2) as c:
                    rows = c.execute("select pid from executions where status in ('claimed','running')").fetchall()
            except Exception:
                unreadable = True
                continue
            for (pid,) in rows:
                try:
                    os.kill(int(pid), 0)
                    routines += 1
                except (OSError, TypeError, ValueError):
                    pass
    quiet = None if unreadable or newest is None else max(0.0, time.time() - newest)
    return {"agents": state.get("active_agents"), "work": state.get("active_work") or [], "quiet": quiet, "routines": routines}

report = read()
# Re-checked here, immediately before restarting, so work that arrived since the last attempt is seen.
if restart_after and report["agents"] and report["routines"] == 0 and report["quiet"] is not None and report["quiet"] >= restart_after:
    report["restarted"] = subprocess.run(["systemctl", "--user", "restart", "hermes-gateway.service"], timeout=120).returncode == 0
print(json.dumps(report))
"""


def gateway_report(host, hermes_home, restart_after=0):
    """What the gateway counts, when any profile last wrote a message and how many routine runs are live.

    ``work`` is filled by Hermes only while it drains, so an empty list is normal for a real turn.
    ``quiet`` is seconds since the newest message in any profile's session store, or None if any
    store is unreadable. With ``restart_after`` seconds, the host restarts the gateway in the same
    command when the count is up, no routine run is live and nothing was written for that long.
    """
    command = "python3 -c " + shlex.quote(HOST_CHECK) + " " + shlex.quote(hermes_home) + " " + shlex.quote(str(restart_after))
    try:
        result = host_access.ssh(host, command, timeout=180, check=False, capture=True)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (subprocess.SubprocessError, ValueError):
        return None


def describe(report):
    if report is None:
        return "gateway state unreadable"
    agents, work = report.get("agents"), report.get("work") or []
    listed = ", ".join(str(item.get("profile") or item.get("kind") or item)[:40] for item in work[:3]) if work else ""
    quiet = report.get("quiet")
    silence = ", a session store unreadable" if quiet is None else f", last assistant message {quiet / 60:.0f} min ago"
    routines = report.get("routines") or 0
    running = f", {routines} routine run{'' if routines == 1 else 's'} live" if routines else ""
    return f"gateway: {agents} active agent{'' if agents == 1 else 's'}{', ' + listed if listed else ''}{silence}{running}"


def leaked(report, counted_since, now, window):
    """A count this loop has watched for the whole window, with nothing written and no routine run live."""
    if not report or counted_since is None or now - counted_since < window or report.get("routines"):
        return False
    quiet = report.get("quiet")
    return quiet is not None and quiet >= window


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("commit")
    parser.add_argument("--host", required=True)
    parser.add_argument("--app-base", required=True)
    parser.add_argument("--qualification")
    parser.add_argument("--accept-helper-change", action="store_true",
                        help="pass through to release-app.py prepare after reviewing a changed upgrade helper")
    parser.add_argument("--minutes", type=float, default=40, help="give up after this long (default 40)")
    parser.add_argument("--interval", type=float, default=120, help="seconds between attempts (default 120)")
    parser.add_argument("--hermes-home", default="~/.hermes", help="Hermes home on the host (default ~/.hermes)")
    parser.add_argument("--household-idle", action="store_true",
                        help="the household confirmed nobody is mid-conversation: restart a leaked gateway count once")
    args = parser.parse_args()
    command = [sys.executable, str(TOOL), "prepare", args.commit, "--host", args.host, "--app-base", args.app_base]
    if args.qualification:
        command += ["--qualification", args.qualification]
    if args.accept_helper_change:
        command.append("--accept-helper-change")
    window = QUIET_MINUTES * 60
    deadline = time.monotonic() + args.minutes * 60
    attempt = 0
    counted_since = None
    reported = restarted = False
    while True:
        attempt += 1
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        output = result.stdout + result.stderr
        prepared = re.search(r"^Prepared .*$", output, re.M)
        if prepared:
            print(prepared.group(0))
            return 0
        stage = DISCARD.search(output)
        if not BUSY.search(output):
            print(output, end="", file=sys.stderr)
            print(f"Attempt {attempt} failed for a reason other than busy assistants; not retrying.", file=sys.stderr)
            return 1
        if stage:
            subprocess.run([sys.executable, str(TOOL), "discard", stage.group(1), "--host", args.host], capture_output=True, check=True)
        report = gateway_report(args.host, args.hermes_home)
        # Two owners can refuse: app and routine sessions behind the maintenance gate, or the messaging gateway.
        owner = "app or routine session running" if "Fence: maintenance gate" in output else "messaging gateway busy"
        print(f"Attempt {attempt}: {owner} ({describe(report)}), discarded {stage.group(1) if stage else 'nothing'}.", flush=True)
        now = time.monotonic()
        # Hermes flushes a turn's messages after each tool batch, so a working turn never stays
        # quiet for long. This loop still watches the count itself for the whole window rather
        # than trusting how long it may have been up before the run started.
        counted = bool(report and report.get("agents"))
        if not counted:
            counted_since = None
        elif counted_since is None:
            counted_since = now
        if leaked(report, counted_since, now, window) and not restarted:
            if not args.household_idle:
                if not reported:
                    reported = True
                    print(f"The gateway has counted an agent for {QUIET_MINUTES}+ minutes with no message written and no "
                          "routine run live, which looks like a leaked count. A long model call can also be silent, so "
                          "confirm nobody is mid-conversation (Discord included), then rerun with --household-idle or run "
                          "`systemctl --user restart hermes-gateway.service` on the host. See docs/Hosting.md.",
                          file=sys.stderr, flush=True)
            else:
                checked = gateway_report(args.host, args.hermes_home, restart_after=window)
                if checked and checked.get("restarted"):
                    restarted = True
                    print(f"Restarted hermes-gateway.service: it counted an agent for {QUIET_MINUTES}+ minutes with no "
                          "message written and no routine run live.", flush=True)
                    counted_since = None
                    if time.monotonic() + 30 <= deadline:
                        time.sleep(30)
                        continue
                else:
                    print(f"Did not restart the gateway: the host re-check saw new work or could not restart it "
                          f"({describe(checked)}).", file=sys.stderr, flush=True)
        if time.monotonic() + args.interval > deadline:
            print("Gave up waiting for idle assistants.", file=sys.stderr)
            return 2
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
