"""Control-plane proofs using real Git trees and deterministic installer hooks.

These prove durable upgrade/rollback ordering, not Hermes integration. The shipped
worker separately requires the complete real Hermes qualification suite.
"""
import importlib.util
import base64
import re
import fcntl
import signal
import time
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("hermes-upgrade-worker.py"))
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)

HOOK = r'''
import json, os, pathlib, subprocess, sys, time
source=pathlib.Path(os.environ['HERMES_UPGRADE_SOURCE'])
stage=pathlib.Path(os.environ['HERMES_UPGRADE_STAGE_HOME'])
action=sys.argv[1]
with (stage/'hook-order.txt').open('a') as stream: stream.write(action+'\n')
if action=='quiescence':
    if os.environ.get('HERMES_UPDATE_HANDOFF_PID'):
        marker=pathlib.Path(os.environ['FIXTURE_MANAGED_HOME'])/'.hermes-update-in-progress'
        assert marker.read_text().splitlines()[0]==os.environ['HERMES_UPDATE_HANDOFF_PID']
    if (stage/'refuse').exists(): raise SystemExit(75)
    if (stage/'uncertain').exists(): raise SystemExit(1)
    (stage/'gate').write_text('exclusive')
elif action=='backup':
    target=pathlib.Path(os.environ['HERMES_UPGRADE_BACKUP_DIR']); target.mkdir()
    revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD']).decode().strip()
    (target/'revision').write_text(revision)
    (target/'repair.patch').write_bytes(subprocess.check_output(['git','-C',str(source),'diff','HEAD','--binary']))
elif action=='install':
    if (stage/'pause-install').exists():
        (stage/'install-entered').touch()
        while not (stage/'resume-install').exists(): time.sleep(.02)
    assert (stage/'gate').exists() and (stage/'backup/revision').exists()
    subprocess.run(['git','-C',str(source),'reset','--hard',os.environ['HERMES_UPGRADE_CANDIDATE']],check=True)
    repair=subprocess.check_output(['git','-C',str(stage/'source'),'diff','HEAD','--binary'])
    if repair: subprocess.run(['git','-C',str(source),'apply','--index','-'],input=repair,check=True)
elif action=='verify':
    if (stage/'fail-verify').exists() and os.environ.get('HERMES_UPGRADE_ROLLBACK')!='1': raise SystemExit(1)
    if (stage/'fail-rollback-verify').exists() and os.environ.get('HERMES_UPGRADE_ROLLBACK')=='1': raise SystemExit(1)
elif action=='rollback':
    subprocess.run(['git','-C',str(source),'reset','--hard',(stage/'backup/revision').read_text()],check=True)
    repair=(stage/'backup/repair.patch').read_bytes()
    if repair: subprocess.run(['git','-C',str(source),'apply','--index','-'],input=repair,check=True)
elif action=='recover':
    assert (stage/'gate').exists()
    if (stage/'backup/revision').exists():
        subprocess.run(['git','-C',str(source),'reset','--hard',(stage/'backup/revision').read_text()],check=True)
        repair=(stage/'backup/repair.patch').read_bytes()
        if repair: subprocess.run(['git','-C',str(source),'apply','--index','-'],input=repair,check=True)
    receipt=pathlib.Path(os.environ['HERMES_UPGRADE_PREVIOUS_RECEIPT'])
    pathlib.Path(os.environ.get('FIXTURE_DEPLOYED_RECEIPT', str(source.parent/'deployed-qualification.json'))).write_bytes(receipt.read_bytes())
    (stage/'gate').unlink()
elif action=='restart_service':
    assert (stage/'gate').exists()
    (stage/'gate').unlink()
elif action=='finish':
    (stage/'gate').unlink(missing_ok=True)
    if (stage/'fail-finish').exists(): raise SystemExit(1)
'''

# Native marker double tests worker ownership/handoff wiring, not native locking.
UPDATE_LOCK = '''import os, time
class UpdateLock:
    def __init__(self, *, path): self.path=path; self.acquired=False
    def acquire(self):
        if self.path.exists():
            owner=int(self.path.read_text().splitlines()[0])
            if owner!=os.getpid(): return False
        self.path.parent.mkdir(parents=True,exist_ok=True)
        self.path.write_text(f"{os.getpid()}\\n{int(time.time())}\\n"); self.path.chmod(0o600)
        self.acquired=True; return True
    def release(self):
        if self.acquired and self.path.exists() and self.path.read_text().splitlines()[0]==str(os.getpid()): self.path.unlink()
'''

class RepairMergeTests(unittest.TestCase):
    def merge(self, base, ours, theirs):
        result = worker.merge_lines(*(text.splitlines(True) for text in (base, ours, theirs)))
        return None if result is None else "".join(result)

    def test_edit_survives_an_upstream_change_on_the_line_beside_it(self):
        self.assertEqual(self.merge("sig Dict\nimport lock\nbody\n", "sig Dict\nimport transaction\nbody\n", "sig dict\nimport lock\nbody\n"),
            "sig dict\nimport transaction\nbody\n")

    def test_edit_follows_lines_upstream_moved(self):
        self.assertEqual(self.merge("a\nlock\nz\n", "a\ntransaction\nz\n", "new\nnew\na\nlock\nz\n"), "new\nnew\na\ntransaction\nz\n")

    def test_refuses_when_upstream_changed_a_line_the_repair_replaces(self):
        self.assertIsNone(self.merge("a\nlock\nz\n", "a\ntransaction\nz\n", "a\nlock2\nz\n"))

    def test_insertion_needs_both_neighbours_unchanged_and_adjacent(self):
        self.assertEqual(self.merge("a\nb\n", "a\nadded\nb\n", "a\nb\nc\n"), "a\nadded\nb\nc\n")
        self.assertIsNone(self.merge("a\nb\n", "a\nadded\nb\n", "a\nupstream\nb\n"))
        self.assertIsNone(self.merge("a\nb\n", "a\nadded\nb\n", "a2\nb\n"))

    def test_payload_lines_that_look_like_headers_are_still_compared(self):
        clean = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n keep\n+safe\n"
        hidden = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,3 @@\n keep\n+safe\n+++ __import__('os').system('id')\n"
        self.assertNotEqual(worker.repair_changes(clean), worker.repair_changes(hidden))
        self.assertIsNone(worker.repair_changes(clean.replace(b"+1,2", b"+1,3")))

    def test_refuses_a_duplicate_occurrence_in_another_place(self):
        base = "def authenticate():\n    check()\n    return allow()\n\ndef other():\n    pass\n"
        ours = base.replace("return allow()", "return verify()")
        theirs = "def authenticate():\n    check()\n    return allow_v2()\n\ndef other():\n    pass\n\ndef unused():\n    noise()\n    return allow()\n"
        self.assertIsNone(self.merge(base, ours, theirs))

    def test_refuses_when_the_replaced_lines_appear_twice_upstream(self):
        base = "a\nb\nlock\nc\nd\n"
        self.assertIsNone(self.merge(base, base.replace("lock", "transaction"), "a2\nb\nlock\nc\nd\nx\nlock\ny\n"))

    def test_no_newline_marker_on_unchanged_context_is_ignored(self):
        with_marker = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-lock\n+transaction\n tail\n\\ No newline at end of file\n"
        without = b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-lock\n+transaction\n tail\n"
        self.assertEqual(worker.repair_changes(with_marker), worker.repair_changes(without))

    def test_repair_changes_ignore_context_but_not_edits_or_modes(self):
        one = b"diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n sig Dict\n-lock\n+transaction\n"
        two = b"diff --git a/f b/f\nindex 3..4 100644\n--- a/f\n+++ b/f\n@@ -9,2 +9,2 @@\n sig dict\n-lock\n+transaction\n"
        self.assertEqual(worker.repair_changes(one), worker.repair_changes(two))
        self.assertNotEqual(worker.repair_changes(one), worker.repair_changes(two.replace(b"+transaction", b"+other")))
        self.assertNotEqual(worker.repair_changes(one), worker.repair_changes(one.replace(b"index 1..2 100644\n", b"old mode 100644\nnew mode 100755\nindex 1..2\n")))


class QualificationWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agent-interface-upgrade-worker-test-")
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "source"; self.source.mkdir()
        def git(*args): return subprocess.check_output(["git", "-C", str(self.source), *args], stderr=subprocess.DEVNULL)
        self.git = git
        git("init"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture")
        (self.source / "version").write_text("old")
        (self.source / "hermes_cli").mkdir(); (self.source / "hermes_cli/update_lock.py").write_text(UPDATE_LOCK)
        git("add", "."); git("commit", "-m", "old")
        self.old = git("rev-parse", "HEAD").decode().strip()
        (self.source / "version").write_text("new"); git("add", "."); git("commit", "-m", "new")
        self.new = git("rev-parse", "HEAD").decode().strip()
        git("update-ref", "refs/remotes/origin/main", self.new); git("checkout", "--detach", self.old)
        git("remote", "add", "origin", "https://github.com/NousResearch/hermes-agent.git")
        self.app = self.root / "app"; (self.app / "src/hermes").mkdir(parents=True); (self.app / "scripts/spike").mkdir(parents=True)
        (self.app / "node_modules").mkdir()
        (self.app / "src/hermes/qualification.py").write_text("def integration_digest(root):\n    return 'a'*64\n")
        (self.app / "scripts/spike/run.py").write_text("# Control-plane fixture, never production qualification.\nprint('fixture integration command complete')\n")
        for filename in ["package.json", "package-lock.json", "tsconfig.json"]: (self.app / filename).write_text("{}")
        hook = self.root / "hook.py"; hook.write_text(HOOK)
        self.state = self.root / "state"; self.state.mkdir(mode=0o700); (self.state / "requests").mkdir(mode=0o700)
        self.receipt = self.root / "deployed-qualification.json"
        self.config = self.root / "config.json"
        worker.atomic(self.config, {"source":str(self.source),"appRoot":str(self.app),"stageRoot":str(self.root/'stages'),
            "qualificationPython":sys.executable,"qualificationReceipt":str(self.receipt),"requiredPatchSha256":None,
            "hooks":{**{action:[sys.executable,str(hook),action] for action in ['quiescence','backup','install','verify','rollback','finish','recover','restart_service']},
                "regressions":[[sys.executable,str(hook),'regressions']]}})
        self.original_run = worker.Worker.run
        self.fixture_upstream = self.source
        def run(instance, argv, **kwargs):
            # Only replace the fixed network URL with the local Git fixture.
            # The staging fetch, object transfer and checkout all run for real.
            if argv[:4] == ["git", "-C", str(self.source), "fetch"]: return
            if argv[3:6] == ["remote", "add", "origin"] and argv[-1] == worker.OFFICIAL_UPSTREAM:
                argv = [*argv[:-1], self.fixture_upstream.as_uri()]
            return self.original_run(instance, argv, **kwargs)
        self.interception = patch.object(worker.Worker, "run", run); self.interception.start()

    def tearDown(self): self.interception.stop(); self.temporary.cleanup()
    def status(self): return json.loads((self.state / "status.json").read_text())
    def check(self):
        operation = str(uuid.uuid4()); worker.atomic(self.state / "status.json", {"operationId":operation,"phase":"checking","checks":[],"message":"Checking"})
        worker.Worker(self.config,self.state,"check",operation).main()
        self.assertEqual(self.status()["phase"],"ready")
        return Path(self.status()["qualification"]["stage"])
    def install(self, expect_error=False):
        operation, request = str(uuid.uuid4()),str(uuid.uuid4()); state=self.status()
        state.update(operationId=operation,requestId=request,phase="installing",maintenance=True)
        worker.atomic(self.state / "status.json",state)
        worker.atomic(self.state / "requests" / (request+'.json'),{"operationId":operation,"candidateRevision":self.new,"status":"pending"})
        instance=worker.Worker(self.config,self.state,"install",operation)
        if instance.config.get('managedHome'): instance.environment['FIXTURE_MANAGED_HOME']=instance.config['managedHome']
        if expect_error:
            with self.assertRaises(Exception): instance.main()
        else: instance.main()
        return json.loads((self.state / "requests" / (request+'.json')).read_text())

    def wait_for(self, predicate):
        deadline = time.monotonic() + 10
        while not predicate():
            if time.monotonic() > deadline: self.fail("Timed out waiting for worker fault boundary")
            time.sleep(.02)

    def control(self, action):
        operation = self.status()["operationId"]
        controls = self.state / "controls"; controls.mkdir(mode=0o700, exist_ok=True)
        intent = {"operationId": operation, "requestId": str(uuid.uuid4()), "action": action, "status": "pending"}
        worker.atomic(controls / (operation + ".json"), intent)
        worker.atomic(controls / ("request-" + intent["requestId"] + ".json"), intent)
        return operation

    def test_cancel_staged_check_and_retry_create_a_new_qualification(self):
        self.check()
        operation = self.control("cancel")
        worker.Worker(self.config, self.state, "cancel", operation).main()
        self.assertEqual(self.status()["phase"], "cancelled")
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.old)
        operation = self.control("retry")
        worker.Worker(self.config, self.state, "retry", operation).main()
        self.assertEqual(self.status()["phase"], "ready")
        self.assertNotEqual(self.status()["operationId"], operation)

    def test_saved_cancel_before_check_runs_no_qualification_or_host_hook(self):
        operation = str(uuid.uuid4())
        worker.atomic(self.state / "status.json", {"operationId": operation, "phase": "checking", "checks": [], "message": "Checking"})
        self.control("cancel")
        worker.Worker(self.config, self.state, "check", operation).main()
        self.assertEqual(self.status()["phase"], "cancelled")
        self.assertFalse(self.status()["maintenance"])
        self.assertFalse((self.root / "stages").exists())
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.old)

    def test_sigterm_keeps_orphan_hook_lock_and_cancel_recovers_saved_baseline(self):
        stage = self.check()
        worker.atomic(self.receipt, {"schemaVersion": 1, "revision": self.old, "trackedPatchSha256": None,
            "integrationDigest": "a" * 64, "qualifiedAt": worker.now(), "checks": {"realIntegration": True, "hostRegressions": True}})
        (stage / "pause-install").touch()
        operation, request = str(uuid.uuid4()), str(uuid.uuid4())
        state = self.status(); state.update(operationId=operation, requestId=request, phase="installing", maintenance=True)
        worker.atomic(self.state / "status.json", state)
        worker.atomic(self.state / "requests" / (request + ".json"), {"operationId": operation, "candidateRevision": self.new, "status": "pending"})
        program = Path(worker.__file__).resolve()
        child = subprocess.Popen([sys.executable, str(program), "--config", str(self.config), "--state-dir", str(self.state), "--action", "install", "--operation-id", operation], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_for(lambda: (stage / "install-entered").exists())
            child.send_signal(signal.SIGTERM); child.wait(timeout=5)
            self.assertEqual(child.returncode, -signal.SIGTERM)
            with (self.state / "worker.lock").open("r+") as lock:
                with self.assertRaises(BlockingIOError): fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.control("cancel")
            with self.assertRaises(BlockingIOError): worker.Worker(self.config, self.state, "cancel", operation).main()
            (stage / "resume-install").touch()
            def released():
                with (self.state / "worker.lock").open("r+") as lock:
                    try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB); return True
                    except BlockingIOError: return False
            self.wait_for(released)
            self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.new)
            instance = worker.Worker(self.config, self.state, "cancel", operation)
            instance.environment["FIXTURE_DEPLOYED_RECEIPT"] = str(self.receipt)
            instance.main()
            self.assertEqual(self.status()["phase"], "cancelled")
            self.assertFalse(self.status()["maintenance"])
            self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.old)
            self.assertEqual(json.loads(self.receipt.read_text())["revision"], self.old)
            self.assertEqual(json.loads((self.state / "requests" / (request + ".json")).read_text())["status"], "complete")
            self.assertEqual(json.loads((stage / "recovery.json").read_text())["operationId"], operation)
        finally:
            (stage / "resume-install").touch()
            if child.poll() is None: child.terminate(); child.wait(timeout=5)

    def test_live_install_cancellation_waits_for_boundary_then_restores(self):
        stage = self.check()
        worker.atomic(self.receipt, {"schemaVersion": 1, "revision": self.old, "trackedPatchSha256": None,
            "integrationDigest": "a" * 64, "qualifiedAt": worker.now(), "checks": {"realIntegration": True, "hostRegressions": True}})
        (stage / "pause-install").touch()
        operation, request = str(uuid.uuid4()), str(uuid.uuid4())
        state = self.status(); state.update(operationId=operation, requestId=request, phase="installing", maintenance=True)
        worker.atomic(self.state / "status.json", state)
        worker.atomic(self.state / "requests" / (request + ".json"), {"operationId": operation, "candidateRevision": self.new, "status": "pending"})
        child = subprocess.Popen([sys.executable, worker.__file__, "--config", str(self.config), "--state-dir", str(self.state), "--action", "install", "--operation-id", operation], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_for(lambda: (stage / "install-entered").exists())
            self.control("cancel")
            self.assertIsNone(child.poll())
            self.assertTrue((stage / "gate").exists())
            (stage / "resume-install").touch()
            self.assertEqual(child.wait(timeout=10), 0)
            self.assertEqual(self.status()["phase"], "cancelled")
            self.assertFalse(self.status()["maintenance"])
            self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.old)
            self.assertEqual((stage / "hook-order.txt").read_text().splitlines()[-2:], ["install", "recover"])
        finally:
            (stage / "resume-install").touch()
            if child.poll() is None: child.terminate(); child.wait(timeout=5)

    def test_ambiguous_release_refuses_cancel_without_touching_source_or_gate(self):
        stage = self.check(); (stage / "fail-finish").touch(); self.install(expect_error=True)
        operation = self.control("cancel")
        before = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(RuntimeError, "Admission release"):
            worker.Worker(self.config, self.state, "cancel", operation).main()
        self.assertTrue(self.status()["maintenance"])
        self.assertEqual(self.git("rev-parse", "HEAD"), before)

    def offset_repair(self, artifact=True):
        oauth = self.source / 'oauth.py'
        oauth.write_text(''.join('context-%02d\n' % line for line in range(30)).replace('context-15', 'unrepaired-shared-source'))
        (self.source / 'provider.bin').write_bytes(b'\0original provider')
        (self.source / 'repair-tool.py').write_text('# native repair helper\n')
        self.git('add', '.'); self.git('commit', '-m', 'repair baseline')
        self.old = self.git('rev-parse', 'HEAD').decode().strip()
        oauth.write_text('upstream insertion\n' * 6 + oauth.read_text())
        self.git('add', '.'); self.git('commit', '-m', 'upstream moves repair hunk')
        self.new = self.git('rev-parse', 'HEAD').decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.new)
        self.git('checkout', '--detach', self.old)
        oauth.write_text(oauth.read_text().replace('unrepaired-shared-source', 'approved-shared-source'))
        (self.source / 'provider.bin').write_bytes(b'\0approved provider')
        (self.source / 'repair-tool.py').chmod(0o755)
        (self.source / 'shared_oauth_regression.py').write_text('# exact approved added regression\n')
        self.git('add', '.')
        approved = self.git('diff', 'HEAD', '--binary')
        path = self.root / 'approved-repair.patch'; path.write_bytes(approved); path.chmod(0o600)
        config = json.loads(self.config.read_text()); config['requiredPatchSha256'] = worker.sha(approved)
        if artifact: config['approvedPatchFile'] = str(path)
        worker.atomic(self.config, config)
        # Real Git verifies that the qualification command receives the staged
        # candidate identity, rather than the current checkout's original diff.
        (self.app / 'scripts/spike/run.py').write_text('''import hashlib, subprocess, sys
source = sys.argv[sys.argv.index('--source') + 1]
expected = sys.argv[sys.argv.index('--source-patch-sha256') + 1]
actual = subprocess.check_output(['git','-C',source,'diff','HEAD','--binary'])
assert hashlib.sha256(actual).hexdigest() == expected
print('fixture real candidate patch identity passed')
''')
        return approved, path

    def test_approved_artifact_preserves_repair_across_changed_diff_headers_and_next_upgrade(self):
        approved, path = self.offset_repair()
        stage = self.check(); qualification = self.status()['qualification']
        candidate_patch = worker.git(stage / 'source', 'diff', 'HEAD', '--binary')
        self.assertNotEqual(candidate_patch, approved)
        self.assertEqual(qualification['currentPatchSha256'], worker.sha(approved))
        self.assertEqual(qualification['candidatePatchSha256'], worker.sha(candidate_patch))
        self.assertEqual(json.loads((stage / 'qualification.json').read_text())['trackedPatchSha256'], worker.sha(candidate_patch))
        self.assertEqual((stage / 'preserved.patch').read_bytes(), approved)
        self.install()
        self.assertEqual(self.status()['phase'], 'succeeded')
        self.assertEqual(self.git('diff', 'HEAD', '--binary'), candidate_patch)
        upstream = self.root / 'second-upstream'
        subprocess.run(['git','clone','--no-hardlinks',str(self.source),str(upstream)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        oauth = upstream / 'oauth.py'; oauth.write_text('second upstream insertion\n' + oauth.read_text())
        for argv in (['config','user.email','fixture@example.invalid'], ['config','user.name','Fixture'], ['add','.'], ['commit','-m','next upstream hunk move']):
            subprocess.run(['git','-C',str(upstream),*argv], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD']).decode().strip()
        self.git('fetch', upstream.as_uri(), self.new)
        self.git('update-ref', 'refs/remotes/origin/main', self.new); self.fixture_upstream = upstream
        stage = self.check(); qualification = self.status()['qualification']
        self.assertEqual(qualification['currentPatchSha256'], worker.sha(candidate_patch))
        self.assertNotEqual(qualification['candidatePatchSha256'], worker.sha(candidate_patch))
        self.assertEqual((stage / 'preserved.patch').read_bytes(), approved)
        self.assertEqual(path.read_bytes(), approved)
        self.install()
        self.assertEqual(self.status()['phase'], 'succeeded')
        self.assertEqual((self.source / 'provider.bin').read_bytes(), b'\0approved provider')
        self.assertTrue((self.source / 'repair-tool.py').stat().st_mode & 0o111)
        self.assertEqual((self.source / 'shared_oauth_regression.py').read_text(), '# exact approved added regression\n')

    def test_approved_artifact_merges_over_adjacent_upstream_edits_and_next_upgrade(self):
        approved, path = self.offset_repair()
        # Upstream lints the line beside the repair, as Hermes did to a function signature.
        linted = self.root / 'linted-upstream'
        self.git('worktree', 'add', '--detach', str(linted), self.new)
        oauth = linted / 'oauth.py'
        oauth.write_text(oauth.read_text().replace('context-14\n', 'context-14 linted\n'))
        for argv in (['add', 'oauth.py'], ['commit', '-m', 'upstream lints beside the repair']):
            subprocess.run(['git', '-C', str(linted), *argv], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git', '-C', str(linted), 'rev-parse', 'HEAD']).decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.new)
        stage = self.check()
        staging = next(item for item in self.status()['checks'] if item['id'] == 'staging')
        self.assertIn('Re-applied over nearby upstream edits', staging['detail'])
        candidate = (stage / 'source' / 'oauth.py').read_text()
        self.assertIn('context-14 linted\napproved-shared-source\n', candidate)
        self.assertEqual(worker.repair_changes(worker.git(stage / 'source', 'diff', 'HEAD', '--binary')), worker.repair_changes(approved))
        self.install()
        self.assertEqual(self.status()['phase'], 'succeeded')
        # The next update proves the installed, merged repair against the original approved artifact.
        upstream = self.root / 'second-upstream'
        subprocess.run(['git','clone','--no-hardlinks',str(self.source),str(upstream)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(['git','-C',str(upstream),'reset','--hard',self.new], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        (upstream / 'later.txt').write_text('later upstream change\n')
        for argv in (['config','user.email','fixture@example.invalid'], ['config','user.name','Fixture'], ['add','.'], ['commit','-m','later upstream change']):
            subprocess.run(['git','-C',str(upstream),*argv], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git','-C',str(upstream),'rev-parse','HEAD']).decode().strip()
        self.git('fetch', upstream.as_uri(), self.new)
        self.git('update-ref', 'refs/remotes/origin/main', self.new); self.fixture_upstream = upstream
        self.check()
        self.install()
        self.assertEqual(self.status()['phase'], 'succeeded')
        self.assertIn('context-14 linted\napproved-shared-source\n', (self.source / 'oauth.py').read_text())
        self.assertEqual(path.read_bytes(), approved)

    def linted_upstream(self):
        linted = self.root / 'linted-upstream'
        self.git('worktree', 'add', '--detach', str(linted), self.new)
        oauth = linted / 'oauth.py'
        oauth.write_text(oauth.read_text().replace('context-14\n', 'context-14 linted\n'))
        for argv in (['add', 'oauth.py'], ['commit', '-m', 'upstream lints beside the repair']):
            subprocess.run(['git', '-C', str(linted), *argv], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git', '-C', str(linted), 'rev-parse', 'HEAD']).decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.new)
        return linted

    def test_merged_install_proof_requires_the_receipt_binding(self):
        approved, _ = self.offset_repair(); self.linted_upstream()
        self.check(); self.install()
        receipt = json.loads(self.receipt.read_text())
        self.assertEqual(receipt['repairArtifactSha256'], worker.sha(approved))
        actual = self.git('diff', 'HEAD', '--binary')
        # Equal changed lines prove nothing about where they sit; the receipt binds the exact tree.
        self.assertEqual(worker.repair_changes(actual), worker.repair_changes(approved))
        operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        instance = worker.Worker(self.config, self.state, 'check', operation)
        self.assertEqual(instance.approved_repair(self.new, worker.sha(actual), actual), approved)
        for tampered in ({**receipt, 'repairArtifactSha256': 'f' * 64}, {**receipt, 'trackedPatchSha256': 'e' * 64}, {k: v for k, v in receipt.items() if k != 'repairArtifactSha256'}):
            worker.atomic(self.receipt, tampered)
            with self.subTest(receipt=sorted(tampered)), self.assertRaises(worker.UnsupportedRepair):
                instance.approved_repair(self.new, worker.sha(actual), actual)

    def test_merge_refuses_a_symlinked_directory_in_the_candidate(self):
        approved, _ = self.offset_repair(); linted = self.linted_upstream()
        (self.source / 'tests').mkdir(); (self.source / 'tests/repair_test.py').write_text('# approved added test\n')
        self.git('add', 'tests/repair_test.py')
        approved = self.git('diff', 'HEAD', '--binary')
        path = self.root / 'approved-repair.patch'; path.write_bytes(approved)
        config = json.loads(self.config.read_text()); config['requiredPatchSha256'] = worker.sha(approved); worker.atomic(self.config, config)
        outside = self.root / 'outside'; outside.mkdir()
        (linted / 'tests').symlink_to(outside)
        for argv in (['add', 'tests'], ['commit', '-m', 'upstream symlinks tests']):
            subprocess.run(['git', '-C', str(linted), *argv], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git', '-C', str(linted), 'rev-parse', 'HEAD']).decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.new)
        operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        with self.assertRaises(worker.UnsupportedRepair): worker.Worker(self.config, self.state, 'check', operation).main()
        self.assertEqual(list(outside.iterdir()), [])

    def test_merged_repair_with_different_edits_is_refused(self):
        approved, _ = self.offset_repair()
        operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        instance = worker.Worker(self.config, self.state, 'check', operation)
        oauth = self.source / 'oauth.py'; original = oauth.read_text()
        # Same context drift, but the repair line itself was altered: not the approved repair.
        oauth.write_text(original.replace('approved-shared-source', 'approved-shared-source-altered'))
        actual = self.git('diff', 'HEAD', '--binary')
        with self.assertRaises(worker.UnsupportedRepair): instance.approved_repair(self.old, worker.sha(actual), actual)
        oauth.write_text(original)

    def test_candidate_hash_rollback_restores_the_distinct_current_repair_hash(self):
        approved, _ = self.offset_repair()
        stage = self.check(); (stage / 'fail-verify').touch()
        self.assertNotEqual(self.status()['qualification']['candidatePatchSha256'], worker.sha(approved))
        self.install()
        self.assertEqual(self.status()['phase'], 'rolled_back')
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)
        self.assertEqual(self.git('diff', 'HEAD', '--binary'), approved)

    def test_approved_tree_proof_rejects_content_mode_binary_and_added_file_drift_without_git_mutation(self):
        approved, _ = self.offset_repair()
        operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        instance = worker.Worker(self.config, self.state, 'check', operation)
        def metadata():
            return (self.git('for-each-ref'), (self.source / '.git/index').read_bytes(),
                (self.source / '.git/config').read_bytes(),
                {str(path.relative_to(self.source)): (path.read_bytes(), path.stat().st_mtime_ns) for path in (self.source / '.git/objects').rglob('*') if path.is_file()})
        before = metadata()
        self.assertEqual(instance.approved_repair(self.old, worker.sha(approved), approved), approved)
        self.assertEqual(metadata(), before)
        files = ('oauth.py', 'repair-tool.py', 'provider.bin', 'shared_oauth_regression.py')
        for name in files:
            path = self.source / name; original = path.read_bytes(); mode = path.stat().st_mode
            with self.subTest(path=name):
                if name == 'repair-tool.py': path.chmod(0o644)
                elif name == 'shared_oauth_regression.py': path.unlink()
                else: path.write_bytes(original + b'unapproved byte')
                actual = self.git('diff', 'HEAD', '--binary'); before = metadata()
                with self.assertRaises(worker.UnsupportedRepair): instance.approved_repair(self.old, worker.sha(actual), actual)
                self.assertEqual(metadata(), before)
            path.write_bytes(original); path.chmod(mode)

    def test_missing_artifact_mode_remains_strict_when_upstream_moves_patch_headers(self):
        self.offset_repair(artifact=False)
        operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        with self.assertRaises(worker.UnsupportedRepair): worker.Worker(self.config, self.state, 'check', operation).main()
        self.assertEqual(self.status()['phase'], 'blocked')
        self.assertEqual(self.status()['error'], 'repair_requires_review')

    def test_candidate_repair_conflict_is_blocked_with_clear_reason_and_current_source_unchanged(self):
        approved, _ = self.offset_repair()
        conflicting = self.root / 'conflicting-upstream'
        self.git('worktree', 'add', '--detach', str(conflicting), self.new)
        oauth = conflicting / 'oauth.py'
        oauth.write_text(oauth.read_text().replace('unrepaired-shared-source', 'incompatible-upstream-source'))
        subprocess.run(['git','-C',str(conflicting),'add','oauth.py'], check=True)
        subprocess.run(['git','-C',str(conflicting),'commit','-m','incompatible upstream change'], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git','-C',str(conflicting),'rev-parse','HEAD']).decode().strip()
        self.git('update-ref', 'refs/remotes/origin/main', self.new)
        operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        with self.assertRaises(worker.UnsupportedRepair): worker.Worker(self.config, self.state, 'check', operation).main()
        self.assertEqual(self.status()['phase'], 'blocked')
        self.assertEqual(self.status()['error'], 'repair_requires_review')
        self.assertIn('cannot be applied', self.status()['message'])
        staging = next(item for item in self.status()['checks'] if item['id'] == 'staging')
        self.assertEqual(staging['status'], 'failed')
        self.assertIn('cannot be applied', staging['detail'])
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)
        self.assertEqual(self.git('diff', 'HEAD', '--binary'), approved)
        self.assertNotIn('qualification', self.status())

    def test_approved_artifact_changes_invalidate_qualification_before_host_hooks(self):
        _, path = self.offset_repair()
        stage = self.check(); path.write_bytes(path.read_bytes() + b'changed approved artifact')
        self.install(expect_error=True)
        self.assertEqual((stage / 'hook-order.txt').read_text().splitlines(), ['regressions'])
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)

    def test_approved_artifact_rejects_wrong_original_hash_symlink_and_relative_path(self):
        _, path = self.offset_repair()
        original = path.read_bytes()
        for invalid in ('hash', 'symlink', 'relative'):
            with self.subTest(invalid=invalid):
                config = json.loads(self.config.read_text())
                if invalid == 'hash': path.write_bytes(original + b'wrong original bytes')
                elif invalid == 'symlink':
                    target = self.root / 'actual-repair.patch'; target.write_bytes(original); target.chmod(0o600)
                    path.unlink(); path.symlink_to(target)
                else: config['approvedPatchFile'] = 'approved-repair.patch'; worker.atomic(self.config, config)
                operation = str(uuid.uuid4()); worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
                with self.assertRaises(RuntimeError): worker.Worker(self.config, self.state, 'check', operation).main()
                self.assertNotIn('qualification', self.status())
                if path.is_symlink(): path.unlink()
                path.write_bytes(original); path.chmod(0o600)

    def test_staging_is_complete_and_independent_of_installed_partial_clone(self):
        self.git('tag', '-a', 'v0.1.0', self.old, '-m', 'installed release identity')
        upstream = self.root / 'fixture-upstream'
        self.source.rename(upstream)
        self.fixture_upstream = upstream
        for key in ('uploadpack.allowFilter', 'uploadpack.allowAnySHA1InWant'):
            subprocess.run(['git', '-C', str(upstream), 'config', key, 'true'], check=True)
        subprocess.run(['git', 'clone', '--filter=tree:0', '--no-checkout', upstream.as_uri(), str(self.source)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.git('checkout', '--detach', self.old)
        # Publish the candidate AFTER the current checkout materialized. Its
        # new tree cannot have arrived incidentally with the old checkout.
        (upstream / 'candidate-only.txt').write_text('new candidate tree')
        subprocess.run(['git', '-C', str(upstream), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(upstream), 'commit', '-m', 'candidate after partial clone'],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.new = subprocess.check_output(['git', '-C', str(upstream), 'rev-parse', 'HEAD']).decode().strip()
        subprocess.run(['git', '-C', str(upstream), 'tag', 'v9.0.0', self.new], check=True)
        self.git('fetch', '--no-tags', '--filter=tree:0', 'origin', self.new)
        tree = self.git('cat-file', '-p', self.new).decode().splitlines()[0].split()[1]
        offline = dict(os.environ, GIT_NO_LAZY_FETCH='1')
        missing = subprocess.run(['git', '-C', str(self.source), 'cat-file', '-e', tree], env=offline,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(missing.returncode, 0, 'The fixture must lack the candidate tree')
        self.assertEqual(self.git('config', '--get', 'remote.origin.promisor').decode().strip(), 'true')
        self.git('remote', 'set-url', 'origin', worker.OFFICIAL_UPSTREAM)
        operation = str(uuid.uuid4())
        worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        instance = worker.Worker(self.config, self.state, 'check', operation)
        target = self.root / 'independent-stage'
        with (self.root / 'staging.log').open('w') as output:
            instance.log = output
            instance.stage_source(target, self.new)
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)
        self.assertEqual(worker.git_tag_refs(target), worker.git_tag_refs(self.source))
        self.assertEqual(worker.git(target, 'tag', '--merged', 'HEAD', '--list', 'v[0-9]*').decode().strip(), 'v0.1.0')
        self.assertEqual(worker.git(target, 'rev-list', '--count', 'v0.1.0..HEAD'), self.git('rev-list', '--count', 'v0.1.0..' + self.new))
        self.assertFalse((target / '.git/shallow').exists())
        still_missing = subprocess.run(['git', '-C', str(self.source), 'cat-file', '-e', tree], env=offline,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(still_missing.returncode, 0, 'Staging must not hydrate installed Git objects')
        self.assertFalse((target / '.git/objects/info/alternates').exists())
        self.assertFalse(list((target / '.git/objects/pack').glob('*.promisor')))
        shutil.rmtree(self.source)
        shutil.rmtree(upstream)
        subprocess.run(['git', '-C', str(target), 'fsck', '--full'], env=offline, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(['git', '-C', str(target), 'reset', '--hard', self.new], env=offline, check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual((target / 'candidate-only.txt').read_text(), 'new candidate tree')

    def test_native_version_tag_changes_make_qualification_stale_before_host_hooks(self):
        stage = self.check()
        self.git('tag', 'v9.0.0', self.new)
        self.install(expect_error=True)
        self.assertEqual((stage / 'hook-order.txt').read_text().splitlines(), ['regressions'])
        self.assertEqual(self.git('rev-parse', 'HEAD').decode().strip(), self.old)

    def test_staged_native_version_tag_changes_make_qualification_stale(self):
        stage = self.check()
        subprocess.run(['git', '-C', str(stage / 'source'), 'tag', 'v9.0.0'], check=True)
        self.install(expect_error=True)
        self.assertEqual((stage / 'hook-order.txt').read_text().splitlines(), ['regressions'])

    def test_shallow_installed_history_requires_installer_repair_before_staging(self):
        upstream = self.root / 'fixture-upstream'
        self.source.rename(upstream)
        subprocess.run(['git', 'clone', '--depth=1', upstream.as_uri(), str(self.source)],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        operation = str(uuid.uuid4())
        worker.atomic(self.state / 'status.json', {'operationId': operation, 'phase': 'checking'})
        instance = worker.Worker(self.config, self.state, 'check', operation)
        target = self.root / 'blocked-stage'
        with self.assertRaisesRegex(RuntimeError, 'complete version history'):
            instance.stage_source(target, self.new)
        self.assertFalse(target.exists())

    def test_qualifies_then_installs_exact_tree_with_durable_receipt(self):
        stage=self.check()
        self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.old)
        self.assertFalse(self.receipt.exists())
        receipt=json.loads((stage/'qualification.json').read_text())
        self.assertEqual(receipt['revision'],self.new); self.assertEqual(receipt['checks'],{'realIntegration':True,'hostRegressions':True})
        record=self.install()
        self.assertEqual(self.status()['phase'],'succeeded'); self.assertFalse(self.status()['maintenance'])
        self.assertEqual(record['status'],'complete'); self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.new)
        self.assertFalse((stage/'gate').exists()); self.assertEqual(json.loads(self.receipt.read_text()),receipt)
        self.assertEqual((stage/'hook-order.txt').read_text().splitlines(),['regressions','quiescence','backup','install','verify','finish'])

    def test_failed_verification_restores_previous_source_and_receipt(self):
        stage=self.check(); previous={'private':'previous qualified revision'}; worker.atomic(self.receipt,previous)
        (stage/'fail-verify').touch(); record=self.install()
        self.assertEqual(self.status()['phase'],'rolled_back'); self.assertEqual(record['status'],'complete')
        self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.old)
        self.assertEqual(json.loads(self.receipt.read_text()),previous); self.assertFalse((stage/'gate').exists())
        self.assertEqual((stage/'hook-order.txt').read_text().splitlines()[-3:],['rollback','verify','finish'])

    def test_failed_rollback_verification_keeps_both_admission_gates_and_pending_request(self):
        stage=self.check(); (stage/'fail-verify').touch(); (stage/'fail-rollback-verify').touch()
        record=self.install(expect_error=True)
        self.assertEqual(self.status()['phase'],'failed'); self.assertTrue(self.status()['maintenance'])
        self.assertEqual(record['status'],'pending'); self.assertTrue((stage/'gate').exists())

    def test_uncertain_release_never_rolls_back_after_native_work_may_resume(self):
        stage=self.check(); (stage/'fail-finish').touch(); record=self.install(expect_error=True)
        self.assertEqual(self.status()['phase'],'failed'); self.assertTrue(self.status()['maintenance'])
        self.assertEqual(self.status()['current']['revision'],self.new); self.assertEqual(record['status'],'pending')
        self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.new)
        self.assertNotIn('rollback',(stage/'hook-order.txt').read_text().splitlines())

    def test_stale_source_rejects_before_hooks_and_allows_new_check(self):
        stage=self.check(); self.git('reset','--hard',self.new)
        record=self.install(expect_error=True)
        self.assertEqual(self.status()['phase'],'blocked'); self.assertFalse(self.status()['maintenance'])
        self.assertEqual(record['status'],'complete'); self.assertEqual((stage/'hook-order.txt').read_text().splitlines(),['regressions'])

    def test_known_quiescence_refusal_clears_app_gate_but_unknown_failure_keeps_it(self):
        stage=self.check(); (stage/'refuse').touch(); record=self.install()
        self.assertEqual(self.status()['phase'],'blocked'); self.assertFalse(self.status()['maintenance']); self.assertEqual(record['status'],'complete')
        (stage/'refuse').unlink(); (stage/'uncertain').touch(); record=self.install(expect_error=True)
        self.assertEqual(self.status()['phase'],'failed'); self.assertTrue(self.status()['maintenance']); self.assertEqual(record['status'],'pending')

    def test_tampered_receipt_is_rejected_before_any_install_hook(self):
        stage=self.check(); receipt=json.loads((stage/'qualification.json').read_text()); receipt['checks']['hostRegressions']=False
        worker.atomic(stage/'qualification.json',receipt); self.install(expect_error=True)
        self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.old)
        self.assertEqual((stage/'hook-order.txt').read_text().splitlines(),['regressions'])

    def test_preserved_repair_keeps_staged_added_regression_file_and_exact_diff(self):
        added=self.source/'shared_oauth_regression.py'; added.write_text('# preserved host OAuth regression\n')
        self.git('add',added.name)
        repair=self.git('diff','HEAD','--binary'); digest=worker.sha(repair)
        config=json.loads(self.config.read_text()); config['requiredPatchSha256']=digest; worker.atomic(self.config,config)
        stage=self.check()
        self.assertEqual(worker.git(stage/'source','diff','HEAD','--binary'),repair)
        self.assertEqual(worker.git(stage/'source','ls-files',added.name).decode().strip(),added.name)
        (stage/'fail-verify').touch(); self.install()
        self.assertEqual(self.status()['phase'],'rolled_back')
        self.assertEqual(self.git('diff','HEAD','--binary'),repair)
        self.assertEqual(added.read_text(),'# preserved host OAuth regression\n')

    def test_changed_staged_source_is_rejected_before_any_install_hook(self):
        stage=self.check(); (stage/'source/version').write_text('changed after testing')
        self.install(expect_error=True)
        self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.old)
        self.assertEqual((stage/'hook-order.txt').read_text().splitlines(),['regressions'])

    def test_no_update_is_an_idle_result_without_null_candidate_or_qualification(self):
        self.git('update-ref','refs/remotes/origin/main',self.old)
        operation=str(uuid.uuid4()); worker.atomic(self.state/'status.json',{'operationId':operation,'phase':'checking','checks':[],'message':'Checking'})
        worker.Worker(self.config,self.state,'check',operation).main()
        self.assertEqual(self.status()['phase'],'idle'); self.assertNotIn('candidate',self.status())
        self.assertFalse(self.receipt.exists())

    def test_dependency_changes_cannot_be_qualified_using_the_old_interpreter(self):
        self.git('checkout','--detach',self.new)
        (self.source/'pm').mkdir(); (self.source/'pm/lock.json').write_text('{"dependency":"changed"}')
        self.git('add','.'); self.git('commit','-m','changed dependency lock')
        target=self.git('rev-parse','HEAD').decode().strip(); self.git('update-ref','refs/remotes/origin/main',target)
        self.git('checkout','--detach',self.old)
        operation=str(uuid.uuid4()); worker.atomic(self.state/'status.json',{'operationId':operation,'phase':'checking','checks':[],'message':'Checking'})
        with self.assertRaises(worker.UnsupportedDependencies): worker.Worker(self.config,self.state,'check',operation).main()
        self.assertEqual(self.status()['phase'],'blocked')
        self.assertEqual(self.status()['error'],'dependencies_require_qualification')
        self.assertFalse(self.receipt.exists()); self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.old)

    def test_fixed_host_hook_changes_invalidate_qualification_before_install(self):
        stage=self.check(); hook=self.root/'hook.py'; hook.write_text(hook.read_text()+'\n# changed installer hook\n')
        self.install(expect_error=True)
        self.assertEqual(self.git('rev-parse','HEAD').decode().strip(),self.old)
        self.assertEqual((stage/'hook-order.txt').read_text().splitlines(),['regressions'])

    def test_managed_preparation_qualifies_changed_dependencies_and_binds_returned_launcher(self):
        # Fixture helper validates controller wiring only. The actual helper has
        # separate tests and the final Hermes suite proves activated libraries.
        helper=self.app/'scripts/hermes-qualified-python.py'
        helper.write_text('''import argparse, hashlib, json, pathlib, shlex, sys
def fingerprint(python):
    return {"interpreterSha256":hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest(),"dependenciesSha256":"b"*64}
if __name__=="__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("action")
    for key in ("source","stage","launcher","installed-source","installed-home"): parser.add_argument("--"+key)
    args=parser.parse_args(); stage=pathlib.Path(args.stage)
    marker=json.loads((stage/".agent-interface-upgrade-stage").read_text()); assert marker["state"]=="active"
    launcher=stage/"qualified-python"; launcher.write_text("#!/bin/sh\\nexec "+shlex.quote(sys.executable)+" \\\"$@\\\"\\n"); launcher.chmod(0o700)
    descriptor=stage/"qualified-runtime.json"; descriptor.write_text("{}"); descriptor.chmod(0o600)
    print(json.dumps({"python":str(launcher),"descriptor":str(descriptor),"fingerprint":fingerprint(str(launcher))}))
''')
        self.git('checkout','--detach',self.new); (self.source/'pm').mkdir(); (self.source/'pm/lock.json').write_text('{"dependency":"changed"}')
        self.git('add','.'); self.git('commit','-m','changed dependency lock'); self.new=self.git('rev-parse','HEAD').decode().strip()
        self.git('update-ref','refs/remotes/origin/main',self.new); self.git('checkout','--detach',self.old)
        config=json.loads(self.config.read_text()); config.update(managedLauncher=str(self.root/'fixture-managed-launcher'),managedHome=str(self.root/'fixture-live-home'))
        worker.atomic(self.config,config)
        stage=self.check(); qualification=self.status()['qualification']
        self.assertEqual(qualification['runtimeMode'],'managed'); self.assertEqual(qualification['qualificationPython'],str(stage/'qualified-python'))
        self.assertEqual(qualification['runtimeFingerprint']['dependenciesSha256'],'b'*64)
        self.assertEqual(self.install()['status'],'complete'); self.assertEqual(self.status()['phase'],'succeeded')
        self.assertFalse((self.root/'fixture-live-home/.hermes-update-in-progress').exists())

    def test_native_updater_claim_refuses_foreign_owner_and_never_removes_replacement(self):
        home=self.root/'native-home'; home.mkdir(mode=0o700)
        marker=home/'.hermes-update-in-progress'
        marker.write_text('999999\n0\n'); marker.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError,'Another updater'):
            with worker.NativeUpdateClaim(self.source,home): pass
        self.assertEqual(marker.read_text(),'999999\n0\n')
        marker.unlink()
        with worker.NativeUpdateClaim(self.source,home) as claim:
            claim.refresh(); claim.validate()
            marker.write_text('999999\n0\n')
            with self.assertRaisesRegex(RuntimeError,'claim changed'): claim.validate()
        self.assertEqual(marker.read_text(),'999999\n0\n')

    def test_real_native_guardian_outlives_worker_and_orphan_hook(self):
        native_source = Path(os.environ.get("HERMES_NATIVE_LOCK_SOURCE", str(Path(__file__).resolve().parents[1] / ".private/hermes-integrations-spike/source")))
        if not (native_source / "hermes_cli/update_lock.py").exists(): self.skipTest("Set HERMES_NATIVE_LOCK_SOURCE to an actual prepared Hermes source")
        home = self.root / "actual-native-lock-home"; home.mkdir(mode=0o700)
        entered, resume = self.root / "guardian-entered", self.root / "guardian-resume"
        program = self.root / "guardian-test.py"
        program.write_text(r"""import fcntl,importlib.util,json,os,subprocess,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard_worker',sys.argv[1]); w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
os.umask(0o077)
fd=os.open(sys.argv[2],os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(fd,fcntl.LOCK_EX)
with w.NativeUpdateClaim(sys.argv[3],sys.argv[4]) as claim:
 child=subprocess.Popen([sys.executable,'-c','import pathlib,sys,time\nwhile not pathlib.Path(sys.argv[1]).exists():time.sleep(.02)',sys.argv[6]],pass_fds=(fd,claim.guardian_fd))
 Path(sys.argv[5]).write_text(json.dumps({'guardian':claim.owner_pid,'hook':child.pid}))
 child.wait()
""")
        child = subprocess.Popen([sys.executable, str(program), worker.__file__, str(self.state / "worker.lock"), str(native_source), str(home), str(entered), str(resume)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            self.wait_for(entered.exists)
            guardian = json.loads(entered.read_text())["guardian"]
            marker = home / ".hermes-update-in-progress"
            self.assertEqual(int(marker.read_text().splitlines()[0]), guardian)
            child.send_signal(signal.SIGTERM); child.wait(timeout=5)
            os.kill(guardian, 0)
            with self.assertRaisesRegex(RuntimeError, "Another updater"):
                with worker.NativeUpdateClaim(native_source, home): pass
            with (self.state / "worker.lock").open("r+") as lock:
                with self.assertRaises(BlockingIOError): fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            resume.touch()
            self.wait_for(lambda: not marker.exists())
            previous_mask = os.umask(0o077)
            try:
                with worker.NativeUpdateClaim(native_source, home) as claim: claim.validate()
            finally: os.umask(previous_mask)
        finally:
            resume.touch()
            if child.poll() is None: child.terminate(); child.wait(timeout=5)

    def test_native_best_effort_claim_without_owned_marker_is_rejected(self):
        (self.source/'hermes_cli/update_lock.py').write_text(UPDATE_LOCK.replace('self.acquired=True; return True','return True'))
        with self.assertRaisesRegex(RuntimeError,'claim is unavailable'):
            with worker.NativeUpdateClaim(self.source,self.root/'native-home'): pass

    def test_exact_wrapper_symlinks_are_preserved_and_unknown_source_is_blocked(self):
        target=self.app/'src/hermes/dashboard.py'; target.write_text('# trusted dashboard wrapper')
        gateway=self.app/'src/hermes/gateway_guard.py'; gateway.write_text('# trusted gateway wrapper')
        computer=self.app/'src/hermes/computer_host.py'; computer.write_text('# trusted computer host')
        link=self.source/'agent_interface_dashboard.py'; link.symlink_to(target)
        gateway_link=self.source/'agent_interface_gateway.py'; gateway_link.symlink_to(gateway)
        computer_link=self.source/'agent_interface_computer_host.py'; computer_link.symlink_to(computer)
        stage=self.check(); self.install()
        self.assertEqual(link.resolve(),target.resolve()); self.assertEqual(self.status()['phase'],'succeeded')
        self.assertEqual(gateway_link.resolve(),gateway.resolve()); self.assertEqual(computer_link.resolve(),computer.resolve())
        self.assertEqual(set(self.status()['qualification']['dashboardLink']),set(worker.MANAGED_WRAPPERS))
        (self.source/'unknown.py').write_text('# unreviewed source')
        with self.assertRaisesRegex(RuntimeError,'Untracked'): worker.source_state(self.source,target)

    def test_every_installed_wrapper_link_is_a_managed_wrapper(self):
        # An installer link missing from MANAGED_WRAPPERS blocks every in-app update check.
        root=Path(worker.__file__).resolve().parents[1]
        files=[*root.glob('.agents/tools/*'),*root.glob('src/hermes/*.py'),*root.glob('scripts/*.py'),*root.glob('docs/*.md')]
        named={name for path in files if path.is_file() for name in re.findall(r'agent_interface_[a-z_]+\.py',path.read_text())}
        self.assertIn('agent_interface_computer_host.py',named)
        self.assertLessEqual(named,set(worker.MANAGED_WRAPPERS))
        for name,target in worker.MANAGED_WRAPPERS.items(): self.assertTrue((root/'src/hermes'/target).is_file(),name)

    def test_wrong_gateway_wrapper_target_blocks_source_qualification(self):
        target=self.app/'src/hermes/dashboard.py'; target.write_text('# trusted dashboard wrapper')
        (self.source/'agent_interface_gateway.py').symlink_to(target)
        with self.assertRaisesRegex(RuntimeError,'Untracked'): worker.source_state(self.source,target)

    def test_retains_two_completed_probe_stages_and_never_prunes_active_installed_or_unmarked_paths(self):
        stage=self.check(); state=self.status(); instance=worker.Worker(self.config,self.state,'check',state['operationId'])
        paths=[]
        for index in range(5):
            operation=str(uuid.uuid4()); path=self.root/'stages'/('qualification-'+operation); path.mkdir(mode=0o700)
            marker=path/'.agent-interface-upgrade-stage'; worker.atomic(marker,{'schemaVersion':1,'operationId':operation,'state':'completed'})
            os.utime(marker,ns=(index+1,index+1)); paths.append(path)
        (paths[0]/'backup').mkdir(); (paths[1]/'.agent-interface-upgrade-install').touch()
        active=self.root/'stages'/('qualification-'+str(uuid.uuid4())); active.mkdir(mode=0o700)
        worker.atomic(active/'.agent-interface-upgrade-stage',{'schemaVersion':1,'operationId':active.name.removeprefix('qualification-'),'state':'active'})
        unrelated=self.root/'stages'/'qualification-unmarked'; unrelated.mkdir()
        instance.retain_qualification_stages()
        self.assertTrue(stage.exists()); self.assertTrue(paths[0].exists()); self.assertTrue(paths[1].exists())
        self.assertFalse(paths[2].exists()); self.assertFalse(paths[3].exists()); self.assertTrue(paths[4].exists())
        self.assertTrue(active.exists()); self.assertTrue(unrelated.exists())

if __name__ == '__main__': unittest.main()
