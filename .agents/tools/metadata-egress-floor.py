#!/usr/bin/env python3
"""Install, check or remove the host's metadata egress floor. Run on the host with sudo.

  install --user NAME | --uid N   Load the agent_interface_metadata nftables table, include it
                                  in /etc/nftables.conf, and install its boot unit, the
                                  user-manager requirement and a read-only sudo rule. Idempotent.
  check [--user NAME] [--egress HOST:PORT]
                                  Compare the live table with the expected rules, then prove as
                                  the service user that metadata is refused while ordinary DNS
                                  and HTTPS egress work. Reports which persistence mode applies.
  remove                          Undo install. Deletes only this table and this tool's files.

The floor rejects every packet the service user's sockets send to the cloud metadata
service: OpenStack's IPv4 169.254.169.254 and its IPv6 link-local fe80::a9fe:a9fe. Other
link-local addresses stay reachable, root (cloud-init) is unaffected, and the tool never
flushes the ruleset or touches another table, so ufw's iptables-nft rules stay as they are.

Persistence: when /etc/nftables.conf exists, a marked include at its end loads the table in
the same transaction as that file's "flush ruleset", so an nftables.service start or reload
can never leave a gap. The oneshot unit loads it at boot either way, and the service user's
systemd manager requires that unit, so no household service starts without the floor.
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
RULES = Path("/etc/nftables.d/agent-interface-metadata.nft")
UNIT_FILE = Path("/etc/systemd/system") / UNIT
NFTABLES_CONF = Path("/etc/nftables.conf")
CONF_BACKUP = Path("/etc/nftables.conf.agent-interface.bak")
# sudo skips files in sudoers.d whose names contain a dot, so the staged copy is never live.
SUDOERS = Path("/etc/sudoers.d/agent-interface-metadata-floor")
NFTABLES_DROPIN = Path("/etc/systemd/system/nftables.service.d/agent-interface-metadata-floor.conf")
# Outside /etc/nftables.d, so a wildcard include in nftables.conf can never load its flush.
STOP_FILE = Path("/etc/agent-interface/nftables-stop.nft")
SYSTEMD = Path("/etc/systemd/system")
DROPIN_NAME = "agent-interface-metadata-floor.conf"
METADATA_V4 = "169.254.169.254"
METADATA_V6 = "fe80::a9fe:a9fe"
DEFAULT_EGRESS = "github.com:443"
BEGIN = "# BEGIN agent-interface metadata egress floor"
END = "# END agent-interface metadata egress floor"
# Markers are these exact whole lines; the same text elsewhere in a line is ordinary content.
BEGIN_LINE = f"{BEGIN}: managed by .agents/tools/metadata-egress-floor.py."

# Only these, arriving fast, prove a reject rule answered. Anything slower or different
# is inconclusive: an unanswered SYN, a full file table (EMFILE) or ARP/ND failure.
REFUSALS = frozenset({"ECONNREFUSED", "EACCES", "EPERM", "EHOSTUNREACH"})
REFUSED_WITHIN_MS = 1000
# No route to the address at all, so no packet can leave; acceptable only for link-local IPv6.
NO_ROUTE = frozenset({"ENETUNREACH", "EADDRNOTAVAIL", "ENODEV"})


def user_manager(uid):
    return f"user@{uid}.service"


def dropin(uid):
    return SYSTEMD / f"{user_manager(uid)}.d" / DROPIN_NAME


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


def expected_rules(uid):
    """(uid, family, address, l4proto, verdict) for each live rule, as normalized below."""
    return sorted(((uid, family, address, l4, verdict)
                   for family, address in (("ip", METADATA_V4), ("ip6", METADATA_V6))
                   for l4, verdict in (("tcp", "tcp reset"), (None, "icmpx admin-prohibited"))), key=repr)


def unit(nft):
    return f"""# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.
[Unit]
Description=Agent Interface metadata egress floor (nftables table inet {TABLE})
After=network.target nftables.service ufw.service
# The service user's manager requires this unit, so stopping or restarting it would stop or
# restart every household service. Reload reapplies the table without touching them.
RefuseManualStop=yes

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart={nft} -f {RULES}
ExecReload={nft} -f {RULES}

[Install]
WantedBy=multi-user.target
"""


def user_dropin():
    return f"""# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.
# Fails closed: the service user's manager, and with it Hermes, the app and the shared
# browser, does not start unless the metadata egress floor loaded. See docs/Hosting.md.
[Unit]
Requires={UNIT}
After={UNIT}
"""


def nftables_dropin(nft):
    return f"""# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.
# Debian's nftables.service stops with a bare "nft flush ruleset". This replaces it with one
# transaction that flushes and reloads the floor, so no packet passes between the two.
[Service]
ExecStop=
ExecStop={nft} -f {STOP_FILE}
"""


def stop_rules():
    return f"""#!/usr/sbin/nft -f
# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.
# nftables.service stops with this file: the flush and the floor commit as one transaction.
flush ruleset
include "{RULES}"
"""


def sudoers(user, nft):
    return (f"# Managed by agent-interface .agents/tools/metadata-egress-floor.py. Do not edit.\n"
            f"# Read-only: lets release checks compare the live floor without a password.\n"
            f"{user} ALL=(root) NOPASSWD: {nft} -j list table inet {TABLE}\n")


def marker_span(conf):
    """Line indexes of the one BEGIN/END pair, None without markers; ValueError otherwise."""
    lines = conf.splitlines()
    begins = [number for number, line in enumerate(lines) if line.strip() == BEGIN_LINE]
    ends = [number for number, line in enumerate(lines) if line.strip() == END]
    if not begins and not ends:
        return None
    if len(begins) == len(ends) == 1 and begins[0] < ends[0]:
        return begins[0], ends[0]
    raise ValueError(f"{NFTABLES_CONF} has {len(begins)} BEGIN and {len(ends)} END agent-interface markers"
                     f"{' out of order' if len(begins) == len(ends) == 1 else ''}. Fix them by hand to zero or one "
                     f"ordered pair; nothing was changed.")


def marker_problem(conf):
    """Why nftables.conf's markers are unsafe to edit, or None for zero or one ordered pair."""
    try:
        marker_span(conf)
    except ValueError as error:
        return str(error)
    return None


def without_include(conf):
    """The nftables.conf text without exactly the marked lines, and the blank lines just before them."""
    span = marker_span(conf)
    if span is None:
        return conf.rstrip("\n") + "\n"
    lines = conf.splitlines(keepends=True)
    head, tail = "".join(lines[:span[0]]).rstrip("\n"), "".join(lines[span[1] + 1:]).strip("\n")
    return "\n\n".join(part for part in (head, tail) if part) + "\n"


def with_include(conf):
    """The block goes last, so it loads after any "flush ruleset" in the same transaction."""
    block = (f"{BEGIN_LINE}\n"
             f"# Keep this block last, after any flush ruleset.\n"
             f'include "{RULES}"\n{END}\n')
    return without_include(conf) + "\n" + block


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


# Verdicts shared with release-app.py and the probe program.

def verdict(attempt):
    """refused, connected, no-route or inconclusive for one connect attempt."""
    if attempt["outcome"] == "connected":
        return "connected"
    if attempt["outcome"] in REFUSALS and attempt["ms"] <= REFUSED_WITHIN_MS:
        return "refused"
    if attempt["outcome"] in NO_ROUTE:
        return "no-route"
    return "inconclusive"


def probe_problems(probe):
    """IPv4 metadata must be refused; IPv6 on each link-local interface refused or unroutable."""
    problems = []
    found = verdict(probe["metadataV4"])
    if found != "refused":
        problems.append(f"{METADATA_V4}:80 was {found} ({probe['metadataV4']['outcome']} in {probe['metadataV4']['ms']} ms), not refused.")
    for interface, attempt in sorted(probe["metadataV6"].items()):
        found = verdict(attempt)
        if found not in ("refused", "no-route"):
            problems.append(f"{METADATA_V6}%{interface} port 80 was {found} ({attempt['outcome']} in {attempt['ms']} ms), not refused.")
    return problems


def requires_floor(show):
    """Whether `systemctl show user@UID.service -p Requires -p After` names the floor unit in both."""
    properties = dict(line.split("=", 1) for line in show.splitlines() if "=" in line)
    return all(UNIT in properties.get(key, "").split() for key in ("Requires", "After"))


def _normalized(rule, user):
    uid = family = address = l4 = action = None
    extra = []
    for expression in rule.get("expr", []):
        if "match" in expression:
            match = expression["match"]
            left, right = match.get("left", {}), match.get("right")
            if match.get("op", "==") not in ("==", "in"):
                extra.append(json.dumps(expression, sort_keys=True))
            elif left.get("meta", {}).get("key") == "skuid":
                uid = int(right) if str(right).isdigit() else (user[1] if right == user[0] else right)
            elif left.get("meta", {}).get("key") == "l4proto":
                l4 = "tcp" if right in ("tcp", 6) else right
            elif left.get("meta", {}).get("key") == "nfproto":
                continue  # An implied dependency of ip/ip6 matches in an inet table.
            elif left.get("payload", {}).get("field") == "daddr":
                family, address = left["payload"].get("protocol"), right
            else:
                extra.append(json.dumps(expression, sort_keys=True))
        elif "reject" in expression:
            reject = expression["reject"] or {}
            action = " ".join(str(part) for part in (reject.get("type"), reject.get("expr")) if part)
        else:
            extra.append(json.dumps(expression, sort_keys=True))
    return (uid, family, address, l4, action) if not extra else ("unexpected", *extra)


def live_rule_problems(listing, uid, user):
    """Compare `nft -j list table inet agent_interface_metadata` output with the expected floor."""
    try:
        items = json.loads(listing)["nftables"]
    except (TypeError, ValueError, KeyError):
        return ["The live table could not be listed as nft JSON."]
    chains = [item["chain"] for item in items if "chain" in item]
    shape = [(chain.get("name"), chain.get("type"), chain.get("hook"), chain.get("prio", 0), chain.get("policy", "accept"))
             for chain in chains]
    problems = []
    if shape != [("output", "filter", "output", 0, "accept")]:
        problems.append(f"The live table's chains are {shape}, not one filter chain on the output hook.")
    live = sorted((_normalized(item["rule"], (user, uid)) for item in items if "rule" in item), key=repr)
    expected = sorted(expected_rules(uid), key=repr)
    if live != expected:
        problems.append(f"The live rules are {live}, not {expected}.")
    return problems


# Runs as the service user, from this tool and inside release-app.py's host programs.
PROBE_FUNCTIONS = r'''
def floor_attempt(address, port, timeout):
    import errno, socket, time
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

def floor_link_local_interfaces(path):
    try:
        with open(path) as table:
            rows = [line.split() for line in table]
    except OSError:
        return []
    # Scope 20 is link-local. Loopback never routes the metadata address.
    return sorted({row[5] for row in rows if len(row) == 6 and row[3] == "20" and row[5] != "lo"})

def floor_probe(v4, v6, port, timeout, interfaces):
    return {"metadataV4": floor_attempt(v4, port, timeout),
            "metadataV6": {name: floor_attempt(v6 + "%" + name, port, timeout)
                           for name in floor_link_local_interfaces(interfaces)}}
'''

PROBE_SOURCE = PROBE_FUNCTIONS + r'''
import json, socket, sys
args = json.loads(sys.argv[1])
result = floor_probe(args["v4"], args["v6"], args["port"], args["timeout"], args["interfaces"])
host, port = args["egress"]
try:
    result["dns"] = {"outcome": "resolved", "addresses": sorted({row[4][0] for row in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})}
except OSError as error:
    result["dns"] = {"outcome": "failed", "error": str(error)}
result["egress"] = floor_attempt(host, port, 10)
print(json.dumps(result))
'''


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

    def write(self, absolute, text, mode=0o644):
        """Write root-owned text atomically; True when the content changed."""
        path = self.path(absolute)
        if path.is_file() and path.read_text() == text and path.stat().st_mode & 0o777 == mode:
            return False
        path.parent.mkdir(parents=True, exist_ok=True)
        staged = path.with_name(path.name + ".new")
        staged.write_text(text)
        staged.chmod(mode)
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
            raise SystemExit("Run this with sudo: it loads nftables rules and root systemd units.")


def must(system, argv, why):
    done = system.run(argv)
    if done.returncode:
        raise SystemExit(f"{why} failed ({' '.join(argv)}): {(done.stderr or done.stdout).strip()[-500:]}")
    return done


def validated(system, path, text, argv, why):
    """Check staged text with argv + its path before anything live changes."""
    staged = Path(str(path) + ".check")
    system.write(staged, text, 0o600)
    try:
        must(system, [*argv, str(staged)], why)
    finally:
        system.remove(staged)


def mode(system):
    """How the floor survives reboots and nftables.service on this host."""
    service = system.run(["systemctl", "is-enabled", "nftables.service"]).stdout.strip() or "not-found"
    conf = system.read(NFTABLES_CONF)
    included = conf is not None and not marker_problem(conf) and with_include(conf) == conf
    return {"nftablesService": service, "nftablesConfInclude": included,
            "persistence": ("nftables.conf include and boot unit" if included else "boot unit only")}


def require_markers(system):
    conf = system.read(NFTABLES_CONF)
    if conf is not None and marker_problem(conf):
        raise SystemExit(marker_problem(conf))
    return conf


def managed_user_dropins(system):
    """Every user@UID.service drop-in this tool wrote, found without trusting the rules file."""
    return sorted(Path("/") / path.relative_to(system.root)
                  for path in system.path(SYSTEMD).glob(f"user@*.service.d/{DROPIN_NAME}") if path.is_file())


def install(system, name, uid):
    """Write, validate and load the floor. Rerunning with the same uid changes no file."""
    system.require_root()
    nft = system.nft()
    require_markers(system)
    script = rules(uid)
    previous = installed_uid(system.read(RULES))
    validated(system, RULES, script, [nft, "-c", "-f"], "Checking the generated rules")
    changed = [str(RULES)] if system.write(RULES, script) else []
    conf = system.read(NFTABLES_CONF)
    if conf is None and system.run(["systemctl", "is-enabled", "nftables.service"]).stdout.strip() == "enabled":
        raise SystemExit(f"nftables.service is enabled but {NFTABLES_CONF} is missing; resolve that first.")
    if conf is not None and with_include(conf) != conf:
        # Checked whole, flush included, without loading: a broken include never reaches the host.
        validated(system, NFTABLES_CONF, with_include(conf), [nft, "-c", "-f"], f"Checking {NFTABLES_CONF} with the include")
        if system.read(CONF_BACKUP) is None:
            system.write(CONF_BACKUP, conf)
        system.write(NFTABLES_CONF, with_include(conf), system.path(NFTABLES_CONF).stat().st_mode & 0o777)
        changed.append(str(NFTABLES_CONF))
    validated(system, SUDOERS, sudoers(name, nft), ["visudo", "-c", "-f"], "Checking the sudo rule")
    # Checked whole, flush included, before nftables.service can ever stop with it.
    validated(system, STOP_FILE, stop_rules(), [nft, "-c", "-f"], "Checking the nftables stop file")
    changed += [str(STOP_FILE)] if system.write(STOP_FILE, stop_rules()) else []
    units = [(UNIT_FILE, unit(nft)), (dropin(uid), user_dropin()), (NFTABLES_DROPIN, nftables_dropin(nft))]
    changed_units = [str(path) for path, text in units if system.write(path, text)]
    # A previous uid's requirement, wherever it came from, must not outlive its rules.
    changed_units += [str(path) for path in managed_user_dropins(system) if path != dropin(uid) and system.remove(path)]
    changed += changed_units + ([str(SUDOERS)] if system.write(SUDOERS, sudoers(name, nft), 0o440) else [])
    if changed_units:
        must(system, ["systemctl", "daemon-reload"], "Reloading systemd")
    must(system, ["systemctl", "enable", UNIT], "Enabling the boot unit")
    # Start loads it when inactive; reload reapplies it when active. Never restart: the user
    # manager requires this unit, so a restart would restart every household service.
    must(system, ["systemctl", "start", UNIT], "Starting the boot unit")
    must(system, ["systemctl", "reload", UNIT], "Loading the table")
    return {"installed": True, "uid": uid, "previousUid": previous, "changedFiles": changed, "mode": mode(system)}


def remove(system):
    system.require_root()
    nft = system.nft()
    conf = require_markers(system)
    # The requirement goes first, so nothing below can stop the household services. Found by
    # name, so a missing or damaged rules file never leaves a manager requiring a removed unit.
    removed = [str(path) for path in [*managed_user_dropins(system), NFTABLES_DROPIN] if system.remove(path)]
    if removed:
        must(system, ["systemctl", "daemon-reload"], "Reloading systemd")
    if system.read(UNIT_FILE) is not None:
        # RefuseManualStop keeps the unit active until reboot; only the table is enforcement.
        must(system, ["systemctl", "disable", UNIT], "Disabling the boot unit")
    if conf is not None and without_include(conf) != conf:
        validated(system, NFTABLES_CONF, without_include(conf), [nft, "-c", "-f"], f"Checking {NFTABLES_CONF} without the include")
        system.write(NFTABLES_CONF, without_include(conf), system.path(NFTABLES_CONF).stat().st_mode & 0o777)
        removed.append(str(NFTABLES_CONF))
    present = system.run([nft, "list", "table", "inet", TABLE]).returncode == 0
    if present:
        must(system, [nft, "delete", "table", "inet", TABLE], "Deleting the table")
    removed += [str(path) for path in (UNIT_FILE, SUDOERS, STOP_FILE, RULES) if system.remove(path)]
    if str(UNIT_FILE) in removed:
        must(system, ["systemctl", "daemon-reload"], "Reloading systemd")
    return {"removed": True, "files": removed, "tableDeleted": present}


def as_user(uid, gid, argv):
    return ["setpriv", f"--reuid={uid}", f"--regid={gid}", "--init-groups", "--", *argv]


def probe(system, uid, gid, egress):
    host, _, port = egress.rpartition(":")
    payload = json.dumps({"v4": METADATA_V4, "v6": METADATA_V6, "port": 80, "timeout": 3,
                          "interfaces": str(system.path("/proc/net/if_inet6")), "egress": [host, int(port)]})
    done = system.run(as_user(uid, gid, [sys.executable, "-I", "-c", PROBE_SOURCE, payload]), timeout=120)
    if done.returncode:
        raise SystemExit(f"The probe could not run as uid {uid}: {done.stderr.strip()[-500:]}")
    result = json.loads(done.stdout.strip().splitlines()[-1])
    result["passwordlessSudo"] = system.run(as_user(uid, gid, ["sudo", "-n", "true"])).returncode == 0
    return result


def evaluate(state):
    """Named pass/fail checks from gathered state; pure, so tests need no host."""
    uid, name, found = state["uid"], state["user"], state["mode"]
    must_include = found["nftablesService"] == "enabled" or state["confExists"]
    return {
        "filesCurrent": state["files"] == {
            str(RULES): rules(uid), str(UNIT_FILE): unit(state["nft"]), str(dropin(uid)): user_dropin(),
            str(NFTABLES_DROPIN): nftables_dropin(state["nft"]), str(STOP_FILE): stop_rules(),
            str(SUDOERS): sudoers(name, state["nft"])},
        "nftablesConfIncludesFloor": found["nftablesConfInclude"] or not must_include,
        "unitEnabled": state["enabled"] == "enabled",
        "unitActive": state["active"] == "active",
        "userManagerRequiresFloor": requires_floor(state["userManager"]),
        "liveRulesMatch": not live_rule_problems(state["listing"], uid, name),
        "metadataRefused": not probe_problems(state["probe"]),
        "dnsResolves": state["probe"]["dns"]["outcome"] == "resolved",
        "egressConnects": state["probe"]["egress"]["outcome"] == "connected",
    }


def check(system, user=None, egress=DEFAULT_EGRESS):
    system.require_root()
    nft = system.nft()
    uid = installed_uid(system.read(RULES))
    if uid is None:
        raise SystemExit(f"The floor is not installed: {RULES} is missing or not this tool's. Run install first.")
    name, expected, gid = resolve_user(user=user) if user else resolve_user(uid=uid)
    if expected != uid:
        raise SystemExit(f"The floor blocks uid {uid}, but {name} is uid {expected}. Reinstall with --user {name}.")
    listing = system.run([nft, "-j", "list", "table", "inet", TABLE])
    state = {
        "uid": uid, "user": name, "nft": nft, "mode": mode(system),
        "confExists": system.read(NFTABLES_CONF) is not None,
        "files": {str(path): system.read(path) for path in (RULES, UNIT_FILE, dropin(uid), NFTABLES_DROPIN, STOP_FILE, SUDOERS)},
        "enabled": system.run(["systemctl", "is-enabled", UNIT]).stdout.strip(),
        "active": system.run(["systemctl", "is-active", UNIT]).stdout.strip(),
        "userManager": system.run(["systemctl", "show", user_manager(uid), "-p", "Requires", "-p", "After"]).stdout,
        "listing": listing.stdout if listing.returncode == 0 else None,
        "probe": probe(system, uid, gid, egress),
    }
    checks = evaluate(state)
    details = live_rule_problems(state["listing"], uid, name) + probe_problems(state["probe"])
    warnings = []
    if state["probe"]["passwordlessSudo"]:
        warnings.append(f"{name} can run sudo without a password, so any agent running as {name} could remove this floor.")
    return {"ok": all(checks.values()), "user": name, "uid": uid, "mode": state["mode"], "checks": checks,
            "problems": details, "probe": state["probe"], "warnings": warnings}


def main(argv=None, system=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    step = commands.add_parser("install", help="load the table and install its boot pieces")
    who = step.add_mutually_exclusive_group(required=True)
    who.add_argument("--user", help="the household service account, for example nicolas")
    who.add_argument("--uid", type=int, help="the service account's uid")
    step = commands.add_parser("check", help="compare the live floor and prove it as the service user")
    step.add_argument("--user", help="fail unless the floor blocks this account")
    step.add_argument("--egress", default=DEFAULT_EGRESS, help=f"HOST:PORT that must stay reachable (default {DEFAULT_EGRESS})")
    commands.add_parser("remove", help="undo install")
    args = parser.parse_args(argv)
    system = system or System()
    if args.command == "install":
        name, uid, _ = resolve_user(user=args.user) if args.user is not None else resolve_user(uid=args.uid)
        result = install(system, name, uid)
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
