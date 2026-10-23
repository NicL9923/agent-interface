#!/usr/bin/env python3
"""Run release-app.py prepare until the household's assistants are idle.

The guarded preflight refuses while Hermes is busy. This retries only that
refusal, discarding each refused stage, and stops on any other failure.
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
# On Oct 22, 2026 the gateway counted one agent for 80 minutes with no listed work, no
# turn, cron, kanban or delegation records and no new messages; a restart cleared it.
STUCK_MINUTES = 20


def gateway_report(host, hermes_home):
    """What the gateway says is running, read without changing anything, or None if unreadable."""
    script = ("import json,os;d=json.load(open(os.path.join(os.path.expanduser(%r),'gateway_state.json')));"
              "print(json.dumps({'agents':d.get('active_agents'),'work':d.get('active_work') or []}))" % hermes_home)
    try:
        result = host_access.ssh(host, "python3 -c " + shlex.quote(script), timeout=30, check=False, capture=True)
        return json.loads(result.stdout) if result.returncode == 0 else None
    except (subprocess.SubprocessError, ValueError):
        return None


def describe(report):
    if report is None:
        return "gateway state unreadable"
    agents, work = report.get("agents"), report.get("work") or []
    listed = ", ".join(str(item.get("profile") or item.get("kind") or item)[:40] for item in work[:3]) if work else "no listed work"
    return f"gateway: {agents} active agent{'' if agents == 1 else 's'}, {listed}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("commit")
    parser.add_argument("--host", required=True)
    parser.add_argument("--app-base", required=True)
    parser.add_argument("--qualification")
    parser.add_argument("--minutes", type=float, default=40, help="give up after this long (default 40)")
    parser.add_argument("--interval", type=float, default=120, help="seconds between attempts (default 120)")
    parser.add_argument("--hermes-home", default="~/.hermes", help="Hermes home on the host (default ~/.hermes)")
    args = parser.parse_args()
    command = [sys.executable, str(TOOL), "prepare", args.commit, "--host", args.host, "--app-base", args.app_base]
    if args.qualification:
        command += ["--qualification", args.qualification]
    deadline = time.monotonic() + args.minutes * 60
    attempt = 0
    unexplained_since = None
    hinted = False
    while True:
        attempt += 1
        result = subprocess.run(command, capture_output=True, text=True)
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
        print(f"Attempt {attempt}: assistants busy ({describe(report)}), discarded {stage.group(1) if stage else 'nothing'}.", flush=True)
        # Agents counted with nothing listed, for a long time, is the signature of a stuck turn.
        unexplained = bool(report and report.get("agents") and not report.get("work"))
        if not unexplained:
            unexplained_since = None
        elif unexplained_since is None:
            unexplained_since = time.monotonic()
        if unexplained_since is not None and not hinted and time.monotonic() - unexplained_since >= STUCK_MINUTES * 60:
            hinted = True
            print(f"The gateway has counted active agents with no listed work for {STUCK_MINUTES}+ minutes. If nobody "
                  "is mid-conversation (Discord included), a turn is likely stuck: with the household's okay, "
                  "`systemctl --user restart hermes-gateway.service` on the host clears it. See docs/Hosting.md.", file=sys.stderr, flush=True)
        if time.monotonic() + args.interval > deadline:
            print("Gave up waiting for idle assistants.", file=sys.stderr)
            return 2
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
