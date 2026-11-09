"""Release wrapper rules and host programs, against temporary directories only."""
import datetime
import hashlib
import json
import re
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

from support import load_source
import metadata_egress_floor_test as floor_fixtures

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".agents/tools"))
from deploy_common import Fence  # noqa: E402
release_app = load_source(".agents/tools/release-app.py", "release_app")
qualify_app = load_source(".agents/tools/qualify-app-release.py", "qualify_app")

FAKE_RECOVERY_HELPER = """
import json, sys
from pathlib import Path
def fingerprint(path):
    path = Path(path)
    return "link:" + str(path.readlink()) if path.is_symlink() else "file:" + path.name
if __name__ == "__main__":
    calls = Path(__file__).with_name("calls.json")
    calls.write_text(json.dumps([*(json.loads(calls.read_text()) if calls.exists() else []), sys.argv[1:]]))
    if Path(__file__).with_name("fail").exists():
        print("Recovery stopped for review. Private phase retained; native owners and admission were not replayed.")
        raise SystemExit(2)
    print(json.dumps({"checked": "--check" in sys.argv}))
"""


def run_remote(program, payload):
    """Execute a host program locally, exactly as the wrapper sends it over SSH."""
    done = subprocess.run(["python3", "-"], input=release_app.remote_source(program, payload), capture_output=True, text=True, check=False)
    return done.returncode, done.stdout.strip().splitlines()[-1] if done.stdout.strip() else "", done.stderr


def closed_probe(listing_uid=None):
    """The production probe aimed at a closed loopback port, with a fixture live-rule listing."""
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        port = unused.getsockname()[1]
    listing = floor_fixtures.nft_listing(uid=os.getuid() if listing_uid is None else listing_uid)
    return {**release_app.METADATA_PROBE, "v4": "127.0.0.1", "port": port, "interfaces": "/nonexistent/if_inet6",
            "unit": "agent-interface-test-absent.service", "liveRulesCommand": [sys.executable, "-c", f"print({listing!r})"]}


# A runtime directory whose `node` is this interpreter, so the fixture service's running process, this
# test process, is that binary by real path.
RUNTIME = Path(tempfile.mkdtemp(prefix="release-runtime-"))
(RUNTIME / "bin").mkdir()
(RUNTIME / "bin/node").symlink_to(sys.executable)
NODE = str(RUNTIME / "bin/node")
REAL_NODE = os.path.realpath(NODE)


def service_process(path):
    """A stand-in for the app service's live process: this interpreter, started with `path` as PATH."""
    process = subprocess.Popen([NODE, "-c", "import time; time.sleep(600)"], env={"PATH": path})
    PROCESSES.append(process)
    return process.pid


PROCESSES = []
SERVICE_PID = service_process(str(RUNTIME / "bin") + ":/usr/bin")


def tearDownModule():
    for process in PROCESSES:
        process.kill(); process.wait()


# A service wholly on /real/node, as REMOTE_FACTS reports it.
ON_NODE = {"running": "/real/node", "livePath": "/real/node", "execStart": "/real/node", "path": "/real/node", "pathFiles": []}


def service_show(pid=None, exec_start=NODE, path=str(RUNTIME / "bin") + ":/usr/bin", files=()):
    """`systemctl show` output for the app service: MainPID, ExecStart, Environment and EnvironmentFiles,
    in systemd's own format: one EnvironmentFiles line per file, and an entry with a space quoted."""
    entry = f"PATH={path}"
    return "\n".join([f"MainPID={SERVICE_PID if pid is None else pid}",
                      f"ExecStart={{ path={exec_start} ; argv[]={exec_start} src/server/index.ts ; ignore_errors=no }}",
                      f"Environment=HOME=/srv {f'\"{entry}\"' if ' ' in entry else entry} NODE_ENV=production",
                      *(f"EnvironmentFiles={file}" for file in files)])


def facts_payload(base, probe=None, shown=None):
    """REMOTE_FACTS's payload, with the app service answered by a fixture command."""
    return {"appBase": str(base), "metadataProbe": probe or closed_probe(),
            "serviceCommand": [sys.executable, "-c", f"print({service_show() if shown is None else shown!r})"]}


def healthy_floor(**overrides):
    unit = release_app.FLOOR.UNIT
    return {"uid": 1001, "user": "nicolas", "enabled": "enabled", "active": "active",
            "userManager": f"Requires=user-runtime-dir@1001.service {unit}\nAfter={unit}\n",
            "listing": floor_fixtures.nft_listing(uid=1001),
            "probe": {"metadataV4": {"outcome": "ECONNREFUSED", "ms": 1}, "metadataV6": {"ens3": {"outcome": "ECONNREFUSED", "ms": 1}}},
            **overrides}

class QualificationBrowser(unittest.TestCase):
    def test_operator_qualification_persists_selection_in_private_receipt(self):
        # Real remote program, Git snapshots and shared selector. The runtime and
        # probes below are fixture commands, not evidence of native qualification.
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            release = base / 'releases/test'; (release / 'src/hermes').mkdir(parents=True)
            (release / 'src/shared').mkdir()
            (release / 'scripts/spike').mkdir(parents=True)
            (release / 'node_modules').mkdir()
            for name in ('qualification.py', 'private_fs.py'):
                shutil.copy2(ROOT / 'src/hermes' / name, release / 'src/hermes' / name)
            shutil.copy2(ROOT / 'scripts/hermes-upgrade-worker.py', release / 'scripts/hermes-upgrade-worker.py')
            (release / 'src/shared/qualification-inputs.json').write_text('["src/hermes/qualification.py"]')
            seen = base / 'browser-seen.json'
            (release / 'scripts/spike/run.py').write_text(f'''import json, os, pathlib
pathlib.Path({str(seen)!r}).write_text(json.dumps({{key: os.environ.get(key) for key in
    ('HERMES_COMPUTER_PROBE_BROWSER', 'AGENT_BROWSER_EXECUTABLE_PATH')}}))
''')
            (release / 'scripts/hermes-qualified-python.py').write_text('''import json, pathlib, shlex, sys
def fingerprint(python): return {"fixture": "runtime"}
if __name__ == "__main__":
    stage = pathlib.Path(sys.argv[sys.argv.index("--stage") + 1])
    launcher = stage / "qualified-python"
    launcher.write_text("#!/bin/sh\\nexec " + shlex.quote(sys.executable) + ' "$@"\\n'); launcher.chmod(0o700)
    print(json.dumps({"python": str(launcher), "fingerprint": fingerprint(launcher)}))
''')
            for name in ('package.json', 'package-lock.json', 'tsconfig.json'): (release / name).write_text('{}')
            source = base / 'live'; source.mkdir()
            (source / 'version').write_text('fixture')
            def git(*args):
                return subprocess.check_output(['git', '-C', str(source), *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-q'); git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
            revision = git('rev-parse', 'HEAD')
            home = base / 'home'; (home / 'tools/chromium').mkdir(parents=True)
            pm = home / 'tools/chromium/chrome'; pm.write_text('#!/bin/sh\n'); pm.chmod(0o700)
            (home / 'tools/facts.json').write_text(json.dumps({'packages': {'chromium': {'env': {
                'AGENT_BROWSER_EXECUTABLE_PATH': '{{store}}/chromium/chrome'}}}}))
            private = base / 'shared/upgrade-private'; private.mkdir(parents=True)
            (private / 'regressions.py').write_text('# Fixture host regressions\n')
            repair = base / 'repair.patch'; repair.write_bytes(b''); repair.chmod(0o600)
            (base / 'shared/hermes-worker.json').write_text(json.dumps(dict(source=str(source), managedHome=str(home),
                qualificationPython=sys.executable, managedLauncher='/fixture/launcher', approvedPatchFile=str(repair),
                requiredPatchSha256=hashlib.sha256(b'').hexdigest(), qualificationFiles=[])))
            browser = base / 'chrome'; browser.write_bytes(b'\x7fELFfixture'); browser.chmod(0o700)
            selected = base / 'selected'; selected.symlink_to(browser)
            ops = base / 'operations/test'; ops.mkdir(parents=True)
            archive = ops / 'release.tar.gz'; archive.write_bytes(b'fixture')
            payload = dict(appBase=str(base), release=str(release), operationDir=str(ops),
                archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest(), hermesRevision=revision,
                node=shutil.which('node'), computerProbeBrowser=str(selected))
            code, output, error = run_remote(qualify_app.REMOTE, payload)
            self.assertEqual(code, 0, error)
            result = json.loads(output)
            receipt_path = Path(result['receipt'])
            receipt = json.loads(receipt_path.read_text())
            descriptor = dict(requested=str(selected), executable=str(browser), sha256=hashlib.sha256(browser.read_bytes()).hexdigest())
            self.assertEqual(receipt['computerProbeBrowser'], descriptor)
            self.assertEqual(result['computerProbeBrowser'], descriptor)
            self.assertEqual(receipt_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(seen.read_text()), {'HERMES_COMPUTER_PROBE_BROWSER': str(browser),
                'AGENT_BROWSER_EXECUTABLE_PATH': str(pm)})
            # A recorded runtime whose directory holds no node would run the probes on whatever node
            # PATH finds next; qualification refuses before staging anything.
            (base / 'no-runtime/bin').mkdir(parents=True)
            stages = sorted(base.rglob('.agent-interface-upgrade-stage'))
            code, _, error = run_remote(qualify_app.REMOTE, {**payload, 'node': str(base / 'no-runtime/bin/node')})
            self.assertNotEqual(code, 0)
            self.assertIn('node on the qualification PATH is not ' + str(base / 'no-runtime/bin/node'), error)
            self.assertEqual(sorted(base.rglob('.agent-interface-upgrade-stage')), stages)
            # The runtime path no longer resolves to the binary the release was built with.
            code, _, error = run_remote(qualify_app.REMOTE, {**payload, 'nodeRealpath': str(base / 'elsewhere/node')})
            self.assertNotEqual(code, 0)
            self.assertIn(payload['node'] + ' is no longer the runtime the release was built with', error)
            self.assertEqual(sorted(base.rglob('.agent-interface-upgrade-stage')), stages)
            # Without an explicit choice, the live receipt's selection carries over and is bound afresh,
            # so a browser update since the last qualification is picked up rather than refused.
            live = base / 'shared/hermes-qualified.json'
            stale = dict(descriptor, sha256='0' * 64)
            live.write_text(json.dumps({'computerProbeBrowser': stale})); live.chmod(0o600)
            inherit = {**payload, 'computerProbeBrowser': None, 'inheritComputerProbeBrowser': True,
                       'liveQualificationReceipt': str(live)}
            code, output, error = run_remote(qualify_app.REMOTE, inherit)
            self.assertEqual(code, 0, error)
            self.assertEqual(json.loads(Path(json.loads(output)['receipt']).read_text())['computerProbeBrowser'], descriptor)
            self.assertEqual(json.loads(seen.read_text())['HERMES_COMPUTER_PROBE_BROWSER'], str(browser))
            # --pinned-probe-browser ignores the live selection and runs the release's PM Chromium.
            code, output, error = run_remote(qualify_app.REMOTE, {**inherit, 'inheritComputerProbeBrowser': False})
            self.assertEqual(code, 0, error)
            self.assertNotIn('computerProbeBrowser', json.loads(Path(json.loads(output)['receipt']).read_text()))
            self.assertIsNone(json.loads(seen.read_text())['HERMES_COMPUTER_PROBE_BROWSER'])
            # A live receipt that never selected one leaves the pinned browser in place.
            live.write_text(json.dumps({'revision': revision}))
            code, output, error = run_remote(qualify_app.REMOTE, inherit)
            self.assertEqual(code, 0, error)
            self.assertNotIn('computerProbeBrowser', json.loads(Path(json.loads(output)['receipt']).read_text()))
            # The live receipt picks an executable qualification runs, so each untrusted receipt or
            # selection refuses before staging rather than guessing a browser.
            stages = sorted(base.rglob('.agent-interface-upgrade-stage'))
            elsewhere = base / 'other-chrome'; elsewhere.write_bytes(b'\x7fELFother'); elsewhere.chmod(0o700)
            linked = base / 'linked-receipt.json'; linked.symlink_to(live)
            def refused(setup, reason, receipt=live):
                live.write_text(json.dumps({'computerProbeBrowser': stale})); live.chmod(0o600)
                setup()
                code, _, error = run_remote(qualify_app.REMOTE, {**inherit, 'liveQualificationReceipt': str(receipt)})
                self.assertNotEqual(code, 0)
                self.assertIn(reason, error)
                self.assertEqual(sorted(base.rglob('.agent-interface-upgrade-stage')), stages)
            refused(lambda: live.write_text(json.dumps({'computerProbeBrowser': {'requested': 'chrome'}})),
                    'malformed computer probe browser metadata')
            refused(lambda: live.chmod(0o666), 'must be owner-only and owned by this runtime')
            refused(lambda: None, 'Live qualification receipt is missing or a link', receipt=linked)
            refused(lambda: None, 'Live qualification receipt is missing or a link', receipt=base / 'absent.json')
            def retarget():
                selected.unlink(); selected.symlink_to(elsewhere)
            refused(retarget, 'resolved path changed since selection')

    def test_cli_forwards_host_path_without_resolving_it_on_operator_machine(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = dict(name="release-test", status="preparing", host="host", appBase="/srv/app")
            facts = {"prior": {"node": "/pm/node", "qualificationReceipt": "/srv/app/shared/hermes-qualified.json"}}
            remote = Mock(side_effect=[facts, {"qualificationComplete": True}])
            # The real release module, so qualification calls the same host_facts() prepare does.
            module = load_source(".agents/tools/release-app.py", "release_app_for_qualify")
            spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _: None))
            with patch.object(module, "remote", remote), patch.object(module, "load_manifest", lambda _: manifest), \
                    patch.object(module, "MANIFESTS", Path(directory)), \
                    patch.object(qualify_app.importlib.util, "spec_from_file_location", return_value=spec), \
                    patch.object(qualify_app.importlib.util, "module_from_spec", return_value=module):
                qualify_app.main(["release-test", "--computer-probe-browser", "/host-only/chrome"])
            facts_call, qualify_call = remote.call_args_list
            self.assertIs(facts_call.args[1], module.REMOTE_FACTS)
            # Every key REMOTE_FACTS reads from its payload must be supplied.
            read = set(re.findall(r'PAYLOAD\["(\w+)"\]', module.REMOTE_PRELUDE + module.REMOTE_FACTS))
            self.assertLessEqual(read, set(facts_call.args[2]))
            payload = qualify_call.args[2]
            self.assertEqual(payload["computerProbeBrowser"], "/host-only/chrome")
            self.assertFalse(payload["inheritComputerProbeBrowser"])
            self.assertEqual(payload["node"], "/pm/node")
            # A release prepared with --node qualifies with that runtime, not the last release's.
            manifest["node"] = "/srv/app/runtime/node-v24.22.2/bin/node"
            def qualify(*argv):
                remote.side_effect = [facts, {"qualificationComplete": True}]
                with patch.object(module, "remote", remote), patch.object(module, "load_manifest", lambda _: manifest), \
                        patch.object(module, "MANIFESTS", Path(directory)), \
                        patch.object(qualify_app.importlib.util, "spec_from_file_location", return_value=spec), \
                        patch.object(qualify_app.importlib.util, "module_from_spec", return_value=module):
                    qualify_app.main(["release-test", *argv])
                return remote.call_args_list[-1].args[2]
            payload = qualify()
            self.assertEqual(payload["node"], "/srv/app/runtime/node-v24.22.2/bin/node")
            # No browser flag reuses the live receipt's selection on the host.
            self.assertIsNone(payload["computerProbeBrowser"])
            self.assertTrue(payload["inheritComputerProbeBrowser"])
            self.assertEqual(payload["liveQualificationReceipt"], "/srv/app/shared/hermes-qualified.json")
            self.assertFalse(qualify("--pinned-probe-browser")["inheritComputerProbeBrowser"])
            with self.assertRaises(SystemExit), patch("sys.stderr"):
                qualify_app.main(["release-test", "--pinned-probe-browser", "--computer-probe-browser", "/host-only/chrome"])


class Host:
    """A minimal application directory shaped like the production layout."""

    def __init__(self, root):
        self.base = root / "app"
        self.home = root / "hermes"
        for path in ("operations", "releases/release-live", "shared/upgrade-state"):
            (self.base / path).mkdir(parents=True)
        self.home.mkdir()
        (self.base / "current").symlink_to(self.base / "releases/release-live")
        self.source = root / "source"
        self.source.mkdir()
        git = lambda *args: subprocess.run(["git", "-C", str(self.source), *args], check=True, capture_output=True)
        git("init", "-q"); (self.source / "auth.py").write_text("original\n"); git("add", ".")
        git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "base")
        (self.source / "auth.py").write_text("repaired\n")
        self.profile = self.home / "config.yaml"
        self.profile.write_text("model: default\n")
        # A native launcher that reports the store interpreter the way Hermes's does.
        self.interpreter = self.home / "tools/python-3.14.9/bin/python3"
        self.launcher = self.home / "launcher"
        self.launcher.write_text("#!/bin/sh\nprintf '%s' '" + json.dumps([str(self.interpreter), "-I", "-c", "pass"]) + "'\n")
        self.launcher.chmod(0o700)
        (self.base / "shared/hermes-worker.json").write_text(json.dumps({"appRoot": str(self.base / "releases/release-live"),
                                                                       "qualificationReceipt": "receipt", "managedLauncher": str(self.launcher)}))
        self.status({"phase": "idle", "maintenance": False})

    def status(self, value):
        (self.base / "shared/upgrade-state/status.json").write_text(json.dumps(value))

    def deployment(self, name, operation, succeeded, **extra):
        config = {"operationId": operation, "upgradeStateDir": str(self.base / "shared/upgrade-state"),
                  "maintenanceFile": str(self.home / "maintenance.json"), "hermesHome": str(self.home),
                  "profileHashes": {str(self.profile): "old"}, "source": str(self.source), **extra}
        (self.base / "operations" / name).mkdir()
        (self.base / "operations" / name / "deploy-config.json").write_text(json.dumps(config))
        if succeeded:
            (self.base / "operations" / f"continued-{operation}").mkdir()
            (self.base / "operations" / f"continued-{operation}" / "result.json").write_text("{}")
        return config


PRIOR = {
    "appBase": "/srv/app", "release": "/srv/app/releases/old", "expectedRelease": "/srv/app/releases/older",
    "operationId": "11111111-1111-4111-8111-111111111111", "webBuild": "aaaaaaaaaaaaaaaa",
    "node": "/srv/app/runtime/node", "qualificationReceipt": "/srv/app/shared/hermes-qualified.json",
    "newQualificationReceipt": "/srv/app/operations/old/qualification.json",
    "newWorkerConfig": {"appRoot": "/srv/app/releases/old", "qualificationReceipt": "/srv/app/shared/hermes-qualified.json"},
    "profileHashes": {"/home/config.yaml": "old"}, "fixedHelperSha256": "helper", "hermesRevision": "d23" * 13 + "d",
    "repairSha256": "repair", "discordConnections": ["discord"], "appOrigin": "https://app.example.test",
}


class ReleaseRules(unittest.TestCase):
    def config(self, **overrides):
        values = dict(release="/srv/app/releases/new", current="/srv/app/releases/old", operation="op-2",
                      web_build="bbbbbbbbbbbbbbbb", worker={"appRoot": "/srv/app/releases/old", "qualificationReceipt": "q", "live": True},
                      profile_hashes={"/home/config.yaml": "now", "/unrelated": "x"}, helper_sha="helper",
                      hermes_revision=PRIOR["hermesRevision"], repair_sha=PRIOR["repairSha256"])
        values.update(overrides)
        return release_app.derive_config(PRIOR, **values)

    def test_carries_settings_and_replaces_only_release_fields(self):
        config = self.config()
        changed = {key for key in PRIOR if config.get(key) != PRIOR[key]}
        self.assertEqual(changed, {"release", "expectedRelease", "operationId", "webBuild", "newWorkerConfig",
                                   "profileHashes", "newQualificationReceipt"})
        self.assertNotIn("newQualificationReceipt", config, "A previous release's fresh receipt is never reused")
        self.assertEqual(config["expectedRelease"], "/srv/app/releases/old")
        self.assertEqual(config["newWorkerConfig"], {"appRoot": "/srv/app/releases/new", "qualificationReceipt": "q", "live": True})
        self.assertEqual(config["profileHashes"], {"/home/config.yaml": "now"})

    def test_upgrade_hooks_run_the_new_release_helper(self):
        helper = "/srv/app/releases/integrations-recovery/scripts/hermes-upgrade-linux.py"
        hooks = {"backup": ["/py", helper, "--config", "/srv/app/shared/hermes-linux.json", "backup"],
                 "regressions": [["/py", helper, "regressions"], ["/py", "/srv/app/shared/upgrade-private/regressions.py"]]}
        config = self.config(worker={"appRoot": "/srv/app/releases/old", "hooks": hooks})
        new = "/srv/app/releases/new/scripts/hermes-upgrade-linux.py"
        self.assertEqual(config["newWorkerConfig"]["hooks"], {
            "backup": ["/py", new, "--config", "/srv/app/shared/hermes-linux.json", "backup"],
            "regressions": [["/py", new, "regressions"], ["/py", "/srv/app/shared/upgrade-private/regressions.py"]]})

    def test_installed_hermes_comes_from_live_state(self):
        config = self.config(hermes_revision="e" * 40, repair_sha="new-repair")
        self.assertEqual((config["hermesRevision"], config["repairSha256"]), ("e" * 40, "new-repair"))

    def test_the_launchers_current_interpreter_replaces_a_carried_one(self):
        # A Hermes update moved the store interpreter; the carried path would relaunch without input.
        prior = {**PRIOR, "managedPython": "/home/.hermes/tools/python-3.14.7/bin/python3"}
        config = release_app.derive_config(prior, release="/srv/app/releases/new", current="/srv/app/releases/old", operation="op",
                                           web_build="b" * 16, worker={"appRoot": "/srv/app/releases/old"},
                                           profile_hashes={"/home/config.yaml": "now"}, helper_sha="helper",
                                           hermes_revision=PRIOR["hermesRevision"], repair_sha=PRIOR["repairSha256"],
                                           managed_python="/home/.hermes/tools/python-3.14.9/bin/python3")
        self.assertEqual(config["managedPython"], "/home/.hermes/tools/python-3.14.9/bin/python3")

    def test_settled_update_phases_count_as_clear(self):
        clear = {"maintenance": False, "leasePresent": False, "drainPresent": False}
        for phase in ("idle", "succeeded", "rolled_back", "cancelled"):
            self.assertTrue(release_app.maintenance_clear({**clear, "phase": phase}), phase)
        self.assertFalse(release_app.maintenance_clear({**clear, "phase": "installing"}))
        self.assertFalse(release_app.maintenance_clear({**clear, "phase": "idle", "maintenance": True}))
        self.assertFalse(release_app.maintenance_clear({**clear, "phase": "idle", "drainPresent": True}))

    def test_a_chosen_runtime_replaces_the_carried_one(self):
        self.assertEqual(self.config()["node"], PRIOR["node"])
        self.assertEqual(self.config(node="/srv/app/runtime/node-v24.22.2/bin/node")["node"], "/srv/app/runtime/node-v24.22.2/bin/node")

    def test_supplied_qualification_is_activated_with_the_release(self):
        self.assertEqual(self.config(qualification="/srv/q.json")["newQualificationReceipt"], "/srv/q.json")

    def facts(self, **overrides):
        return {"prior": PRIOR, "serviceRuntime": ON_NODE, "maintenance": False, "leasePresent": False, "drainPresent": False,
                "upgradePhase": "idle", "managedPython": "/home/.hermes/tools/python/bin/python3",
                "metadataFloor": healthy_floor(), **overrides}

    def built(self, **overrides):
        return {"webBuild": "bbbbbbbbbbbbbbbb", "nodeVersion": "v24.22.2", "nodeRealpath": "/real/node", "helperSha256": "helper",
                "receipt": {"valid": True, "error": None}, **overrides}

    def problems(self, facts=None, built=None, **options):
        return release_app.preparation_problems(
            facts or self.facts(), built or self.built(),
            **{"local_web_build": "bbbbbbbbbbbbbbbb", "qualification": None, "accept_helper_change": False, **options})

    def test_ready_release_has_no_problems(self):
        self.assertEqual(self.problems(), [])

    def test_refuses_unsafe_or_mismatched_releases(self):
        self.assertIn("Maintenance is active", self.problems(self.facts(leasePresent=True))[0])
        self.assertIn("installing", self.problems(self.facts(upgradePhase="installing"))[0])
        self.assertIn("local build", self.problems(local_web_build="cccccccccccccccc")[0])
        stale = self.built(receipt={"valid": False, "error": "digest differs"})
        self.assertIn("--qualification", self.problems(built=stale)[0])
        self.assertIn("did not report an interpreter", self.problems(self.facts(managedPython=None))[0])
        self.assertNotIn("--qualification", self.problems(built=stale, qualification="/srv/q.json")[0])

    def test_refuses_a_runtime_outside_the_engines_or_not_the_one_the_service_runs(self):
        engines = "^24.22.2 || ^26.13.0"
        self.assertEqual(self.problems(engines=engines), [])
        stale = self.problems(built=self.built(nodeVersion="v24.21.0"), engines=engines)
        self.assertEqual(len(stale), 1)
        self.assertIn("Node v24.21.0, outside package.json's engines (^24.22.2 || ^26.13.0)", stale[0])
        # Built with a runtime the service is not wholly on: still running the old process, starting
        # the old binary, or finding another node on its PATH.
        for key, text in (("running", "its running process is /old/node"),
                          ("livePath", "the node on its running process's PATH is /old/node"),
                          ("execStart", "its ExecStart is /old/node"), ("path", "the node on its PATH is /old/node")):
            problems = self.problems(self.facts(serviceRuntime={**ON_NODE, key: "/old/node"}), engines=engines)
            self.assertEqual(len(problems), 1, key)
            self.assertIn(f"The app service does not run /real/node: {text}.", problems[0])
        self.assertIn("its running process is unknown", self.problems(self.facts(serviceRuntime={**ON_NODE, "running": None}))[0])
        # An environment file's PATH overrides the drop-in's at the next start, unseen by the check.
        overridden = self.problems(self.facts(serviceRuntime={**ON_NODE, "pathFiles": ["/srv/app.env"]}))
        self.assertEqual(len(overridden), 1)
        self.assertIn("does not run /real/node: its EnvironmentFile /srv/app.env sets PATH or cannot be read.", overridden[0])
        self.assertIn("does not run", self.problems(self.facts(serviceRuntime=None))[0])

    def test_node_must_be_an_absolute_path_to_a_binary_named_node(self):
        # npm and the build call `node` by name from the runtime's directory, so another name would
        # build with whatever node comes next on PATH.
        for path in ("/srv/app/runtime/bin/node24", "runtime/bin/node"):
            with patch.object(release_app, "git", lambda *_: self.fail("checked before any work")):
                with self.assertRaisesRegex(SystemExit, "--node must be an absolute host path to a binary named node"):
                    release_app.prepare(types.SimpleNamespace(node=path, commit="HEAD"))

    def test_engine_ranges_are_met_only_by_the_same_major_at_or_above_its_floor(self):
        engines = "^24.22.2 || ^26.13.0"
        for version, met in (("v24.22.2", True), ("v24.30.0", True), ("v26.13.0", True), ("24.22.2", True),
                             ("v24.21.0", False), ("v26.10.0", False), ("v25.0.0", False), ("v27.0.0", False),
                             ("v24.22", False), ("", False), (None, False)):
            self.assertEqual(release_app.satisfies_engines(version, engines), met, version)
        self.assertFalse(release_app.satisfies_engines("v24.22.2", ">=24"), "Only caret ranges are understood")
        self.assertFalse(release_app.satisfies_engines("v24.22.2", None))

    def test_refuses_a_host_without_a_live_enforcing_metadata_egress_floor(self):
        v4 = lambda outcome, ms=1: {"metadataV4": {"outcome": outcome, "ms": ms}, "metadataV6": {}}
        broken = {
            "connected": healthy_floor(probe=v4("connected")),
            "timeout": healthy_floor(probe=v4("timeout", 3000)),
            "EMFILE": healthy_floor(probe=v4("EMFILE", 0)),
            "IPv6 connected": healthy_floor(probe={**v4("ECONNREFUSED"), "metadataV6": {"ens3": {"outcome": "connected", "ms": 1}}}),
            "inactive": healthy_floor(active="inactive"),
            "unrequired": healthy_floor(userManager="Requires=\nAfter=\n"),
            "unreadable": healthy_floor(listing=None),
            "another uid": healthy_floor(listing=floor_fixtures.nft_listing(uid=1002)),
        }
        expected = {"connected": "169.254.169.254:80 was connected", "timeout": "was inconclusive (timeout",
                    "EMFILE": "was inconclusive (EMFILE", "IPv6 connected": "fe80::a9fe:a9fe%ens3 port 80 was connected",
                    "inactive": "enabled and inactive, not enabled and active", "unrequired": "user@1001.service does not require",
                    "unreadable": "could not be read through the floor's sudo rule", "another uid": "The live rules are"}
        for label, floor in broken.items():
            with self.subTest(label):
                problems = self.problems(self.facts(metadataFloor=floor))
                self.assertEqual(len(problems), 2, problems)
                self.assertIn(expected[label], problems[0])
                self.assertTrue(problems[0].startswith("Metadata egress floor: "))
                self.assertIn("metadata-egress-floor.py install", problems[1])
        # A link-local interface with no route cannot reach metadata at all.
        unroutable = healthy_floor(probe={**v4("ECONNREFUSED"), "metadataV6": {"ens4": {"outcome": "ENETUNREACH", "ms": 0}}})
        self.assertEqual(self.problems(self.facts(metadataFloor=unroutable)), [])

    def test_upgrade_helper_changes_need_explicit_review(self):
        changed = self.built(helperSha256="new-helper")
        self.assertIn("--accept-helper-change", self.problems(built=changed)[0])
        self.assertEqual(self.problems(built=changed, accept_helper_change=True), [])

    def test_names_and_build_versions(self):
        now = datetime.datetime(2026, 10, 1, 20, 49, 5, tzinfo=datetime.timezone.utc)
        self.assertEqual(release_app.release_name("7fac68e44e7d", now), "release-7fac68e4-20261001T204905Z")
        log = "Built service worker 974365546ec56e79 with 7 static files.\nBuilt service worker 3dc4598be2f7b72b with 7 static files."
        self.assertEqual(release_app.built_web_version(log), "3dc4598be2f7b72b")
        with self.assertRaises(ValueError):
            release_app.built_web_version("vite build failed")
        self.assertEqual(release_app.merged_pull_request("Merge pull request #8 from owner/branch"), 8)
        self.assertIsNone(release_app.merged_pull_request("Direct commit"))

    def test_records_reused_and_fresh_qualification(self):
        manifest = {"name": "release-7fac68e4-x", "commit": "7fac68e44e7d" + "0" * 28, "origin": "https://app.example.test",
                    "webBuild": "bbbbbbbbbbbbbbbb", "archiveSha256": "f" * 64, "hermesRevision": PRIOR["hermesRevision"],
                    "qualification": "reused", "pullRequest": 8}
        entry = release_app.ledger_entry(manifest, "production-release-7fac68e4-x.json", datetime.date(2026, 10, 1))
        self.assertTrue(entry.startswith("# October 1 app release 7fac68e\n"))
        self.assertIn("PR #8 merged", entry)
        # The entry lives in docs/ledger/, one level below the evidence directory.
        self.assertIn("(../evidence/production-release-7fac68e4-x.json)", entry)
        self.assertIn("existing qualification receipt", entry)
        fresh = release_app.ledger_entry({**manifest, "qualification": "new", "pullRequest": None}, "r.json", datetime.date(2026, 10, 1))
        self.assertIn("fresh qualification receipt", fresh)
        receipt = release_app.production_receipt(manifest, {"webBuild": "bbbbbbbbbbbbbbbb"}, {"maintenanceCleared": True})
        self.assertEqual(receipt["sourceCommit"], manifest["commit"])
        self.assertTrue(receipt["maintenanceCleared"] and receipt["preflightCheckPassed"])

    def test_ledger_files_sort_by_release_time_and_never_share_a_name(self):
        names = ["release-7fac68e4-20261013T181252Z", "release-7fac68e4-20261013T235959Z", "release-0aa11bb2-20261014T000001Z"]
        files = [release_app.ledger_file(name) for name in names]
        self.assertEqual(files[0], "docs/ledger/20261013T181252Z-app-release-7fac68e4.md")
        self.assertEqual(len(set(files)), 3, "Two releases of one commit on one day get their own entries")
        self.assertEqual(files, sorted(files))
        with self.assertRaises(Fence):
            release_app.ledger_file("release-x")


class Preparation(unittest.TestCase):
    """prepare against a fixture checkout and origin, with the host and the local npm build faked."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        git = lambda *args, cwd=root / "checkout": subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)
        git("init", "-q", "--bare", "-b", "main", str(root / "origin.git"), cwd=root)
        git("clone", "-q", str(root / "origin.git"), str(root / "checkout"), cwd=root)
        (root / "checkout/package.json").write_text(json.dumps({"engines": {"node": "^24.22.2"}}))
        git("add", "."); git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "Merge pull request #9 from x/y")
        git("push", "-q", "origin", "HEAD:main")
        self.saved = release_app.ROOT, release_app.MANIFESTS
        release_app.ROOT, release_app.MANIFESTS = root / "checkout", root / "manifests"

    def tearDown(self):
        release_app.ROOT, release_app.MANIFESTS = self.saved
        self.temporary.cleanup()

    def test_the_stage_runs_the_binary_the_host_built_with_not_the_path_that_named_it(self):
        # /srv/alias/node is a symlink the host resolved to /real/node at build time; retargeting it
        # later must not change what qualification, the deploy or recovery run.
        configs = []
        def remote(host, program, payload, timeout=None):
            if program is release_app.REMOTE_FACTS:
                prior = {**PRIOR, "upgradeStateDir": "/srv/state", "maintenanceFile": "/srv/maintenance", "hermesHome": "/home/.hermes"}
                return {"prior": prior, "priorPath": "/srv/app/operations/old/deploy-config.json", "current": "/srv/app/releases/old",
                        "hermesRevision": PRIOR["hermesRevision"], "repairSha256": PRIOR["repairSha256"], "worker": {"live": True},
                        "workerSha256": "worker", "profileHashes": {"/home/config.yaml": "now"}, "managedPython": "/home/python3", "maintenance": False,
                        "leasePresent": False, "drainPresent": False, "upgradePhase": "idle", "metadataFloor": healthy_floor(),
                        "serviceRuntime": ON_NODE}
            if program is release_app.REMOTE_BUILD:
                self.assertEqual(payload["node"], "/srv/alias/node")
                return {"buildLog": "Built service worker bbbbbbbbbbbbbbbb", "nodeVersion": "v24.22.2", "nodeRealpath": "/real/node",
                        "helperSha256": "helper", "receipt": {"valid": True, "error": None}}
            if program is release_app.REMOTE_WRITE_CONFIG:
                configs.append(payload["config"])
                return {"written": payload["path"]}
            raise AssertionError("unexpected host program")
        with patch.object(release_app, "remote", remote), \
             patch.object(release_app, "build_locally", lambda commit, work: (work.joinpath("release.tar.gz").write_bytes(b"x"), ("f" * 64, "bbbbbbbbbbbbbbbb"))[1]), \
             patch.object(release_app.host_access, "ssh", lambda *args, **kwargs: None), \
             patch.object(release_app.host_access, "scp", lambda *args, **kwargs: None), \
             patch.object(release_app, "guarded", lambda host, manifest, check: {"ok": True}), \
             patch("sys.stdout"):
            release_app.main(["prepare", "HEAD", "--host", "host", "--app-base", "/srv/app", "--node", "/srv/alias/node"])
        manifest = json.loads(next(release_app.MANIFESTS.glob("release-*.json")).read_text())
        self.assertEqual((manifest["status"], manifest["node"], manifest["nodeRealpath"]), ("prepared", "/real/node", "/real/node"))
        self.assertEqual(configs[0]["node"], "/real/node", "The deploy runs the pinned binary")


class Activation(unittest.TestCase):
    NAME = "release-7fac68e4-20261001T120000Z"
    ENTRY = "docs/ledger/20261001T120000Z-app-release-7fac68e4.md"
    ARCHIVE = "# Validation ledger\n\n## Earlier release\n"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        (root / "docs/evidence").mkdir(parents=True)
        (root / "docs/ValidationLedger.md").write_text(self.ARCHIVE)
        self.saved = (release_app.ROOT, release_app.MANIFESTS, release_app.guarded,
                      release_app.verify_release, release_app.remote)
        release_app.ROOT, release_app.MANIFESTS = root, root / ".private/releases"
        self.root = root
        self.live = {"current": "/srv/app/releases/old", "workerSha256": "worker"}
        self.runtime = dict(ON_NODE)
        release_app.remote = lambda host, program, payload: {"serviceRuntime": self.runtime} if program is release_app.REMOTE_FACTS else self.live
        release_app.save_manifest({"name": self.NAME, "status": "prepared", "host": "host",
            "commit": "7fac68e44e7d" + "0" * 28, "origin": "https://app.example.test", "webBuild": "b" * 16,
            "archiveSha256": "f" * 64, "hermesRevision": PRIOR["hermesRevision"], "qualification": "reused",
            "pullRequest": 8, "appBase": "/srv/app", "operationId": "op",
            "expectedRelease": "/srv/app/releases/old", "workerSha256": "worker", "node": "/srv/node", "nodeRealpath": "/real/node"})

    def tearDown(self):
        (release_app.ROOT, release_app.MANIFESTS, release_app.guarded,
         release_app.verify_release, release_app.remote) = self.saved
        self.temporary.cleanup()

    def status(self):
        return release_app.load_manifest(self.NAME)["status"]

    def evidence(self):
        return list((self.root / "docs/evidence").iterdir())

    def activate(self, guarded, checks, *options):
        release_app.guarded = guarded
        release_app.verify_release = lambda manifest: (checks, None)
        release_app.main(["activate", self.NAME, *(options or ["--no-docs-pr"])])

    def test_records_a_verified_release(self):
        self.activate(lambda host, manifest, check: {"webBuild": "b" * 16}, {"maintenanceCleared": True})
        # A new file per release; the frozen archive is untouched.
        entry = (self.root / self.ENTRY).read_text()
        self.assertTrue(entry.startswith("# "))
        self.assertEqual(entry.count("app release 7fac68e"), 1)
        self.assertEqual((self.root / "docs/ValidationLedger.md").read_text(), self.ARCHIVE)
        receipt = json.loads((self.root / f"docs/evidence/production-{self.NAME}.json").read_text())
        self.assertEqual((receipt["release"], receipt["webBuild"]), (self.NAME, "b" * 16))
        self.assertEqual(self.status(), "recorded")

    def test_refuses_when_live_state_changed_since_preparation(self):
        self.live["workerSha256"] = "edited"
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: self.fail("must not activate"), {})
        self.assertEqual(self.status(), "prepared")

    def test_refuses_when_the_service_was_switched_off_the_releases_runtime(self):
        self.runtime["running"] = "/old/node"
        with self.assertRaisesRegex(SystemExit, "Not activating:\n- The app service does not run /real/node"):
            self.activate(lambda *_, **__: self.fail("must not activate"), {})
        self.assertEqual(self.status(), "prepared")

    def test_failed_or_interrupted_activation_is_held_for_review(self):
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: None, {})
        self.assertEqual(self.status(), "needs-review")
        release_app.save_manifest({**release_app.load_manifest(self.NAME), "status": "prepared"})
        def lost(*_, **__):
            raise subprocess.TimeoutExpired("ssh", 1800)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.activate(lost, {})
        self.assertEqual(self.status(), "needs-review")
        self.assertEqual(self.evidence(), [])
        for command in ("activate", "discard"):
            with self.assertRaises(SystemExit):
                release_app.main([command, self.NAME])

    def test_failed_post_release_check_can_be_recorded_later(self):
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: {"webBuild": "b" * 16}, {"maintenanceCleared": False})
        self.assertEqual((self.status(), self.evidence()), ("activated", []))
        release_app.verify_release = lambda manifest: ({"maintenanceCleared": True}, None)
        release_app.main(["record", self.NAME, "--no-docs-pr"])
        self.assertEqual(self.status(), "recorded")
        self.assertEqual(len(self.evidence()), 1)
        # Recording again only retries the docs PR; it never writes a second entry.
        release_app.main(["record", self.NAME, "--no-docs-pr"])
        self.assertEqual(len(self.evidence()), 1)
        self.assertEqual([path.name for path in (self.root / "docs/ledger").iterdir()], [Path(self.ENTRY).name])
        self.assertEqual((self.root / self.ENTRY).read_text().count("app release 7fac68e"), 1)

    def test_rerecording_an_interrupted_record_keeps_one_ledger_entry(self):
        # A record that wrote its files but died before saving its status reruns as activated.
        with self.assertRaises(SystemExit):
            self.activate(lambda *_, **__: {"webBuild": "b" * 16}, {"maintenanceCleared": False})
        release_app.verify_release = lambda manifest: ({"maintenanceCleared": True}, None)
        original = release_app.save_manifest
        def crash_on_recorded(manifest):
            original(manifest)
            if manifest["status"] == "recorded":
                raise KeyboardInterrupt
        release_app.save_manifest = crash_on_recorded
        try:
            with self.assertRaises(KeyboardInterrupt):
                release_app.main(["record", self.NAME, "--no-docs-pr"])
        finally:
            release_app.save_manifest = original
        release_app.save_manifest({**release_app.load_manifest(self.NAME), "status": "activated"})
        # Rerun on a later day: the saved entry keeps its heading instead of adding a new one.
        original_entry = release_app.ledger_entry
        release_app.ledger_entry = lambda *args: "# October 2 app release 7fac68e\n"
        try:
            release_app.main(["record", self.NAME, "--no-docs-pr"])
        finally:
            release_app.ledger_entry = original_entry
        self.assertEqual([path.name for path in (self.root / "docs/ledger").iterdir()], [Path(self.ENTRY).name])
        self.assertEqual((self.root / self.ENTRY).read_text().count("app release 7fac68e"), 1)
        self.assertNotIn("October 2 app", (self.root / self.ENTRY).read_text())
        self.assertEqual(self.status(), "recorded")


class RecoveryCommand(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original = release_app.MANIFESTS
        release_app.MANIFESTS = Path(self.temporary.name)
        release_app.save_manifest({"name": "release-x", "status": "prepared", "host": "host", "appBase": "/srv/app"})
        (release_app.MANIFESTS / "release-x-qualification.json").write_text(
            json.dumps({"qualificationComplete": True, "receipt": "/srv/app/operations/release-x/q/qualification.json"}))

    def tearDown(self):
        release_app.MANIFESTS = self.original
        self.temporary.cleanup()

    def test_concurrent_recovery_of_the_same_release_is_refused_before_any_host_step(self):
        import fcntl
        calls = []
        original = release_app.remote
        release_app.remote = lambda *args, **kwargs: calls.append(args)
        try:
            with open(release_app.MANIFESTS / "release-x.lock", "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                with self.assertRaisesRegex(SystemExit, "Another release-app.py command is using release-x"):
                    release_app.main(["recover", "release-x"])
        finally:
            release_app.remote = original
        self.assertEqual(calls, [])
        self.assertEqual(release_app.load_manifest("release-x")["status"], "prepared")

    def test_recovery_uses_the_stages_runtime_and_refuses_a_service_not_running_it(self):
        release_app.save_manifest({**release_app.load_manifest("release-x"), "node": "/srv/app/runtime/new/bin/node", "nodeRealpath": "/real/new"})
        runtime = {"running": "/real/old", "livePath": "/real/new", "execStart": "/real/new", "path": "/real/new", "pathFiles": []}
        sent = []
        def remote(host, program, payload, timeout=None):
            if program is release_app.REMOTE_FACTS:
                return {"serviceRuntime": runtime}
            sent.append(payload)
            return {"checked": True}
        original = release_app.remote
        release_app.remote = remote
        try:
            with self.assertRaisesRegex(SystemExit, "Not recovering:\n- The app service does not run /real/new: its running process is /real/old"):
                release_app.main(["recover", "release-x", "--check"])
            self.assertEqual(sent, [], "No recovery step runs on the wrong runtime")
            runtime["running"] = "/real/new"
            release_app.main(["recover", "release-x", "--check"])
            self.assertEqual(sent[0]["node"], "/srv/app/runtime/new/bin/node")
        finally:
            release_app.remote = original

    def test_uncertain_recovery_is_held_for_review_and_cannot_run_again(self):
        replies = iter([{"currentReleaseQualificationVerified": True}, ConnectionError("lost reply")])
        def remote(host, program, payload, timeout=None):
            if program is release_app.REMOTE_FACTS:
                return {"serviceRuntime": {"running": "/real/node", "execStart": "/real/node", "path": "/real/node"}}
            reply = next(replies)
            if isinstance(reply, Exception):
                self.assertEqual(release_app.load_manifest("release-x")["status"], "recovering")
                raise reply
            return reply
        original = release_app.remote
        release_app.remote = remote
        try:
            with self.assertRaises(ConnectionError):
                release_app.main(["recover", "release-x"])
            self.assertEqual(release_app.load_manifest("release-x")["status"], "needs-review")
            with self.assertRaisesRegex(SystemExit, "needs-review"):
                release_app.main(["recover", "release-x"])
        finally:
            release_app.remote = original


class HostPrograms(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.host = Host(Path(self.temporary.name))

    def tearDown(self):
        self.temporary.cleanup()

    def test_facts_carry_the_latest_successful_release(self):
        older = self.host.deployment("older", "op-1", True, node="old-node")
        os.utime(self.host.base / "operations/continued-op-1/result.json", (time.time() - 60,) * 2)
        self.host.deployment("latest", "op-2", True, node="new-node")
        self.host.deployment("abandoned", "op-3", False, node="abandoned-node")
        code, output, error = run_remote(release_app.REMOTE_FACTS, facts_payload(self.host.base))
        self.assertEqual(code, 0, error)
        facts = json.loads(output)
        self.assertEqual(facts["prior"]["node"], "new-node")
        self.assertEqual(facts["serviceRuntime"], {"running": REAL_NODE, "livePath": REAL_NODE, "execStart": REAL_NODE,
                                                   "path": REAL_NODE, "pathFiles": []})
        self.assertEqual(facts["current"], str((self.host.base / "releases/release-live").resolve()))
        self.assertEqual(facts["profileHashes"], {str(self.host.profile): hashlib.sha256(b"model: default\n").hexdigest()})
        self.assertFalse(facts["maintenance"] or facts["leasePresent"] or facts["drainPresent"])
        self.assertEqual(older["node"], "old-node")
        head = subprocess.check_output(["git", "-C", str(self.host.source), "rev-parse", "HEAD"], text=True).strip()
        repair = subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(self.host.source), "diff", "HEAD", "--binary"])
        self.assertEqual((facts["hermesRevision"], facts["repairSha256"]), (head, hashlib.sha256(repair).hexdigest()))
        self.assertEqual(facts["workerSha256"], hashlib.sha256((self.host.base / "shared/hermes-worker.json").read_bytes()).hexdigest())
        self.assertEqual(facts["managedPython"], str(self.host.interpreter))
        floor = facts["metadataFloor"]
        self.assertEqual((floor["uid"], floor["probe"]["metadataV4"]["outcome"], floor["probe"]["metadataV6"]),
                         (os.getuid(), "ECONNREFUSED", {}))
        # Live rules read and probe refused; only this machine's lack of the boot unit remains.
        problems = release_app.metadata_floor_problems(floor)
        self.assertIn("its boot unit is", problems[0])
        self.assertFalse(any("live rules" in problem or "169.254" in problem or "could not be read" in problem for problem in problems), problems)

    def test_facts_report_a_reachable_metadata_service(self):
        self.host.deployment("latest", "op-2", True)
        with socket.socket() as metadata:
            metadata.bind(("127.0.0.1", 0)); metadata.listen()
            probe = {**closed_probe(listing_uid=1), "port": metadata.getsockname()[1]}
            code, output, error = run_remote(release_app.REMOTE_FACTS, facts_payload(self.host.base, probe))
        self.assertEqual(code, 0, error)
        problems = release_app.metadata_floor_problems(json.loads(output)["metadataFloor"])
        self.assertTrue(any("was connected" in problem for problem in problems), problems)
        self.assertTrue(any("The live rules are" in problem for problem in problems), problems)

    def test_verify_fails_when_the_floor_is_missing(self):
        manifest = {"origin": "https://app.example.test", "webBuild": "b" * 16, "host": "host", "appBase": "/srv/app",
                    "release": "/srv/app/releases/new", "operationId": "op", "upgradeStateDir": "/s",
                    "maintenanceFile": "/m", "hermesHome": "/h"}
        live = {"current": "/srv/app/releases/new", "release": "/srv/app/releases/new", "units": {"a": "active"},
                "phase": "idle", "maintenance": False, "leasePresent": False, "drainPresent": False, "result": None}
        sent = []
        def remote(host, program, payload):
            sent.append(payload)
            return {**live, "metadataFloor": floor}
        with patch.object(release_app, "remote", remote), \
             patch.object(release_app, "http_get", lambda url: (401, "") if url.endswith("/api/bootstrap") else (200, "b" * 16)):
            floor = healthy_floor()
            checks, _ = release_app.verify_release(manifest)
            self.assertTrue(all(checks.values()), checks)
            floor = healthy_floor(probe={"metadataV4": {"outcome": "timeout", "ms": 3000}, "metadataV6": {}})
            with patch("sys.stderr"):
                checks, _ = release_app.verify_release(manifest)
        self.assertFalse(checks["metadataEgressFloor"])
        self.assertEqual([name for name, passed in checks.items() if not passed], ["metadataEgressFloor"])
        self.assertEqual(sent[0]["metadataProbe"], release_app.METADATA_PROBE)

    def test_facts_tell_the_running_runtime_from_the_one_the_next_start_would_use(self):
        self.host.deployment("latest", "op-2", True)
        other = RUNTIME / "other/bin"; other.mkdir(parents=True, exist_ok=True)
        (other / "node").write_text("#!/bin/sh\n"); (other / "node").chmod(0o700)
        other_node = str(other / "node")
        # A runtime directory with a space, which systemd prints unescaped in ExecStart and quoted in Environment.
        spaced = RUNTIME / "my node/bin"; spaced.mkdir(parents=True, exist_ok=True)
        if not (spaced / "node").exists():
            (spaced / "node").symlink_to(sys.executable)
        files = Path(self.temporary.name)
        (files / "path.env").write_text("NODE_ENV=production\n  PATH=/usr/bin\n")
        (files / "plain.env").write_text("NODE_ENV=production\nMYPATH=/x\n")
        on_node = {"running": REAL_NODE, "livePath": REAL_NODE, "execStart": REAL_NODE, "path": REAL_NODE, "pathFiles": []}
        cases = {
            # The unit was edited and reloaded, but the old process still runs.
            "edited, not restarted": (service_show(exec_start=other_node, path=str(other) + ":/usr/bin"),
                                      {**on_node, "execStart": other_node, "path": other_node}),
            # Restarted on the new binary while its PATH still finds another node.
            "live PATH finds another node": (service_show(pid=service_process(str(other) + ":/usr/bin")),
                                             {**on_node, "livePath": other_node}),
            "stopped": (service_show(pid=0), {**on_node, "running": None, "livePath": None}),
            "nothing shown": ("", {"running": None, "livePath": None, "execStart": None, "path": None, "pathFiles": []}),
            "spaces in the paths": (service_show(exec_start=str(spaced / "node"), path=f"{spaced}:/usr/bin"), on_node),
            # Only a file that sets PATH, or a required one that cannot be read, decides the next start's PATH.
            "environment files": (service_show(files=[f"{files / 'path.env'} (ignore_errors=no)", f"{files / 'plain.env'} (ignore_errors=no)",
                                                      f"{files / 'gone.env'} (ignore_errors=yes)", f"{files / 'needed.env'} (ignore_errors=no)"]),
                                  {**on_node, "pathFiles": [str(files / "path.env"), str(files / "needed.env")]}),
            # A wildcard is expanded as systemd does: each match is read, and a required one with no match fails.
            "environment file wildcards": (service_show(files=[f"{files / '*.env'} (ignore_errors=yes)", f"{files / 'pl*.env'} (ignore_errors=no)",
                                                               f"{files / 'none-*.env'} (ignore_errors=yes)", f"{files / 'gone-*.env'} (ignore_errors=no)"]),
                                           {**on_node, "pathFiles": [str(files / "path.env"), str(files / "gone-*.env")]}),
        }
        for name, (shown, expected) in cases.items():
            code, output, error = run_remote(release_app.REMOTE_FACTS, facts_payload(self.host.base, shown=shown))
            self.assertEqual(code, 0, error)
            self.assertEqual(json.loads(output)["serviceRuntime"], expected, name)

    def test_facts_ask_systemd_for_every_service_property_they_read(self):
        # The fixture command above answers whatever is asked; only this list decides what the real
        # systemctl prints. A property missing here reads as absent on the host, and an absent
        # EnvironmentFiles would hide a PATH override.
        sent = []
        with patch.object(release_app, "remote", lambda host, program, payload: sent.append(payload)):
            release_app.host_facts("host", "/srv/app")
        command = sent[0]["serviceCommand"]
        self.assertEqual(command[:5], ["systemctl", "--user", "show", "agent-interface.service", "-p"])
        self.assertEqual({command[i + 1] for i, part in enumerate(command) if part == "-p"},
                         {"MainPID", "ExecStart", "Environment", "EnvironmentFiles"})

    def test_facts_report_active_maintenance(self):
        self.host.deployment("latest", "op-2", True)
        self.host.status({"phase": "blocked", "maintenance": True})
        (self.host.home / ".drain_request.json").write_text("{}")
        facts = json.loads(run_remote(release_app.REMOTE_FACTS, facts_payload(self.host.base))[1])
        self.assertTrue(facts["maintenance"] and facts["drainPresent"])

    def test_facts_refuse_without_a_successful_release(self):
        self.host.deployment("abandoned", "op-3", False)
        code, _, error = run_remote(release_app.REMOTE_FACTS, facts_payload(self.host.base))
        self.assertNotEqual(code, 0)
        self.assertIn("No successful guarded release", error)

    def test_build_refuses_a_runtime_that_is_not_the_node_on_its_path(self):
        import tarfile
        operation = self.host.base / "operations/release-new"; operation.mkdir()
        with tarfile.open(operation / "release.tar.gz", "w:gz"):
            pass
        (self.host.base / "no-runtime/bin").mkdir(parents=True)
        payload = {"appBase": str(self.host.base), "release": str(self.host.base / "releases/release-new"),
                   "operationDir": str(operation), "archiveSha256": hashlib.sha256((operation / "release.tar.gz").read_bytes()).hexdigest(),
                   "node": str(self.host.base / "no-runtime/bin/node"), "qualification": None,
                   "qualificationReceipt": "/none", "hermesRevision": "x", "repairSha256": "y"}
        code, _, error = run_remote(release_app.REMOTE_BUILD, payload)
        self.assertNotEqual(code, 0)
        self.assertIn("node on the build PATH is not " + payload["node"], error)
        self.assertFalse((operation / "build.log").exists(), "Nothing is built with the wrong node")

    def test_configuration_is_private_and_never_overwritten(self):
        path = self.host.base / "operations/deploy-config.json"
        self.assertEqual(run_remote(release_app.REMOTE_WRITE_CONFIG, {"path": str(path), "config": {"a": 1}})[0], 0)
        self.assertEqual(json.loads(path.read_text()), {"a": 1})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(run_remote(release_app.REMOTE_WRITE_CONFIG, {"path": str(path), "config": {"a": 2}})[0], 0)
        self.assertEqual(json.loads(path.read_text()), {"a": 1})

    def test_native_chromium_stays_inside_the_hermes_tool_store(self):
        import runpy
        worker = runpy.run_path(str(ROOT / "scripts/hermes-upgrade-worker.py"))
        tools = self.host.home / "tools"
        browser = tools / "chromium-1/chrome"
        browser.parent.mkdir(parents=True)
        browser.write_text("#!/bin/sh\n"); browser.chmod(0o700)
        facts = lambda template: (tools / "facts.json").write_text(json.dumps(
            {"packages": {"chromium": {"env": {"AGENT_BROWSER_EXECUTABLE_PATH": template}}}}))
        facts("{{store}}/chromium-1/chrome")
        self.assertEqual(worker["native_chromium"](self.host.home), browser.resolve())
        # Real executables outside the store, so only the containment check can refuse them.
        outside = self.host.home / "escape/chrome"
        outside.parent.mkdir(); outside.write_text("#!/bin/sh\n"); outside.chmod(0o700)
        (tools / "linked").symlink_to(outside.parent)
        for template in (str(outside), "{{store}}/../escape/chrome", "{{store}}/linked/chrome", "{{store}}/missing/chrome"):
            facts(template)
            with self.assertRaises(RuntimeError):
                worker["native_chromium"](self.host.home)
        facts("{{store}}/chromium-1/chrome"); browser.chmod(0o600)
        with self.assertRaises(RuntimeError):
            worker["native_chromium"](self.host.home)

    def test_prune_keeps_the_live_release_its_rollback_target_and_the_newest(self):
        import os, time
        releases = self.host.base / "releases"
        live = (self.host.base / "current").resolve()
        now = time.time()
        names = [f"release-old-{index:02}" for index in range(14)]
        week = 8 * 86400
        for index, name in enumerate(names):
            (releases / name).mkdir(); os.utime(releases / name, (now - week + index, now - week + index))
        os.utime(live, (now - 2 * week, now - 2 * week))
        # A stage another session is still qualifying: old directory, fresh operation.
        (self.host.base / "operations/release-old-05").mkdir(parents=True)
        operation = self.host.base / "operations" / live.name
        operation.mkdir(parents=True, exist_ok=True)
        (operation / "deploy-config.json").write_text(json.dumps({"previous": str(releases / "release-old-00")}))
        code, output, error = run_remote(release_app.REMOTE_PRUNE, {"appBase": str(self.host.base), "keep": 3, "minAgeDays": 7})
        self.assertEqual(code, 0, error)
        left = sorted(path.name for path in releases.iterdir())
        self.assertEqual(left, sorted({live.name, "release-old-00", "release-old-05", "release-old-11", "release-old-12", "release-old-13"}))
        self.assertEqual(sorted(json.loads(output)["removed"]), [name for name in names[1:11] if name != "release-old-05"])
        # Recent releases beyond the newest few stay until they are a week old.
        (releases / "release-recent").mkdir(); os.utime(releases / "release-recent", (now - 86400, now - 86400))
        for name in ("release-old-11", "release-old-12", "release-old-13"): os.utime(releases / name, (now, now))
        self.assertEqual(json.loads(run_remote(release_app.REMOTE_PRUNE, {"appBase": str(self.host.base), "keep": 3, "minAgeDays": 7})[1])["removed"], [])

    def test_discard_removes_only_an_unactivated_release(self):
        release = self.host.base / "releases/release-new"
        operation = self.host.base / "operations/release-new"
        release.mkdir(); operation.mkdir()
        payload = {"appBase": str(self.host.base), "release": str(release), "operationDir": str(operation), "operationId": "op-9"}
        live = dict(payload, release=str(self.host.base / "releases/release-live"))
        self.assertNotEqual(run_remote(release_app.REMOTE_DISCARD, live)[0], 0)
        self.assertTrue((self.host.base / "releases/release-live").exists())
        import fcntl
        with open(self.host.base / "shared/upgrade-state/worker.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            code, _, error = run_remote(release_app.REMOTE_DISCARD, dict(payload, upgradeStateDir=str(self.host.base / "shared/upgrade-state")))
            self.assertNotEqual(code, 0)
            self.assertIn("operation is running", error)
            self.assertTrue(release.exists())
        self.assertEqual(run_remote(release_app.REMOTE_DISCARD, dict(payload, upgradeStateDir=str(self.host.base / "shared/upgrade-state")))[0], 0)
        self.assertFalse(release.exists() or operation.exists())

    def test_discard_keeps_a_qualification_receipt_unless_told(self):
        release = self.host.base / "releases/release-qualified"
        operation = self.host.base / "operations/release-qualified"
        receipt = operation / "qualification-one/qualification.json"
        release.mkdir(); receipt.parent.mkdir(parents=True); receipt.write_text("{}")
        payload = {"appBase": str(self.host.base), "release": str(release), "operationDir": str(operation), "operationId": "op-10"}
        code, _, error = run_remote(release_app.REMOTE_DISCARD, payload)
        self.assertNotEqual(code, 0)
        self.assertIn(str(receipt), error)
        self.assertTrue(receipt.exists() and release.exists())
        self.assertEqual(run_remote(release_app.REMOTE_DISCARD, dict(payload, includeQualification=True))[0], 0)
        self.assertFalse(release.exists() or operation.exists())

    def stage(self, name, state="active", age=0):
        stage = self.host.base / "operations/release-x" / name
        for path in ("source/.git/objects/ab", "pm-home/tools/python/bin", "pm-home/installs/hermes",
                     "pm-home/cache/uv/wheels", "pm-home/cache/scratch/agent-interface-spike-1/evidence", "pm-home/logs"):
            (stage / path).mkdir(parents=True)
        (stage / "source/.git/objects/ab/cdef").write_text("object")
        (stage / "pm-home/cache/scratch/agent-interface-spike-1/evidence/app-probe.json").write_text("{}")
        (stage / "pm-home/logs/pm.log").write_text("log")
        (stage / "pm-home/cache/uv/wheels/a.whl").write_text("wheel")
        (stage / "qualification.json").write_text("{}")
        (stage / "integration.log").write_text("log")
        # Native caches can leave directories without owner write access.
        (stage / "source/.git/objects/ab").chmod(0o500)
        marker = stage / ".agent-interface-upgrade-stage"
        marker.write_text(json.dumps({"schemaVersion": 1, "operationId": name, "state": state}))
        os.utime(marker, (time.time() - age,) * 2)
        return stage

    def assert_pruned(self, stage):
        self.assertFalse((stage / "source").exists())
        self.assertEqual(sorted(path.name for path in (stage / "pm-home").iterdir()), ["cache", "logs"])
        self.assertEqual([path.name for path in (stage / "pm-home/cache").iterdir()], ["scratch"])
        self.assertTrue((stage / "pm-home/cache/scratch/agent-interface-spike-1/evidence/app-probe.json").is_file())
        self.assertTrue((stage / "qualification.json").is_file() and (stage / "integration.log").is_file())
        self.assertEqual(json.loads((stage / ".agent-interface-upgrade-stage").read_text())["state"], "completed")

    def test_finished_qualification_keeps_only_receipts_logs_and_probe_evidence(self):
        stage = self.stage("qualification-done")
        code, output, error = run_remote(qualify_app.PRUNE + 'finish(prune_stage(Path(PAYLOAD["stage"])))', {"stage": str(stage)})
        self.assertEqual((code, output), (0, "true"), error)
        self.assert_pruned(stage)

    def test_sweep_prunes_only_stages_interrupted_more_than_a_day_ago(self):
        interrupted = self.stage("qualification-interrupted", age=2 * 24 * 3600)
        running = self.stage("qualification-running", age=3600)
        settled = self.stage("qualification-settled", state="completed", age=2 * 24 * 3600)
        program = qualify_app.PRUNE + 'sweep_stale_stages(Path(PAYLOAD["operations"]), time.time()); finish(True)'
        code, _, error = run_remote(program, {"operations": str(self.host.base / "operations")})
        self.assertEqual(code, 0, error)
        self.assert_pruned(interrupted)
        self.assertTrue((running / "source").exists() and (settled / "source").exists())

    def recovery_host(self):
        release = (self.host.base / "releases/release-live").resolve()
        tools = release / ".agents/tools"
        tools.mkdir(parents=True)
        (tools / "recover-app-after-native-update.py").write_text(FAKE_RECOVERY_HELPER)
        (tools / "deploy-app-release.py").write_text("# deployment functions\n")
        for name in ("app.env", "hermes-service.env"):
            (self.host.base / "shared" / name).write_text("KEY=value\n")
        (self.host.source / "agent_interface_gateway.py").symlink_to(release / "gateway_guard.py")
        prior = self.host.deployment("release-live", "op-live", True, release=str(release), expectedRelease="older",
                                     hermesRevision="old", repairSha256="old", newQualificationReceipt="old.json",
                                     node="node", appOrigin="https://app.example.test")
        return tools, prior

    def heartbeat(self, age=0):
        updated = datetime.datetime.fromtimestamp(time.time() - age, datetime.timezone.utc).isoformat()
        (self.host.home / "gateway_state.json").write_text(json.dumps({"updated_at": updated}))

    def recover(self, check, **overrides):
        payload = {"appBase": str(self.host.base), "receipt": "/stage/qualification.json", "operationId": "op-new",
                   "check": check, "heartbeatWaitSeconds": 5, **overrides}
        return run_remote(release_app.REMOTE_RECOVER, payload)

    def test_recovery_binds_live_release_to_installed_hermes_then_reuses_its_checked_configuration(self):
        tools, prior = self.recovery_host()
        self.heartbeat()
        code, output, error = self.recover(check=True)
        self.assertEqual((code, json.loads(output or "null")), (0, {"checked": True}), error)
        path = self.host.base / "operations/native-recovery-config-op-new/config.json"
        config = json.loads(path.read_text())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        head = subprocess.check_output(["git", "-C", str(self.host.source), "rev-parse", "HEAD"], text=True).strip()
        repair = subprocess.check_output(["git", "-c", "core.abbrev=10", "-C", str(self.host.source), "diff", "HEAD", "--binary"])
        release = str((self.host.base / "releases/release-live").resolve())
        self.assertEqual({key for key in config if config[key] != prior.get(key)},
                         {"expectedRelease", "hermesRevision", "repairSha256", "newQualificationReceipt",
                          "operationId", "profileHashes", "preservedFiles", "deployFunctionsSha256", "managedPython"})
        self.assertEqual(config["managedPython"], str(self.host.interpreter))
        self.assertEqual((config["release"], config["expectedRelease"]), (release, release))
        self.assertEqual((config["hermesRevision"], config["repairSha256"]), (head, hashlib.sha256(repair).hexdigest()))
        self.assertEqual(config["newQualificationReceipt"], "/stage/qualification.json")
        self.assertEqual(config["profileHashes"], {str(self.host.profile): "file:config.yaml"})
        self.assertEqual(config["preservedFiles"], {
            str(self.host.base / "shared/app.env"): "file:app.env",
            str(self.host.base / "shared/hermes-service.env"): "file:hermes-service.env",
            str(self.host.base / "shared/hermes-worker.json"): "file:hermes-worker.json",
            str(self.host.source / "agent_interface_gateway.py"): "link:" + release + "/gateway_guard.py"})
        # A live helper from before deploy_common.py names no shared module and runs these.
        self.assertEqual(config["deployFunctionsSha256"], "file:deploy-app-release.py")
        self.heartbeat()
        code, output, error = self.recover(check=False)
        self.assertEqual((code, json.loads(output or "null")), (0, {"checked": False}), error)
        self.assertEqual(json.loads((tools / "calls.json").read_text()),
                         [["--config", str(path), "--check"], ["--config", str(path)]])

    def test_recovery_configuration_runs_with_the_stages_runtime(self):
        self.recovery_host()
        self.heartbeat()
        code, _, error = self.recover(check=True, node="/srv/app/runtime/new/bin/node")
        self.assertEqual(code, 0, error)
        config = json.loads((self.host.base / "operations/native-recovery-config-op-new/config.json").read_text())
        self.assertEqual(config["node"], "/srv/app/runtime/new/bin/node")

    def test_recovery_check_pins_the_shared_module_the_live_helper_imports(self):
        tools, _ = self.recovery_host()
        for name in ("recover-app-after-native-update.py", "deploy_common.py"):
            (tools / name).write_bytes((ROOT / ".agents/tools" / name).read_bytes())
        self.heartbeat()
        # The real helper then refuses this incomplete release; only its configuration matters here.
        code, _, error = self.recover(check=True)
        self.assertNotEqual(code, 0)
        self.assertIn("Recovery check stopped", error)
        config = json.loads((self.host.base / "operations/native-recovery-config-op-new/config.json").read_text())
        self.assertEqual(config["deployFunctionsSha256"], hashlib.sha256((tools / "deploy_common.py").read_bytes()).hexdigest())
        self.assertFalse((tools / "__pycache__").exists(), "Loading the helper must not write into the live release")

    def test_recovery_needs_a_passed_check_and_a_fresh_heartbeat_before_the_helper_runs(self):
        tools, _ = self.recovery_host()
        self.heartbeat()
        code, _, error = self.recover(check=False)
        self.assertNotEqual(code, 0)
        self.assertIn("Run the recovery check first", error)
        self.heartbeat(age=30)
        code, _, error = self.recover(check=True, heartbeatWaitSeconds=0)
        self.assertNotEqual(code, 0)
        self.assertIn("no fresh heartbeat", error)
        self.assertFalse((tools / "calls.json").exists())

    def test_stopped_helper_reports_its_audit_log(self):
        tools, _ = self.recovery_host()
        (tools / "fail").touch()
        audit = self.host.base / "operations/native-recovery-check-op-new-1"
        audit.mkdir()
        (audit / "commands.log").write_text("AssertionError: gateway busy\n")
        self.heartbeat()
        code, _, error = self.recover(check=True)
        self.assertNotEqual(code, 0)
        self.assertIn("Recovery check stopped. Recovery stopped for review.", error)
        self.assertIn(str(audit / "commands.log"), error)
        self.assertIn("gateway busy", error)


if __name__ == "__main__":
    unittest.main()
