#!/usr/bin/env python3
"""Run release-app.py prepare until the household's assistants are idle.

The guarded preflight refuses while Hermes is busy. This retries only that
refusal, discarding each refused stage, and stops on any other failure.

The messaging gateway can keep counting an agent after its turn has ended (Oct 22 and
Nov 2, 2026). A real turn writes to its session as it works, so a count that persists
while no assistant has written anything is a leaked count. Once per run, this restarts
the gateway when the count has stayed up and every profile's session store has been
quiet for STUCK_MINUTES, or QUIET_MINUTES with --household-idle, which the operator
passes only after the household confirms nobody is mid-conversation.
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
BUSY = re.compile(r'Fence: (?:maintenance gate inactive with no busy work|gateway reports no active agents or work)|gate\["busy"\]')
DISCARD = re.compile(r"Discard with: release-app\.py discard (release-[\w-]+)")
# How long a counted agent with silent session stores counts as stuck, without and with
# the household's word that nobody is mid-conversation.
STUCK_MINUTES = 20
QUIET_MINUTES = 5


def gateway_report(host, hermes_home):
    """What the gateway counts and when any profile last wrote a message, read without changing anything.

    ``work`` is filled by Hermes only while it drains, so an empty list is normal for a real turn.
    ``quiet`` is seconds since the newest message in any profile's session store, or None if unreadable.
    """
    script = (
        "import glob,json,os,sqlite3,time\n"
        "home=os.path.expanduser(%r)\n"
        "d=json.load(open(os.path.join(home,'gateway_state.json')))\n"
        "newest=None\n"
        "for path in [os.path.join(home,'state.db')]+glob.glob(os.path.join(home,'profiles','*','state.db')):\n"
        "    try:\n"
        "        c=sqlite3.connect('file:'+path+'?mode=ro',uri=True,timeout=2)\n"
        "        t=c.execute('select max(timestamp) from messages').fetchone()[0]\n"
        "        c.close()\n"
        "    except Exception:\n"
        "        continue\n"
        "    if t is not None and (newest is None or t>newest): newest=t\n"
        "print(json.dumps({'agents':d.get('active_agents'),'work':d.get('active_work') or [],"
        "'quiet':None if newest is None else max(0.0,time.time()-newest)}))\n"
    ) % hermes_home
    try:
        result = host_access.ssh(host, "python3 -c " + shlex.quote(script), timeout=30, check=False, capture=True)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (subprocess.SubprocessError, ValueError):
        return None


def describe(report):
    if report is None:
        return "gateway state unreadable"
    agents, work = report.get("agents"), report.get("work") or []
    listed = ", ".join(str(item.get("profile") or item.get("kind") or item)[:40] for item in work[:3]) if work else ""
    quiet = report.get("quiet")
    silence = "" if quiet is None else f", last assistant message {quiet / 60:.0f} min ago"
    return f"gateway: {agents} active agent{'' if agents == 1 else 's'}{', ' + listed if listed else ''}{silence}"


def stuck(report, counted_since, now, window):
    """A leaked count: agents counted for the whole window and no profile has written a message in it."""
    quiet = report.get("quiet") if report else None
    return counted_since is not None and now - counted_since >= window and quiet is not None and quiet >= window


def restart_gateway(host):
    result = host_access.ssh(host, "systemctl --user restart hermes-gateway.service", timeout=120, check=False, capture=True)
    return result.returncode == 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("commit")
    parser.add_argument("--host", required=True)
    parser.add_argument("--app-base", required=True)
    parser.add_argument("--qualification")
    parser.add_argument("--minutes", type=float, default=40, help="give up after this long (default 40)")
    parser.add_argument("--interval", type=float, default=120, help="seconds between attempts (default 120)")
    parser.add_argument("--hermes-home", default="~/.hermes", help="Hermes home on the host (default ~/.hermes)")
    parser.add_argument("--household-idle", action="store_true",
                        help=f"the household confirmed nobody is mid-conversation: treat a count with {QUIET_MINUTES} "
                             f"quiet minutes as stuck instead of {STUCK_MINUTES}")
    parser.add_argument("--no-restart", action="store_true", help="never restart the gateway; only report a stuck count")
    args = parser.parse_args()
    command = [sys.executable, str(TOOL), "prepare", args.commit, "--host", args.host, "--app-base", args.app_base]
    if args.qualification:
        command += ["--qualification", args.qualification]
    window = (QUIET_MINUTES if args.household_idle else STUCK_MINUTES) * 60
    deadline = time.monotonic() + args.minutes * 60
    attempt = 0
    counted_since = None
    restarted = False
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
        owner = "app or routine session running" if "maintenance gate" in output or 'gate["busy"]' in output else "messaging gateway busy"
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
        if not restarted and stuck(report, counted_since, now, window):
            minutes = window // 60
            if args.no_restart:
                print(f"The gateway counts an agent but no assistant has written a message for {minutes}+ minutes: a "
                      "leaked count. With the household's okay, `systemctl --user restart hermes-gateway.service` on "
                      "the host clears it. See docs/Hosting.md.", file=sys.stderr, flush=True)
            else:
                ok = restart_gateway(args.host)
                print(f"The gateway counted an agent while no assistant wrote a message for {minutes}+ minutes, so the "
                      f"count was leaked. {'Restarted' if ok else 'Could not restart'} hermes-gateway.service.",
                      file=sys.stderr if not ok else sys.stdout, flush=True)
            restarted = True
            counted_since = None
            # The restarted gateway needs a moment before its count is meaningful again.
            if not args.no_restart and time.monotonic() + 30 <= deadline:
                time.sleep(30)
                continue
        if time.monotonic() + args.interval > deadline:
            print("Gave up waiting for idle assistants.", file=sys.stderr)
            return 2
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
