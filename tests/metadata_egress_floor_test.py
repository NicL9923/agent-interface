"""The metadata egress floor tool, with every nft and systemctl call stubbed under a temporary root."""
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


class FakeSystem(floor.System):
    """Records commands instead of running them; files land under a temporary root."""

    def __init__(self, root, replies=None):
        super().__init__(root)
        self.calls = []
        self.replies = replies or {}

    def run(self, argv, *, input=None, timeout=60):
        self.calls.append(list(argv))
        for prefix, reply in self.replies.items():
            if tuple(argv[:len(prefix)]) == prefix:
                code, stdout = reply(argv) if callable(reply) else reply
                return subprocess.CompletedProcess(argv, code, stdout, "stubbed failure" if code else "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    def nft(self):
        return "/usr/sbin/nft"

    def require_root(self):
        pass

    def nft_calls(self):
        return [call for call in self.calls if call[0] == "/usr/sbin/nft"]


class Rules(unittest.TestCase):
    def test_rejects_only_the_metadata_addresses_for_one_uid(self):
        text = floor.rules(1001)
        rule_lines = [line.strip() for line in text.splitlines() if "reject" in line]
        self.assertEqual(rule_lines, [
            "meta skuid 1001 ip daddr 169.254.169.254 meta l4proto tcp reject with tcp reset",
            "meta skuid 1001 ip daddr 169.254.169.254 reject with icmpx admin-prohibited",
            "meta skuid 1001 ip6 daddr fe80::a9fe:a9fe meta l4proto tcp reject with tcp reset",
            "meta skuid 1001 ip6 daddr fe80::a9fe:a9fe reject with icmpx admin-prohibited",
        ])
        self.assertNotIn("drop", text)
        self.assertNotIn("169.254.0.0", text)
        # Every statement outside comments names only this table; nothing flushes the ruleset.
        statements = [line for line in text.splitlines() if line.startswith(("table", "delete", "flush"))]
        self.assertEqual(statements, ["table inet agent_interface_metadata {}", "delete table inet agent_interface_metadata",
                                      "table inet agent_interface_metadata {"])
        self.assertIn("type filter hook output priority filter; policy accept;", text)
        self.assertEqual(floor.installed_uid(text), 1001)

    def test_refuses_root_or_malformed_uids(self):
        for uid in (0, -1, True, "1001"):
            with self.subTest(uid=uid), self.assertRaises(ValueError):
                floor.rules(uid)

    def test_unit_loads_only_the_rules_file_after_the_firewalls_and_before_the_user(self):
        text = floor.unit(1001, "/usr/sbin/nft")
        self.assertIn("ExecStart=/usr/sbin/nft -f /etc/agent-interface/metadata-egress-floor.nft\n", text)
        self.assertIn("After=network.target nftables.service ufw.service\n", text)
        self.assertIn("Before=user@1001.service\n", text)
        self.assertIn("WantedBy=multi-user.target\n", text)
        self.assertNotIn("flush", text.split("[Service]")[1])

    def test_an_unrecognized_rules_file_has_no_uid(self):
        self.assertIsNone(floor.installed_uid(None))
        self.assertIsNone(floor.installed_uid("table inet other {}"))
        self.assertIsNone(floor.installed_uid(floor.rules(1001) + floor.rules(1002)))


class Install(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.system = FakeSystem(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, absolute):
        return self.root / Path(absolute).relative_to("/")

    def test_fresh_install_validates_writes_and_loads(self):
        result = floor.install(self.system, 1001)
        self.assertEqual(result["changedFiles"], [str(floor.RULES), str(floor.UNIT_FILE)])
        self.assertIsNone(result["previousUid"])
        self.assertEqual(self.file(floor.RULES).read_text(), floor.rules(1001))
        self.assertEqual(self.file(floor.RULES).stat().st_mode & 0o777, 0o644)
        self.assertEqual(self.file(floor.UNIT_FILE).read_text(), floor.unit(1001, "/usr/sbin/nft"))
        self.assertEqual(self.system.calls, [
            ["/usr/sbin/nft", "-c", "-f", str(floor.RULES) + ".check"],
            ["systemctl", "daemon-reload"],
            ["systemctl", "enable", floor.UNIT],
            ["systemctl", "restart", floor.UNIT],
        ])
        self.assertFalse(self.file(str(floor.RULES) + ".check").exists())

    def test_rerunning_changes_no_file_and_only_reapplies_the_table(self):
        floor.install(self.system, 1001)
        self.system.calls.clear()
        result = floor.install(self.system, 1001)
        self.assertEqual((result["changedFiles"], result["previousUid"]), ([], 1001))
        self.assertNotIn(["systemctl", "daemon-reload"], self.system.calls)
        self.assertEqual(self.system.calls[-2:], [["systemctl", "enable", floor.UNIT], ["systemctl", "restart", floor.UNIT]])

    def test_a_new_uid_replaces_the_rules_and_the_unit_ordering(self):
        floor.install(self.system, 1001)
        result = floor.install(self.system, 1002)
        self.assertEqual(result["previousUid"], 1001)
        self.assertEqual(floor.installed_uid(self.file(floor.RULES).read_text()), 1002)
        self.assertIn("Before=user@1002.service", self.file(floor.UNIT_FILE).read_text())

    def test_rules_this_nft_rejects_change_nothing(self):
        system = FakeSystem(self.root, {("/usr/sbin/nft", "-c"): (1, "")})
        with self.assertRaisesRegex(SystemExit, "Checking the generated rules failed"):
            floor.install(system, 1001)
        self.assertFalse(self.file(floor.RULES).exists())
        self.assertFalse(self.file(floor.UNIT_FILE).exists())
        self.assertEqual(len(system.calls), 1)

    def test_cli_refuses_root_before_touching_the_host(self):
        for argv in (["install", "--uid", "0"], ["install", "--user", "root"]):
            with self.subTest(argv=argv), self.assertRaisesRegex(SystemExit, "Refusing uid 0"):
                floor.main(argv, self.system)
        self.assertEqual(self.system.calls, [])
        self.assertFalse(self.file(floor.RULES).exists())

    def test_cli_installs_for_a_named_account(self):
        name = pwd.getpwuid(UID).pw_name
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(floor.main(["install", "--user", name], self.system), 0)
        self.assertEqual(json.loads(output.getvalue())["uid"], UID)
        self.assertEqual(floor.installed_uid(self.file(floor.RULES).read_text()), UID)

    def test_remove_deletes_only_this_table_and_its_files(self):
        floor.install(self.system, 1001)
        self.system.calls.clear()
        result = floor.remove(self.system)
        self.assertTrue(result["tableDeleted"])
        self.assertFalse(self.file(floor.RULES).exists() or self.file(floor.UNIT_FILE).exists())
        self.assertEqual(self.system.calls, [
            ["systemctl", "disable", "--now", floor.UNIT],
            ["systemctl", "daemon-reload"],
            ["/usr/sbin/nft", "list", "table", "inet", "agent_interface_metadata"],
            ["/usr/sbin/nft", "delete", "table", "inet", "agent_interface_metadata"],
        ])
        # Removing again is harmless: no unit to disable and no table to delete.
        self.system.replies[("/usr/sbin/nft", "list")] = (1, "")
        self.system.calls.clear()
        self.assertFalse(floor.remove(self.system)["tableDeleted"])
        self.assertEqual(self.system.calls, [["/usr/sbin/nft", "list", "table", "inet", "agent_interface_metadata"]])


def passing_probe(**overrides):
    return {"metadataV4": {"outcome": "ECONNREFUSED", "ms": 2}, "metadataV6": {"outcome": "ECONNREFUSED", "ms": 1},
            "dns": {"outcome": "resolved", "addresses": ["140.82.112.3"]}, "egress": {"outcome": "connected", "ms": 30},
            "passwordlessSudo": False, **overrides}


class Check(unittest.TestCase):
    def state(self, **overrides):
        return {"uid": 1001, "rules": floor.rules(1001), "enabled": "enabled", "active": "active", "tableLoaded": True,
                "probe": passing_probe(), **overrides}

    def failing(self, **overrides):
        return sorted(name for name, passed in floor.evaluate(self.state(**overrides)).items() if not passed)

    def test_a_working_floor_passes_every_check(self):
        self.assertEqual(self.failing(), [])
        # Link-local IPv6 may not route at all; an unreachable or absent probe still passes.
        self.assertEqual(self.failing(probe=passing_probe(metadataV6={"outcome": "timeout", "ms": 3000})), [])
        self.assertEqual(self.failing(probe={k: v for k, v in passing_probe().items() if k != "metadataV6"}), [])

    def test_reachable_slow_or_silent_metadata_fails(self):
        for outcome, ms in (("connected", 3), ("timeout", 3000), ("ECONNREFUSED", 2500)):
            with self.subTest(outcome=outcome, ms=ms):
                self.assertEqual(self.failing(probe=passing_probe(metadataV4={"outcome": outcome, "ms": ms})), ["metadataV4RefusedQuickly"])
        self.assertEqual(self.failing(probe=passing_probe(metadataV6={"outcome": "connected", "ms": 4})), ["metadataV6Unreachable"])

    def test_broken_ordinary_egress_or_persistence_fails(self):
        self.assertEqual(self.failing(probe=passing_probe(egress={"outcome": "ETIMEDOUT", "ms": 10000})), ["egressConnects"])
        self.assertEqual(self.failing(probe=passing_probe(dns={"outcome": "failed", "error": "x"})), ["dnsResolves"])
        self.assertEqual(self.failing(enabled="disabled", active="inactive", tableLoaded=False),
                         ["tableLoaded", "unitActive", "unitEnabled"])
        self.assertEqual(self.failing(rules=floor.rules(1001).replace("tcp reset", "icmpx port-unreachable")), ["rulesFileCurrent"])

    def test_check_probes_as_the_installed_uid_and_warns_about_passwordless_sudo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "proc/net").mkdir(parents=True)
            (root / "proc/net/route").write_text("Iface\tDestination\tGateway\nens3\t00000000\t0101A8C0\nens3\t0001A8C0\t00000000\n")
            probes = []
            def setpriv(argv):
                if argv[-3:] == ["sudo", "-n", "true"]:
                    return 0, ""
                probes.append(json.loads(argv[-1]))
                return 0, json.dumps(passing_probe())
            system = FakeSystem(root, {("setpriv",): setpriv, ("systemctl", "is-enabled"): (0, "enabled\n"),
                                       ("systemctl", "is-active"): (0, "active\n")})
            floor.install(system, UID)
            result = floor.check(system)
        self.assertTrue(result["ok"], result)
        self.assertEqual(probes, [{"targets": {"metadataV4": ["169.254.169.254", 80, 3], "metadataV6": ["fe80::a9fe:a9fe%ens3", 80, 3]},
                                   "egress": ["github.com", 443]}])
        self.assertTrue(all(call[1:3] == [f"--reuid={UID}", f"--regid={pwd.getpwuid(UID).pw_gid}"] for call in system.calls if call[0] == "setpriv"))
        self.assertEqual(len(result["warnings"]), 1)
        self.assertIn("sudo without a password", result["warnings"][0])

    def test_check_refuses_without_an_installed_floor_or_for_another_account(self):
        with tempfile.TemporaryDirectory() as directory:
            system = FakeSystem(Path(directory))
            with self.assertRaisesRegex(SystemExit, "not installed"):
                floor.check(system)
            floor.install(system, 1)  # uid 1 is daemon on Linux and macOS, never this test's user.
            with self.assertRaisesRegex(SystemExit, "Reinstall with --user"):
                floor.check(system, user=pwd.getpwuid(UID).pw_name)


class ProbeProgram(unittest.TestCase):
    """The probe source the tool runs as the service user, executed for real against loopback."""

    def test_reports_connected_refused_and_resolution_outcomes(self):
        with socket.socket() as listening, socket.socket() as closed:
            listening.bind(("127.0.0.1", 0)); listening.listen()
            closed.bind(("127.0.0.1", 0))
            open_port, closed_port = listening.getsockname()[1], closed.getsockname()[1]
            closed.close()
            payload = {"targets": {"open": ["127.0.0.1", open_port, 2], "closed": ["127.0.0.1", closed_port, 2]},
                       "egress": ["127.0.0.1", open_port]}
            done = subprocess.run([sys.executable, "-I", "-c", floor.PROBE_SOURCE, json.dumps(payload)],
                                  capture_output=True, text=True, timeout=30, check=True)
        result = json.loads(done.stdout)
        self.assertEqual(result["open"]["outcome"], "connected")
        self.assertEqual(result["closed"]["outcome"], "ECONNREFUSED")
        self.assertLess(result["closed"]["ms"], floor.REFUSED_WITHIN_MS)
        self.assertEqual(result["dns"]["outcome"], "resolved")
        self.assertEqual(result["egress"]["outcome"], "connected")


if __name__ == "__main__":
    unittest.main()
