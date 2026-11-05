"""The metadata egress floor tool, with every nft, systemctl and visudo call stubbed under a temporary root."""
import contextlib
import io
import json
import os
from pathlib import Path
import pwd
import socket
import subprocess
import sys
import tempfile
import unittest

from support import load_source

floor = load_source(".agents/tools/metadata-egress-floor.py", "metadata_egress_floor")
UID = os.getuid() or 1001
NAME = pwd.getpwuid(UID).pw_name
NFT = "/usr/sbin/nft"
UBUNTU_CONF = '#!/usr/sbin/nft -f\n\nflush ruleset\n\ntable inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter;\n\t}\n}\n'


class FakeSystem(floor.System):
    """Records commands instead of running them; files land under a temporary root."""

    def __init__(self, root, replies=None):
        super().__init__(root)
        self.calls = []
        self.replies = {("systemctl", "is-enabled", "nftables.service"): (0, "enabled\n"), **(replies or {})}

    def run(self, argv, *, input=None, timeout=60):
        self.calls.append(list(argv))
        for prefix, reply in sorted(self.replies.items(), key=lambda item: -len(item[0])):
            if tuple(argv[:len(prefix)]) == prefix:
                code, stdout = reply(argv) if callable(reply) else reply
                return subprocess.CompletedProcess(argv, code, stdout, "stubbed failure" if code else "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def nft(self):
        return NFT

    def require_root(self):
        pass


def nft_listing(uid=1001, skuid=None, l4proto="tcp", verdicts=None, extra=(), hook="output", dependency=True):
    """A `nft -j list table` reply shaped like libnftables JSON."""
    rules = []
    for family, address in (("ip", floor.METADATA_V4), ("ip6", floor.METADATA_V6)):
        for tcp in (True, False):
            expressions = [{"match": {"op": "==", "left": {"meta": {"key": "skuid"}}, "right": uid if skuid is None else skuid}}]
            if dependency:
                expressions.append({"match": {"op": "==", "left": {"meta": {"key": "nfproto"}}, "right": "ipv4" if family == "ip" else "ipv6"}})
            expressions.append({"match": {"op": "==", "left": {"payload": {"protocol": family, "field": "daddr"}}, "right": address}})
            if tcp:
                expressions.append({"match": {"op": "==", "left": {"meta": {"key": "l4proto"}}, "right": l4proto}})
            reject = {"type": "tcp reset"} if tcp else {"type": "icmpx", "expr": "admin-prohibited"}
            expressions.append((verdicts or {}).get((family, tcp), {"reject": reject}))
            rules.append({"rule": {"family": "inet", "table": floor.TABLE, "chain": "output", "handle": len(rules) + 2, "expr": expressions}})
    return json.dumps({"nftables": [
        {"metainfo": {"version": "1.0.9", "json_schema_version": 1}},
        {"table": {"family": "inet", "name": floor.TABLE, "handle": 7}},
        {"chain": {"family": "inet", "table": floor.TABLE, "name": "output", "handle": 1, "type": "filter",
                   "hook": hook, "prio": 0, "policy": "accept"}},
        *rules, *extra]})


class Generated(unittest.TestCase):
    def test_rejects_only_the_metadata_addresses_for_one_uid(self):
        text = floor.rules(1001)
        self.assertEqual([line.strip() for line in text.splitlines() if "reject" in line], [
            "meta skuid 1001 ip daddr 169.254.169.254 meta l4proto tcp reject with tcp reset",
            "meta skuid 1001 ip daddr 169.254.169.254 reject with icmpx admin-prohibited",
            "meta skuid 1001 ip6 daddr fe80::a9fe:a9fe meta l4proto tcp reject with tcp reset",
            "meta skuid 1001 ip6 daddr fe80::a9fe:a9fe reject with icmpx admin-prohibited",
        ])
        self.assertNotIn("drop", text)
        self.assertNotIn("169.254.0.0", text)
        statements = [line for line in text.splitlines() if line.startswith(("table", "delete", "flush"))]
        self.assertEqual(statements, ["table inet agent_interface_metadata {}", "delete table inet agent_interface_metadata",
                                      "table inet agent_interface_metadata {"])
        self.assertIn("type filter hook output priority filter; policy accept;", text)
        self.assertEqual(floor.installed_uid(text), 1001)
        for uid in (0, -1, True, "1001"):
            with self.subTest(uid=uid), self.assertRaises(ValueError):
                floor.rules(uid)

    def test_boot_unit_reloads_without_following_nftables_and_refuses_manual_stop(self):
        text = floor.unit(NFT)
        self.assertIn("ExecStart=/usr/sbin/nft -f /etc/nftables.d/agent-interface-metadata.nft\n", text)
        self.assertIn("ExecReload=/usr/sbin/nft -f /etc/nftables.d/agent-interface-metadata.nft\n", text)
        self.assertIn("RemainAfterExit=yes\n", text)
        self.assertIn("RefuseManualStop=yes\n", text)
        self.assertIn("After=network.target nftables.service ufw.service\n", text)
        # Following nftables.service would carry its stop or restart into the household services.
        self.assertNotIn("PartOf=", text)
        self.assertNotIn("ReloadPropagatedFrom=", text)

    def test_user_manager_fails_closed_without_the_floor(self):
        self.assertEqual(str(floor.dropin(1001)), "/etc/systemd/system/user@1001.service.d/agent-interface-metadata-floor.conf")
        lines = floor.user_dropin().splitlines()
        self.assertIn("Requires=agent-interface-metadata-floor.service", lines)
        self.assertIn("After=agent-interface-metadata-floor.service", lines)

    def test_sudo_rule_allows_only_listing_this_table(self):
        self.assertEqual(floor.sudoers("nicolas", NFT).splitlines()[-1],
                         "nicolas ALL=(root) NOPASSWD: /usr/sbin/nft -j list table inet agent_interface_metadata")

    def test_include_goes_last_after_the_flush_and_round_trips(self):
        included = floor.with_include(UBUNTU_CONF)
        self.assertTrue(included.startswith(UBUNTU_CONF))
        self.assertTrue(included.endswith('include "/etc/nftables.d/agent-interface-metadata.nft"\n# END agent-interface metadata egress floor\n'))
        self.assertLess(included.index("flush ruleset"), included.index("include "))
        self.assertEqual(floor.with_include(included), included)
        self.assertEqual(floor.without_include(included), UBUNTU_CONF)
        # Text added after the block moves the block back to the end.
        appended = included + "table inet late { }\n"
        self.assertTrue(floor.with_include(appended).endswith(floor.with_include("")[1:]))
        self.assertEqual(floor.with_include(appended).count("BEGIN agent-interface"), 1)


class Install(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.system = FakeSystem(self.root)
        self.conf().parent.mkdir(parents=True)
        self.conf().write_text(UBUNTU_CONF)
        self.conf().chmod(0o755)

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, absolute):
        return self.root / Path(absolute).relative_to("/")

    def conf(self):
        return self.file(floor.NFTABLES_CONF)

    def systemctl(self):
        return [call[1:] for call in self.system.calls if call[0] == "systemctl" and call[1] != "is-enabled"]

    def test_fresh_install_writes_validates_and_loads_every_piece(self):
        result = floor.install(self.system, "nicolas", 1001)
        self.assertEqual(self.file(floor.RULES).read_text(), floor.rules(1001))
        self.assertEqual(self.file(floor.UNIT_FILE).read_text(), floor.unit(NFT))
        self.assertEqual(self.file(floor.dropin(1001)).read_text(), floor.user_dropin())
        self.assertEqual(self.file(floor.SUDOERS).read_text(), floor.sudoers("nicolas", NFT))
        self.assertEqual(self.file(floor.SUDOERS).stat().st_mode & 0o777, 0o440)
        self.assertEqual(self.conf().read_text(), floor.with_include(UBUNTU_CONF))
        self.assertEqual(self.conf().stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.file(floor.CONF_BACKUP).read_text(), UBUNTU_CONF)
        # The rules alone, then the whole conf with its flush, are checked before either goes live.
        self.assertIn([NFT, "-c", "-f", "/etc/nftables.d/agent-interface-metadata.nft.check"], self.system.calls)
        self.assertIn([NFT, "-c", "-f", "/etc/nftables.conf.check"], self.system.calls)
        self.assertIn(["visudo", "-c", "-f", "/etc/sudoers.d/agent-interface-metadata-floor.check"], self.system.calls)
        self.assertEqual(self.systemctl(), [["daemon-reload"], ["enable", floor.UNIT], ["start", floor.UNIT], ["reload", floor.UNIT]])
        self.assertEqual(result["mode"], {"nftablesService": "enabled", "nftablesConfInclude": True,
                                          "persistence": "nftables.conf include and boot unit"})
        self.assertFalse(any("flush" in part for call in self.system.calls for part in call))
        self.assertFalse(list(self.root.rglob("*.check")))

    def test_rerunning_changes_no_file_and_only_reapplies_the_table(self):
        floor.install(self.system, "nicolas", 1001)
        self.file(floor.CONF_BACKUP).write_text("first backup")
        self.system.calls.clear()
        result = floor.install(self.system, "nicolas", 1001)
        self.assertEqual((result["changedFiles"], result["previousUid"]), ([], 1001))
        self.assertEqual(self.systemctl(), [["enable", floor.UNIT], ["start", floor.UNIT], ["reload", floor.UNIT]])
        self.assertEqual(self.file(floor.CONF_BACKUP).read_text(), "first backup")
        self.assertFalse(any(call[1:2] == ["restart"] for call in self.system.calls))

    def test_without_nftables_conf_the_boot_unit_alone_persists_it(self):
        self.conf().unlink()
        self.system.replies[("systemctl", "is-enabled", "nftables.service")] = (1, "not-found\n")
        result = floor.install(self.system, "nicolas", 1001)
        self.assertEqual(result["mode"]["persistence"], "boot unit only")
        self.assertFalse(self.conf().exists() or self.file(floor.CONF_BACKUP).exists())

    def test_refuses_an_enabled_nftables_service_without_its_conf(self):
        self.conf().unlink()
        with self.assertRaisesRegex(SystemExit, "nftables.service is enabled but /etc/nftables.conf is missing"):
            floor.install(self.system, "nicolas", 1001)

    def test_a_conf_that_fails_validation_is_left_untouched(self):
        self.system.replies[(NFT, "-c", "-f", "/etc/nftables.conf.check")] = (1, "")
        with self.assertRaisesRegex(SystemExit, "Checking /etc/nftables.conf with the include failed"):
            floor.install(self.system, "nicolas", 1001)
        self.assertEqual(self.conf().read_text(), UBUNTU_CONF)
        self.assertFalse(self.file(floor.CONF_BACKUP).exists() or self.file(floor.UNIT_FILE).exists())

    def test_rules_this_nft_rejects_change_nothing(self):
        self.system.replies[(NFT, "-c")] = (1, "")
        with self.assertRaisesRegex(SystemExit, "Checking the generated rules failed"):
            floor.install(self.system, "nicolas", 1001)
        self.assertFalse(self.file(floor.RULES).exists())
        self.assertEqual(self.conf().read_text(), UBUNTU_CONF)

    def test_a_new_uid_moves_the_user_manager_requirement(self):
        floor.install(self.system, "nicolas", 1001)
        result = floor.install(self.system, "other", 1002)
        self.assertEqual(result["previousUid"], 1001)
        self.assertEqual(floor.installed_uid(self.file(floor.RULES).read_text()), 1002)
        self.assertFalse(self.file(floor.dropin(1001)).exists())
        self.assertTrue(self.file(floor.dropin(1002)).exists())

    def test_cli_refuses_root_before_touching_the_host(self):
        for argv in (["install", "--uid", "0"], ["install", "--user", "root"]):
            with self.subTest(argv=argv), self.assertRaisesRegex(SystemExit, "Refusing uid 0"):
                floor.main(argv, self.system)
        self.assertEqual(self.system.calls, [])
        self.assertFalse(self.file(floor.RULES).exists())

    def test_cli_installs_for_a_named_account(self):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(floor.main(["install", "--user", NAME], self.system), 0)
        self.assertEqual(json.loads(output.getvalue())["uid"], UID)

    def test_remove_drops_the_requirement_first_and_never_stops_anything(self):
        floor.install(self.system, "nicolas", 1001)
        self.system.calls.clear()
        result = floor.remove(self.system)
        self.assertTrue(result["tableDeleted"])
        self.assertEqual(self.systemctl()[:2], [["daemon-reload"], ["disable", floor.UNIT]])
        self.assertFalse(any(call[1:2] in (["stop"], ["restart"]) or "--now" in call for call in self.system.calls))
        self.assertIn([NFT, "delete", "table", "inet", floor.TABLE], self.system.calls)
        self.assertEqual(self.conf().read_text(), UBUNTU_CONF)
        for path in (floor.RULES, floor.UNIT_FILE, floor.dropin(1001), floor.SUDOERS):
            self.assertFalse(self.file(path).exists(), path)


def attempt(outcome, ms=2):
    return {"outcome": outcome, "ms": ms}


def passing_probe(**overrides):
    return {"metadataV4": attempt("ECONNREFUSED"), "metadataV6": {"ens3": attempt("ECONNREFUSED", 1)},
            "dns": {"outcome": "resolved", "addresses": ["140.82.112.3"]}, "egress": attempt("connected", 30),
            "passwordlessSudo": False, **overrides}


class Verdicts(unittest.TestCase):
    def test_only_a_fast_explicit_refusal_proves_the_floor(self):
        for outcome, ms, expected in (("ECONNREFUSED", 2, "refused"), ("EACCES", 1, "refused"), ("EPERM", 0, "refused"),
                                      ("EHOSTUNREACH", 40, "refused"), ("EHOSTUNREACH", 3000, "inconclusive"),
                                      ("ECONNREFUSED", 1500, "inconclusive"), ("timeout", 3000, "inconclusive"),
                                      ("EMFILE", 0, "inconclusive"), ("connected", 3, "connected"), ("ENETUNREACH", 0, "no-route")):
            with self.subTest(outcome=outcome, ms=ms):
                self.assertEqual(floor.verdict(attempt(outcome, ms)), expected)

    def test_ipv4_needs_a_refusal_and_each_link_local_interface_a_refusal_or_no_route(self):
        self.assertEqual(floor.probe_problems(passing_probe()), [])
        self.assertEqual(floor.probe_problems(passing_probe(metadataV6={})), [])
        self.assertEqual(floor.probe_problems(passing_probe(metadataV6={"ens3": attempt("ECONNREFUSED"), "ens4": attempt("ENETUNREACH")})), [])
        for v4 in ("timeout", "EMFILE", "connected", "ENETUNREACH"):
            with self.subTest(v4=v4):
                [problem] = floor.probe_problems(passing_probe(metadataV4=attempt(v4)))
                self.assertIn("169.254.169.254:80 was", problem)
        for v6 in ("timeout", "EMFILE", "connected", "ENODEV-ish"):
            with self.subTest(v6=v6):
                [problem] = floor.probe_problems(passing_probe(metadataV6={"ens3": attempt("ECONNREFUSED"), "ens4": attempt(v6)}))
                self.assertIn("fe80::a9fe:a9fe%ens4", problem)

    def test_live_rules_must_match_uid_addresses_hook_and_verdicts(self):
        self.assertEqual(floor.live_rule_problems(nft_listing(), 1001, "nicolas"), [])
        # nft may print the uid by name, the protocol by number, and hide the family dependency.
        self.assertEqual(floor.live_rule_problems(nft_listing(skuid="nicolas", l4proto=6, dependency=False), 1001, "nicolas"), [])
        broken = {
            "another uid": nft_listing(uid=1002),
            "a drop verdict": nft_listing(verdicts={("ip", True): {"drop": None}}),
            "a weaker reject": nft_listing(verdicts={("ip6", False): {"reject": {"type": "icmpx", "expr": "port-unreachable"}}}),
            "an extra rule": nft_listing(extra=[{"rule": {"chain": "output", "expr": [{"accept": None}]}}]),
            "the input hook": nft_listing(hook="input"),
        }
        for label, listing in broken.items():
            with self.subTest(label):
                self.assertNotEqual(floor.live_rule_problems(listing, 1001, "nicolas"), [])
        missing = json.loads(nft_listing())
        missing["nftables"].pop()
        self.assertNotEqual(floor.live_rule_problems(json.dumps(missing), 1001, "nicolas"), [])
        self.assertEqual(floor.live_rule_problems(None, 1001, "nicolas"), ["The live table could not be listed as nft JSON."])

    def test_user_manager_must_both_require_and_follow_the_floor(self):
        self.assertTrue(floor.requires_floor(f"Requires=user-runtime-dir@1001.service {floor.UNIT}\nAfter=systemd-user-sessions.service {floor.UNIT}\n"))
        self.assertFalse(floor.requires_floor(f"Requires=user-runtime-dir@1001.service\nAfter={floor.UNIT}\n"))
        self.assertFalse(floor.requires_floor(""))


class Check(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "etc").mkdir()
        (self.root / "etc/nftables.conf").write_text(UBUNTU_CONF)
        (self.root / "proc/net").mkdir(parents=True)
        self.probes = []
        self.sudo = (1, "")
        self.reported = passing_probe()
        def setpriv(argv):
            if argv[-3:] == ["sudo", "-n", "true"]:
                return self.sudo
            self.probes.append(json.loads(argv[-1]))
            return 0, json.dumps({key: value for key, value in self.reported.items() if key != "passwordlessSudo"})
        self.system = FakeSystem(self.root, {
            ("setpriv",): setpriv, ("systemctl", "is-enabled", floor.UNIT): (0, "enabled\n"),
            ("systemctl", "is-active", floor.UNIT): (0, "active\n"),
            ("systemctl", "show", f"user@{UID}.service"): (0, f"Requires=user-runtime-dir@{UID}.service {floor.UNIT}\nAfter={floor.UNIT}\n"),
            (NFT, "-j", "list"): (0, nft_listing(uid=UID))})
        floor.install(self.system, NAME, UID)

    def tearDown(self):
        self.temporary.cleanup()

    def test_a_working_floor_passes_and_reports_its_mode(self):
        result = floor.check(self.system)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["mode"]["persistence"], "nftables.conf include and boot unit")
        self.assertEqual(result["warnings"], [])
        [sent] = self.probes
        self.assertEqual((sent["v4"], sent["v6"], sent["port"], sent["egress"]), ("169.254.169.254", "fe80::a9fe:a9fe", 80, ["github.com", 443]))
        gid = pwd.getpwuid(UID).pw_gid
        self.assertTrue(all(call[1:3] == [f"--reuid={UID}", f"--regid={gid}"] for call in self.system.calls if call[0] == "setpriv"))

    def failing(self):
        return sorted(name for name, passed in floor.check(self.system)["checks"].items() if not passed)

    def test_each_broken_piece_fails_its_own_check(self):
        self.reported = passing_probe(metadataV4=attempt("timeout", 3000))
        self.assertEqual(self.failing(), ["metadataRefused"])
        self.reported = passing_probe(egress=attempt("ETIMEDOUT", 10000))
        self.assertEqual(self.failing(), ["egressConnects"])
        self.reported = passing_probe()
        self.system.replies[(NFT, "-j", "list")] = (1, "")
        self.assertEqual(self.failing(), ["liveRulesMatch"])
        self.system.replies[(NFT, "-j", "list")] = (0, nft_listing(uid=UID))
        self.system.replies[("systemctl", "is-active", floor.UNIT)] = (3, "inactive\n")
        self.system.replies[("systemctl", "show", f"user@{UID}.service")] = (0, "Requires=\nAfter=\n")
        self.assertEqual(self.failing(), ["unitActive", "userManagerRequiresFloor"])
        self.system.replies[("systemctl", "is-active", floor.UNIT)] = (0, "active\n")
        self.system.replies[("systemctl", "show", f"user@{UID}.service")] = (0, f"Requires={floor.UNIT}\nAfter={floor.UNIT}\n")
        (self.root / "etc/nftables.conf").write_text(UBUNTU_CONF)
        self.assertEqual(self.failing(), ["nftablesConfIncludesFloor"])

    def test_warns_when_the_service_user_has_passwordless_sudo(self):
        self.sudo = (0, "")
        [warning] = floor.check(self.system)["warnings"]
        self.assertIn("sudo without a password", warning)

    def test_refuses_for_another_account(self):
        floor.install(self.system, "daemon", 1)
        with self.assertRaisesRegex(SystemExit, "Reinstall with --user"):
            floor.check(self.system, user=NAME)


class ProbeProgram(unittest.TestCase):
    """The probe source the tool runs as the service user, executed for real against loopback."""

    def test_reports_connected_refused_and_resolution_outcomes(self):
        with tempfile.TemporaryDirectory() as directory:
            interfaces = Path(directory) / "if_inet6"
            interfaces.write_text("00000000000000000000000000000001 01 80 10 80       lo\n"
                                  "fe80000000000000f8163efffe000001 02 40 20 80     ens3\n"
                                  "20010db8000000000000000000000001 02 40 00 00     ens3\n"
                                  "fe80000000000000000000000000beef 05 40 20 80      wg0\n")
            namespace = {}
            exec(floor.PROBE_FUNCTIONS, namespace)
            self.assertEqual(namespace["floor_link_local_interfaces"](str(interfaces)), ["ens3", "wg0"])
            self.assertEqual(namespace["floor_link_local_interfaces"](str(interfaces) + ".missing"), [])
            with socket.socket() as listening, socket.socket() as closed:
                listening.bind(("127.0.0.1", 0)); listening.listen()
                closed.bind(("127.0.0.1", 0))
                open_port, closed_port = listening.getsockname()[1], closed.getsockname()[1]
                closed.close()
                payload = {"v4": "127.0.0.1", "v6": "::1", "port": closed_port, "timeout": 2,
                           "interfaces": str(interfaces) + ".missing", "egress": ["127.0.0.1", open_port]}
                done = subprocess.run([sys.executable, "-I", "-c", floor.PROBE_SOURCE, json.dumps(payload)],
                                      capture_output=True, text=True, timeout=30, check=True)
        result = json.loads(done.stdout)
        self.assertEqual(result["metadataV4"]["outcome"], "ECONNREFUSED")
        self.assertEqual(floor.verdict(result["metadataV4"]), "refused")
        self.assertEqual(result["metadataV6"], {})
        self.assertEqual((result["dns"]["outcome"], result["egress"]["outcome"]), ("resolved", "connected"))


if __name__ == "__main__":
    unittest.main()
