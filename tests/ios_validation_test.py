"""Run the real iOS runner and evidence helper against strict tool I/O fakes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOLS = Path(__file__).resolve().parents[1] / '.agents/tools'


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.tools = self.repo / '.agents/tools'
        self.tools.mkdir(parents=True)
        (self.repo / 'ios').mkdir()
        self.input = self.repo / 'ios/Input.swift'
        self.input.write_text('original source')
        for name in ['validate-ios.sh', 'ios-validation-state.py', 'source-state.py', 'patch-xctestrun.py']:
            shutil.copyfile(TOOLS / name, self.tools / name)
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', 'add', '.'], cwd=self.repo, check=True)
        subprocess.run(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], cwd=self.repo, check=True)
        self.home = self.root / 'home'
        (self.home / '.agents/tools').mkdir(parents=True)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.calls = self.root / 'calls.jsonl'
        self.env = dict(os.environ, HOME=str(self.home), PATH=str(self.bin) + ':' + os.environ['PATH'],
                        TEST_CALLS=str(self.calls), TEST_ROOT=str(self.repo))
        for name in list(self.env):
            if name.startswith(('AGENT_INTERFACE_', 'TEST_RUNNER_', 'SIMCTL_CHILD_', 'SWIFT_', 'XCODE_', 'DYLD_')) or name in {'MAC_HEAVY_LOCK_OWNER', 'IOS_VALIDATION_FRESH', 'DEVELOPER_DIR', 'SDKROOT', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS'}:
                self.env.pop(name)
        self.executable(self.home / '.agents/tools/mac-heavy-lock.sh', '''#!/bin/bash
set -eu
if [[ "$1" == --check-held ]]; then [[ "${TEST_HELD:-}" == 1 ]]; exit $?; fi
printf 'queued\n' >> "$TEST_ROOT/queue.log"
if [[ "${TEST_QUEUED_SOURCE_CHANGE:-}" == 1 ]]; then printf %s "${TEST_QUEUED_SOURCE_VALUE:-changed}" > "$TEST_ROOT/ios/Input.swift"; fi
export TEST_HELD=1
exec "$@"
''')
        self.executable(self.bin / 'xcode-select', '#!/bin/sh\n[ "$1" = -p ] || exit 99\necho /Test/Xcode\n')
        self.executable(self.bin / 'sw_vers', '#!/bin/sh\n[ "$1" = -buildVersion ] || exit 99\necho TestOS\n')
        self.executable(self.bin / 'xcodebuild', '''import sys,os,json,pathlib,plistlib
args=sys.argv[1:]
if args==['-version']:
 print('Xcode '+os.environ.get('TEST_XCODE_VERSION','27.2'));sys.exit(0)
with open(os.environ['TEST_CALLS'],'a') as f:f.write(json.dumps(['xcodebuild',*args])+'\\n')
root=pathlib.Path(os.environ['TEST_ROOT'])
if 'build-for-testing' in args or 'build' in args:
 derived=pathlib.Path(args[args.index('-derivedDataPath')+1]); products=derived/'Build/Products';products.mkdir(parents=True,exist_ok=True)
 if 'build-for-testing' in args:
  with (products/'Fixture.xctestrun').open('wb') as f:plistlib.dump({'UITests':{'IsUITestBundle':True}},f)
elif 'test-without-building' in args:
 if os.environ.get('TEST_XCTEST_SHUTDOWN')=='1':(root/'xctest-shutdown').touch()
 else:
  (root/'xctest-shutdown').unlink(missing_ok=True);(root/'xctest-booted').touch()
 if '-test-timeouts-enabled' not in args:sys.exit('timeouts not specified')
 if os.environ.get('TEST_CHANGE_INPUT')=='1':(root/'ios/Input.swift').write_text('changed during tests')
else:sys.exit('unexpected xcodebuild action')
result=pathlib.Path(args[args.index('-resultBundlePath')+1]);result.mkdir(parents=True,exist_ok=True)
passed=int(os.environ.get('TEST_PASSED','1'));failed=int(os.environ.get('TEST_FAILED','0'))
(result/'evidence.json').write_text(json.dumps({'result':'Passed' if failed==0 else 'Failed','passedTests':passed,'failedTests':failed,'testFailures':[]}))
sys.exit(int(os.environ.get('TEST_NATIVE_EXIT','0')) if 'test-without-building' in args else 0)
''', python=True)
        self.executable(self.bin / 'xcrun', '''import os,sys,pathlib,json
args=sys.argv[1:]; root=pathlib.Path(os.environ['TEST_ROOT'])
if args==['--sdk','iphonesimulator','--show-sdk-build-version']:print('TestSDK');sys.exit(0)
if args[:3]==['simctl','list','devices']:
 devices=[{'udid':'PHONE','state':os.environ['TEST_CLEANUP_STATE'] if (root/'xctest-booted').exists() and 'TEST_CLEANUP_STATE' in os.environ else 'Shutdown' if (root/'xctest-shutdown').exists() else 'Booted' if os.environ.get('TEST_BOOTED')=='1' or (root/'xctest-booted').exists() else 'Shutdown','deviceTypeIdentifier':'TestPhone'}]
 if args[3]=='booted':devices=[d for d in devices if d['state']=='Booted']
 elif args[3] not in ['booted','available']:sys.exit('unexpected device list')
 print(json.dumps({'devices':{'runtime-test':devices}}));sys.exit(0)
if args==['simctl','list','runtimes','--json']:
 print(json.dumps({'runtimes':[{'identifier':'runtime-test','version':'27.0','buildversion':os.environ.get('TEST_RUNTIME_BUILD','TestRuntime')}]}));sys.exit(0)
if args==['simctl','shutdown','PHONE']:
 if (root/'xctest-shutdown').exists():sys.exit(149)
 (root/'xctest-booted').unlink(missing_ok=True);(root/'xctest-shutdown').touch()
 with open(os.environ['TEST_CALLS'],'a') as f:f.write(json.dumps(['xcrun',*args])+'\\n')
 sys.exit(0)
if args[:4]==['xcresulttool','get','test-results','summary']:
 result=pathlib.Path(args[args.index('--path')+1]);print((result/'evidence.json').read_text());sys.exit(0)
sys.exit('unexpected xcrun call: '+repr(args))
''', python=True)

    def executable(self, path, text, python=False):
        path.write_text(('#!' + sys.executable + '\n' if python else '') + text)
        path.chmod(0o755)

    def run_validation(self, operation='test', options=(), timeout=20, **env):
        return subprocess.run(['bash', str(self.tools / 'validate-ios.sh'), 'PHONE', operation, *options],
                              check=False, cwd=self.root, env=dict(self.env, **env), capture_output=True, text=True, timeout=timeout)

    def actions(self):
        return [json.loads(x) for x in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def receipts(self):
        return list((self.repo / '.private/ios-validation-cache').glob('*.json'))

    def test_identical_success_reuses_before_taking_the_lock(self):
        first = self.run_validation(options=['-only-testing:Unit/one'])
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(len(self.receipts()), 1)
        before = self.actions()
        queued = (self.repo / 'queue.log').read_text()
        second = self.run_validation(options=['-only-testing:Unit/one'])
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('Reused successful iOS validation', second.stdout)
        self.assertEqual(self.actions(), before)
        self.assertEqual((self.repo / 'queue.log').read_text(), queued)
        execution = next(a for a in before if 'test-without-building' in a)
        self.assertIn('-test-timeouts-enabled', execution)
        self.assertEqual(execution[execution.index('-test-timeouts-enabled')+1], 'YES')
        self.assertEqual([a for a in before if a[0]=='xcrun'], [['xcrun','simctl','shutdown','PHONE']])

    def test_dirty_untracked_options_runtime_and_toolchain_changes_invalidate(self):
        self.assertEqual(self.run_validation().returncode, 0)
        for change, env, options in [
            (lambda:self.input.write_text('dirty source'), {}, []),
            (lambda:(self.repo/'ios/New.swift').write_text('new source'), {}, []),
            (lambda:None, {}, ['-only-testing:Unit/other']),
            (lambda:None, {'TEST_RUNTIME_BUILD':'Runtime2'}, []),
            (lambda:None, {'TEST_XCODE_VERSION':'27.3'}, []),
            (lambda:None, {'TZ':'UTC'}, []),
        ]:
            change()
            before=len(self.actions())
            p=self.run_validation(options=options, **env)
            self.assertEqual(p.returncode,0,p.stderr)
            self.assertNotIn('Reused successful',p.stdout)
            self.assertGreater(len(self.actions()),before)

    def test_recheck_after_queue_does_not_use_prior_source_evidence(self):
        self.assertEqual(self.run_validation().returncode,0)
        self.input.write_text('different before queue')
        p=self.run_validation(TEST_QUEUED_SOURCE_CHANGE='1')
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertNotIn('Reused successful',p.stdout)
        self.assertEqual(self.input.read_text(),'changed')

    def test_success_completed_while_waiting_is_reused_after_acquisition(self):
        self.assertEqual(self.run_validation().returncode,0)
        before=self.actions()
        self.input.write_text('not cached yet')
        p=self.run_validation(TEST_QUEUED_SOURCE_CHANGE='1',TEST_QUEUED_SOURCE_VALUE='original source')
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertIn('Reused successful',p.stdout)
        self.assertEqual(self.actions(),before)

    def test_failing_fresh_attempt_invalidates_older_success(self):
        self.assertEqual(self.run_validation().returncode,0)
        self.assertEqual(len(self.receipts()),1)
        p=self.run_validation(IOS_VALIDATION_FRESH='1',TEST_NATIVE_EXIT='65')
        self.assertEqual(p.returncode,65,p.stderr)
        self.assertEqual(self.receipts(),[])
        p=self.run_validation()
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertNotIn('Reused successful',p.stdout)

    def test_live_checks_are_not_eligible_for_reuse(self):
        p=subprocess.run([sys.executable,str(self.tools/'ios-validation-state.py'),'eligible','live'],check=False,env=self.env,capture_output=True,text=True)
        self.assertEqual(p.returncode,1)

    def test_changed_inputs_during_tests_fail_and_are_not_reusable(self):
        p=self.run_validation(TEST_CHANGE_INPUT='1')
        self.assertEqual(p.returncode,75,p.stderr)
        self.assertIn('inputs changed',p.stderr)
        self.assertEqual(self.receipts(),[])

    def test_failed_empty_and_corrupt_result_evidence_are_never_cached(self):
        for env in [{'TEST_NATIVE_EXIT':'65'}, {'TEST_FAILED':'1'}, {'TEST_PASSED':'0'}]:
            with self.subTest(env=env):
                p=self.run_validation(**env)
                self.assertEqual(self.receipts(),[])
                if 'TEST_NATIVE_EXIT' in env:self.assertEqual(p.returncode,65)
        p=self.run_validation()
        self.assertEqual(p.returncode,0,p.stderr)
        receipt=self.receipts()[0]
        receipt.write_text('[]')
        p=self.run_validation()
        self.assertNotIn('Reused successful',p.stdout)
        result=Path(json.loads(receipt.read_text())['result'])
        shutil.rmtree(result)
        p=self.run_validation()
        self.assertNotIn('Reused successful',p.stdout)

    def test_capture_repetition_custom_build_flags_and_fresh_runs_do_not_reuse(self):
        self.assertEqual(self.run_validation().returncode,0)
        for options,env in [([],{'IOS_VALIDATION_FRESH':'1'}),([],{'AGENT_INTERFACE_SCREENSHOT_DIR':'/capture'}),([],{'TEST_RUNNER_AGENT_INTERFACE_SCREENSHOT_DIR':'/capture'}),
                            (['-test-iterations','2'],{}),(['OTHER_SWIFT_FLAGS=-I/external'],{}),
                            (['-only-testing','@tests.txt'],{}),([],{ 'SWIFT_EXEC':'/external/compiler'})]:
            with self.subTest(options=options,env=env):
                before=len(self.actions());p=self.run_validation(options=options,**env)
                self.assertEqual(p.returncode,0,p.stderr)
                self.assertNotIn('Reused successful',p.stdout)
                self.assertGreater(len(self.actions()),before)
                self.assertEqual(len(self.receipts()),1)

    def test_build_only_never_touches_a_simulator_and_honors_options(self):
        p=self.run_validation('build',['-jobs','2'])
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertEqual(len(self.actions()),1)
        self.assertEqual(self.actions()[0][-3:],['build','-jobs','2'])
        self.assertEqual(self.receipts(),[])

    def test_existing_device_is_not_shut_down_and_explicit_timeouts_are_respected(self):
        p=self.run_validation(options=['-test-timeouts-enabled','NO'],TEST_BOOTED='1')
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertFalse(any(a[0]=='xcrun' for a in self.actions()))
        execution=next(a for a in self.actions() if 'test-without-building' in a)
        self.assertEqual(execution.count('-test-timeouts-enabled'),1)
        self.assertEqual(execution[execution.index('-test-timeouts-enabled')+1],'NO')

    def test_xctest_already_shutdown_is_success_and_can_be_reused(self):
        p=self.run_validation(TEST_XCTEST_SHUTDOWN='1')
        self.assertEqual(p.returncode,0,p.stderr)
        self.assertFalse(any(a[:3]==['xcrun','simctl','shutdown'] for a in self.actions()))
        self.assertEqual(len(self.receipts()),1)

    def test_unknown_cleanup_state_fails_without_recording_success(self):
        p=self.run_validation(TEST_CLEANUP_STATE='Unknown')
        self.assertNotEqual(p.returncode,0)
        self.assertIn('Cannot clean up selected simulator in state Unknown',p.stderr)
        self.assertEqual(self.receipts(),[])

    def test_cleanup_failure_preserves_test_failure_and_summary(self):
        p=self.run_validation(TEST_NATIVE_EXIT='65',TEST_CLEANUP_STATE='Unknown')
        self.assertEqual(p.returncode,65,p.stderr)
        self.assertIn('Cannot clean up selected simulator in state Unknown',p.stderr)
        summary=next((self.repo/'.private').glob('ios-test-*.txt')).read_text()
        self.assertIn('exit status: 65',summary)
        self.assertIn('cleanup exit status: 1',summary)
        self.assertEqual(self.receipts(),[])

    def test_stalled_shutdown_is_bounded_and_not_cached(self):
        p=self.run_validation(TEST_CLEANUP_STATE='Shutting Down',timeout=40)
        self.assertNotEqual(p.returncode,0)
        self.assertIn('did not shut down within 30 seconds',p.stderr)
        self.assertEqual(self.receipts(),[])

    def test_invalid_device_and_missing_option_value_fail_before_native_execution(self):
        p=subprocess.run(['bash',str(self.tools/'validate-ios.sh'),'UNKNOWN','test'],check=False,env=self.env,capture_output=True,text=True,timeout=8)
        self.assertNotEqual(p.returncode,0)
        self.assertIn('available simulator UUID',p.stderr)
        self.assertEqual(self.actions(),[])
        p=self.run_validation(options=['-only-testing'])
        self.assertNotEqual(p.returncode,0)
        self.assertIn('needs a value',p.stderr)
        self.assertEqual(self.actions(),[])


if __name__=='__main__':unittest.main()
