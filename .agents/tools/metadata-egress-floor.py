#!/usr/bin/env python3
"""Install, check or remove the host's metadata egress floor. Run on the host with sudo.

  install --user NAME | --uid N   Load the agent_interface_metadata nftables table and the
                                  root oneshot unit that reloads it at boot. Idempotent.
  check [--user NAME] [--egress HOST:PORT]
                                  Prove, as the service user, that the metadata service is
                                  refused quickly while ordinary DNS and HTTPS egress work.
  remove                          Disable the unit and delete only this table and its files.

The floor rejects every packet the service user's sockets send to the cloud metadata
service: OpenStack's IPv4 169.254.169.254 and its IPv6 link-local fe80::a9fe:a9fe. Other
link-local addresses stay reachable, root (cloud-init) is unaffected, and the tool never
flushes the ruleset or touches another table, so ufw's iptables-nft rules stay as they are.
"""
import argparse
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
from pathlib import Path

TABLE = "agent_interface_metadata"
UNIT = "agent-interface-metadata-floor.service"
RULES = Path("/etc/agent-interface/metadata-egress-floor.nft")
UNIT_FILE = Path("/etc/systemd/system") / UNIT
METADATA_V4 = "169.254.169.254"
METADATA_V6 = "fe80::a9fe:a9fe"
# A refusal from the floor arrives in milliseconds; an unanswered SYN would take seconds.
REFUSED_WITHIN_MS = 1000
DEFAULT_EGRESS = "github.com:443"


def rules(uid):
    """The nft script that atomically replaces this one table and nothing else."""
    if not isinstance(uid, int) or isinstance(uid, bool) or uid <= 0:
        raise ValueError("The floor needs the service user's non-root uid.")
    match = f"meta skuid {uid}"
    return f"""#!/usr/sbin/nft -f
# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.
# Loads only table inet {TABLE}: declaring it first makes the delete safe when it is absent,
# and the whole file applies as one transaction. Never add "flush ruleset" here.
table inet {TABLE} {{}}
delete table inet {TABLE}
table inet {TABLE} {{
\tchain output {{
\t\ttype filter hook output priority filter; policy accept;
\t\t{match} ip daddr {METADATA_V4} meta l4proto tcp reject with tcp reset
\t\t{match} ip daddr {METADATA_V4} reject with icmpx admin-prohibited
\t\t{match} ip6 daddr {METADATA_V6} meta l4proto tcp reject with tcp reset
\t\t{match} ip6 daddr {METADATA_V6} reject with icmpx admin-prohibited
\t}}
}}
"""


def unit(uid, nft):
    return f"""# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.
[Unit]
Description=Agent Interface metadata egress floor (nftables table inet {TABLE})
# nftables.service flushes the whole ruleset when it loads, so this follows it, and
# reloads or restarts with it. ufw's iptables-nft tables are separate and stay untouched.
After=network.target nftables.service ufw.service
PartOf=nftables.service
ReloadPropagatedFrom=nftables.service
# The service user's own services start after the floor holds.
Before=user@{uid}.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={nft} -f {RULES}
ExecReload={nft} -f {RULES}

[Install]
WantedBy=multi-user.target
"""


def installed_uid(text):
    """The uid an installed rules file blocks, or None when it is not ours."""
    found = set(re.findall(r"meta skuid (\d+) ", text or ""))
    return int(found.pop()) if len(found) == 1 else None


def resolve_user(user=None, uid=None):
    """(name, uid, gid) of the service account; refuses root."""
    try:
        entry = pwd.getpwnam(user) if user is not None else pwd.getpwuid(uid)
    except KeyError:
        raise SystemExit(f"No account {user if user is not None else uid} exists on this host.") from None
    if entry.pw_uid == 0:
        raise SystemExit("Refusing uid 0: blocking root would break cloud-init and protect nothing.")
    return entry.pw_name, entry.pw_uid, entry.pw_gid


class System:
    """Every host side effect, so tests can stub them with a temporary root."""

    def __init__(self, root=Path("/")):
        self.root = Path(root)

    def path(self, absolute):
        return self.root / Path(absolute).relative_to("/")

    def run(self, argv, *, input=None, timeout=60):
        return subprocess.run(argv, input=input, capture_output=True, text=True, timeout=timeout, check=False)

    def nft(self):
        return shutil.which("nft") or "/usr/sbin/nft"

    def read(self, absolute):
        path = self.path(absolute)
        return path.read_text() if path.is_file() else None

    def write(self, absolute, text):
        """Write root-owned, world-readable text atomically; True when the content changed."""
        path = self.path(absolute)
        if path.is_file() and path.read_text() == text:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_name(path.name + ".new")
        staged.write_text(text)
        staged.chmod(0o644)
        os.replace(staged, path)
        return True

    def remove(self, absolute):
        path = self.path(absolute)
        if path.is_file():
            path.unlink()
            return True
        return False

    def require_root(self):
        if os.geteuid() != 0:
            raise SystemExit("Run this with sudo: it loads nftables rules and a root systemd unit.")


def must(system, argv, why):
    done = system.run(argv)
    if done.returncode:
        raise SystemExit(f"{why} failed ({' '.join(argv)}): {(done.stderr or done.stdout).strip()[-500:]}")
    return done


def install(system, uid):
    """Write, validate and load the floor. Rerunning with the same uid changes no file."""
    system.require_root()
    nft = system.nft()
    script = rules(uid)
    previous = installed_uid(system.read(RULES))
    # Validate on this host's nft before anything changes. -c parses and checks without loading.
    staged = RULES.with_name(RULES.name + ".check")
    system.write(staged, script)
    try:
        must(system, [nft, "-c", "-f", str(staged)], "Checking the generated rules")
    finally:
        system.remove(staged)
    changed = [str(path) for path, text in ((RULES, script), (UNIT_FILE, unit(uid, nft))) if system.write(path, text)]
    if str(UNIT_FILE) in changed:
        must(system, ["systemctl", "daemon-reload"], "Reloading systemd")
    must(system, ["systemctl", "enable", UNIT], "Enabling the boot unit")
    # Restart reapplies the file, so the live table always matches it, even after a manual edit.
    must(system, ["systemctl", "restart", UNIT], "Loading the table")
    return {"installed": True, "uid": uid, "previousUid": previous, "changedFiles": changed}


def remove(system):
    system.require_root()
    if system.read(UNIT_FILE) is not None:
        must(system, ["systemctl", "disable", "--now", UNIT], "Disabling the boot unit")
    removed = [str(path) for path in (UNIT_FILE, RULES) if system.remove(path)]
    if str(UNIT_FILE) in removed:
        must(system, ["systemctl", "daemon-reload"], "Reloading systemd")
    present = system.run([system.nft(), "list", "table", "inet", TABLE]).returncode == 0
    if present:
        must(system, [system.nft(), "delete", "table", "inet", TABLE], "Deleting the table")
    return {"removed": True, "files": removed, "tableDeleted": present}


# Runs as the service user. Prints one JSON object; never raises for a network outcome.
PROBE_SOURCE = r"""
import errno, json, socket, sys, time
args = json.loads(sys.argv[1])
def attempt(address, port, timeout):
    started = time.monotonic()
    try:
        family, kind, proto, _, target = socket.getaddrinfo(address, port, type=socket.SOCK_STREAM)[0]
        with socket.socket(family, kind, proto) as sock:
            sock.settimeout(timeout)
            sock.connect(target)
        outcome = "connected"
    except (TimeoutError, socket.timeout):
        outcome = "timeout"
    except socket.gaierror as error:
        outcome = "dns:" + str(error.errno)
    except OSError as error:
        outcome = errno.errorcode.get(error.errno, "error")
    return {"outcome": outcome, "ms": round((time.monotonic() - started) * 1000)}
result = {name: attempt(*target) for name, target in args["targets"].items()}
host, port = args["egress"]
try:
    result["dns"] = {"outcome": "resolved", "addresses": sorted({row[4][0] for row in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})}
except OSError as error:
    result["dns"] = {"outcome": "failed", "error": str(error)}
result["egress"] = attempt(host, port, 10)
print(json.dumps(result))
"""


def default_interface(system):
    """The IPv4 default route's interface, which scopes the IPv6 link-local metadata address."""
    for line in (system.read("/proc/net/route") or "").splitlines()[1:]:
        fields = line.split()
        if len(fields) > 2 and fields[1] == "00000000":
            return fields[0]
    return None


def probe(system, uid, gid, egress):
    host, _, port = egress.rpartition(":")
    targets = {"metadataV4": [METADATA_V4, 80, 3]}
    interface = default_interface(system)
    if interface:
        targets["metadataV6"] = [f"{METADATA_V6}%{interface}", 80, 3]
    payload = json.dumps({"targets": targets, "egress": [host, int(port)]})
    done = system.run(["setpriv", f"--reuid={uid}", f"--regid={gid}", "--init-groups", "--",
                       sys.executable, "-I", "-c", PROBE_SOURCE, payload], timeout=60)
    if done.returncode:
        raise SystemExit(f"The probe could not run as uid {uid}: {done.stderr.strip()[-500:]}")
    result = json.loads(done.stdout.strip().splitlines()[-1])
    sudo = system.run(["setpriv", f"--reuid={uid}", f"--regid={gid}", "--init-groups", "--", "sudo", "-n", "true"])
    result["passwordlessSudo"] = sudo.returncode == 0
    return result


def evaluate(state):
    """Named pass/fail checks from gathered state; pure, so tests need no host."""
    v4, v6 = state["probe"]["metadataV4"], state["probe"].get("metadataV6")
    return {
        "rulesFileCurrent": state["rules"] is not None and state["rules"] == rules(state["uid"]),
        "unitEnabled": state["enabled"] == "enabled",
        "unitActive": state["active"] == "active",
        "tableLoaded": state["tableLoaded"],
        # The floor answers at once; a timeout means something else, not the floor, stopped it.
        "metadataV4RefusedQuickly": v4["outcome"] not in ("connected", "timeout") and v4["ms"] <= REFUSED_WITHIN_MS,
        # Link-local IPv6 may simply be unrouted here; only a connection is a failure.
        "metadataV6Unreachable": v6 is None or v6["outcome"] != "connected",
        "dnsResolves": state["probe"]["dns"]["outcome"] == "resolved",
        "egressConnects": state["probe"]["egress"]["outcome"] == "connected",
    }


def check(system, user=None, egress=DEFAULT_EGRESS):
    system.require_root()
    text = system.read(RULES)
    uid = installed_uid(text)
    if uid is None:
        raise SystemExit(f"The floor is not installed: {RULES} is missing or not this tool's. Run install first.")
    name, expected, gid = resolve_user(user=user) if user else resolve_user(uid=uid)
    if expected != uid:
        raise SystemExit(f"The floor blocks uid {uid}, but {name} is uid {expected}. Reinstall with --user {name}.")
    state = {
        "uid": uid, "rules": text,
        "enabled": system.run(["systemctl", "is-enabled", UNIT]).stdout.strip(),
        "active": system.run(["systemctl", "is-active", UNIT]).stdout.strip(),
        "tableLoaded": system.run([system.nft(), "list", "table", "inet", TABLE]).returncode == 0,
        "probe": probe(system, uid, gid, egress),
    }
    checks = evaluate(state)
    warnings = []
    if state["probe"]["passwordlessSudo"]:
        warnings.append(f"{name} can run sudo without a password, so any agent running as {name} could remove this floor.")
    return {"ok": all(checks.values()), "user": name, "uid": uid, "checks": checks,
            "probe": state["probe"], "warnings": warnings}


def main(argv=None, system=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    step = commands.add_parser("install", help="load the table and enable its boot unit")
    who = step.add_mutually_exclusive_group(required=True)
    who.add_argument("--user", help="the household service account, for example nicolas")
    who.add_argument("--uid", type=int, help="the service account's uid")
    step = commands.add_parser("check", help="prove the floor as the service user")
    step.add_argument("--user", help="fail unless the floor blocks this account")
    step.add_argument("--egress", default=DEFAULT_EGRESS, help=f"HOST:PORT that must stay reachable (default {DEFAULT_EGRESS})")
    commands.add_parser("remove", help="disable the unit and delete only this table")
    args = parser.parse_args(argv)
    system = system or System()
    if args.command == "install":
        _, uid, _ = resolve_user(user=args.user) if args.user is not None else resolve_user(uid=args.uid)
        result = install(system, uid)
    elif args.command == "check":
        if not re.fullmatch(r"[^\s:]+:\d+", args.egress):
            raise SystemExit("--egress must be HOST:PORT")
        result = check(system, args.user, args.egress)
    else:
        result = remove(system)
    print(json.dumps(result, indent=2))
    for warning in result.get("warnings", []):
        print("Warning: " + warning, file=sys.stderr)
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
