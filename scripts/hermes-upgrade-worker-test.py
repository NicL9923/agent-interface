"""Control-plane proofs using real Git trees and deterministic installer hooks.

These prove durable upgrade/rollback ordering, not Hermes integration. The shipped
worker separately requires the complete real Hermes qualification suite.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("hermes-upgrade-worker.py"))
worker = importlib.util.module_from_spec(spec); spec.loader.exec_module(worker)

HOOK = r'''
import json, os, pathlib, subprocess, sys
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
elif action=='install':
    assert (stage/'gate').exists() and (stage/'backup/revision').exists()
    subprocess.run(['git','-C',str(source),'reset','--hard',os.environ['HERMES_UPGRADE_CANDIDATE']],check=True)
    repair=subprocess.check_output(['git','-C',str(stage/'source'),'diff','HEAD','--binary'])
    if repair: subprocess.run(['git','-C',str(source),'apply','--index','-'],input=repair,check=True)
elif action=='verify':
    if (stage/'fail-verify').exists() and os.environ.get('HERMES_UPGRADE_ROLLBACK')!='1': raise SystemExit(1)
    if (stage/'fail-rollback-verify').exists() and os.environ.get('HERMES_UPGRADE_ROLLBACK')=='1': raise SystemExit(1)
elif action=='rollback':
    subprocess.run(['git','-C',str(source),'reset','--hard',(stage/'backup/revision').read_text()],check=True)
    repair=subprocess.check_output(['git','-C',str(stage/'source'),'diff','HEAD','--binary'])
    if repair: subprocess.run(['git','-C',str(source),'apply','--index','-'],input=repair,check=True)
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
            "hooks":{**{action:[sys.executable,str(hook),action] for action in ['quiescence','backup','install','verify','rollback','finish']},
                "regressions":[[sys.executable,str(hook),'regressions']]}})
        self.original_run = worker.Worker.run
        def run(instance, argv, **kwargs):
            # Keep fetch deterministic and offline. All remaining Git and hook commands run.
            if argv[:4] == ["git", "-C", str(self.source), "fetch"]: return
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

    def test_native_best_effort_claim_without_owned_marker_is_rejected(self):
        (self.source/'hermes_cli/update_lock.py').write_text(UPDATE_LOCK.replace('self.acquired=True; return True','return True'))
        with self.assertRaisesRegex(RuntimeError,'claim is unavailable'):
            with worker.NativeUpdateClaim(self.source,self.root/'native-home'): pass

    def test_exact_dashboard_and_gateway_symlinks_are_preserved_and_unknown_source_is_blocked(self):
        target=self.app/'src/hermes/dashboard.py'; target.write_text('# trusted dashboard wrapper')
        gateway=self.app/'src/hermes/gateway_guard.py'; gateway.write_text('# trusted gateway wrapper')
        link=self.source/'agent_interface_dashboard.py'; link.symlink_to(target)
        gateway_link=self.source/'agent_interface_gateway.py'; gateway_link.symlink_to(gateway)
        stage=self.check(); self.install()
        self.assertEqual(link.resolve(),target.resolve()); self.assertEqual(self.status()['phase'],'succeeded')
        self.assertEqual(gateway_link.resolve(),gateway.resolve())
        self.assertEqual(set(self.status()['qualification']['dashboardLink']),{'agent_interface_dashboard.py','agent_interface_gateway.py'})
        (self.source/'unknown.py').write_text('# unreviewed source')
        with self.assertRaisesRegex(RuntimeError,'Untracked'): worker.source_state(self.source,target)

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
