"""Trial admission/race/recovery behavior with a controlled native scheduler seam.

The actual Hermes store/scheduler qualification lives in experience_probe.py.
"""
import contextlib
import copy
import importlib.util
import json
import sqlite3
import sys
import threading
import time
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('experience_test', ROOT / 'src/hermes/experience.py')
experience = importlib.util.module_from_spec(spec); spec.loader.exec_module(experience)


class TrialTests(unittest.TestCase):
    def setUp(self):
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(':memory:', check_same_thread=False))
        self.runs = experience.RoutineRuns(self.journal)
        self.job = dict(id='routine', name='Dinner', prompt='Plan dinner', schedule=dict(kind='interval', minutes=60), enabled=False, state='paused', paused_at='before', next_run_at=None)
        self.native_lock = threading.RLock()
        self.native_fence = threading.RLock()
        self.claims = 0; self.fires = 0; self.reservations = 0
        self.started = threading.Event(); self.finish = threading.Event()
        self.execution = None
        def with_job(identity, fn, missing=None):
            with self.native_lock:
                return fn([self.job], 0, self.job) if identity == self.job['id'] else missing
        def under_fence(identity, fn):
            with self.native_fence: return fn()
        def claim_fire(identity, *, force, manual):
            self.assertTrue(manual)
            with self.native_fence, self.native_lock:
                self.claims += 1
                if force: self.job.update(enabled=True, state='scheduled', paused_at=None)
                self.job['fire_claim'] = dict(by='owned-attempt')
                self.execution = dict(id='execution', status='running')
                return dict(copy.deepcopy(self.job), execution_id='execution')
        def fire_claimed(job, **kwargs):
            self.fires += 1
            self.assertFalse(self.job['enabled'], 'Paused routine must already be restored before execution')
            self.started.set()
            # Deliberately returns while a detached native owner is still live.
            return True
        def get_execution(identity):
            if self.execution and self.finish.is_set(): self.execution.update(status='completed', finished_at='2026-10-02T00:00:00+00:00')
            return copy.deepcopy(self.execution)
        def acquire(): self.reservations += 1; return True
        def release(): self.reservations -= 1
        retirement = types.SimpleNamespace(acquire=acquire, release=release)
        cron = types.ModuleType('cron'); cron.__path__ = []
        jobs = types.ModuleType('cron.jobs'); jobs._with_job=with_job; jobs._under_fire_fence=under_fence; jobs.save_jobs=lambda _: None
        cron.jobs = jobs
        provider = types.SimpleNamespace(claim_fire=claim_fire, fire_claimed=fire_claimed)
        self.modules = {
            'hermes_cli.backend_retirement': types.SimpleNamespace(retirement=retirement),
            'hermes_cli.web_server_cron': types.SimpleNamespace(_cron_profile_home=lambda p:(p,Path('/fixture')), _cron_store_scope=lambda _:contextlib.nullcontext()),
            'hermes_cli.web_routers.cron': types.SimpleNamespace(_call_cron_for_profile=lambda *args:copy.deepcopy(self.job)),
            'cron': cron, 'cron.jobs':jobs,
            'cron.scheduler_provider': types.SimpleNamespace(resolve_cron_scheduler=lambda:provider),
            'cron.executions':types.SimpleNamespace(get_execution=get_execution),
            'hermes_time':types.SimpleNamespace(now=lambda:__import__('datetime').datetime.now(__import__('datetime').timezone.utc)),
        }
        self.patch = patch.dict(sys.modules, self.modules); self.patch.start()
        self.data = dict(operation='run', profile='default', routineId='routine', requestId='request', senderId='one')
    def tearDown(self):
        self.finish.set()
        deadline=time.time()+3
        while self.reservations and time.time()<deadline: time.sleep(.01)
        self.patch.stop(); self.journal.db.close()
    def wait_done(self):
        deadline=time.time()+3
        while self.reservations and time.time()<deadline: time.sleep(.01)
        self.assertEqual(self.reservations, 0)
    def test_trial_keeps_native_admission_until_detached_owner_finishes_and_deduplicates(self):
        receipt=self.runs.start(self.data)
        self.assertEqual(receipt['status'],'accepted')
        self.assertTrue(self.started.wait(2))
        self.assertEqual(self.reservations,1)
        self.assertEqual(self.runs.start(self.data)['requestId'],'request')
        self.assertEqual(self.claims,1); self.assertEqual(self.fires,1)
        self.assertEqual(self.runs.reconcile(self.data)['status'],'accepted')
        self.finish.set(); self.wait_done()
        self.assertEqual(self.runs.lookup(self.data)['status'],'completed')
        self.assertFalse(self.job['enabled'])
        self.runs.start(self.data); self.assertEqual(self.fires,1)
    def test_native_resume_before_claim_is_preserved_and_trial_does_not_execute(self):
        before=copy.deepcopy(self.job)
        self.job.update(enabled=True,state='scheduled',paused_at=None)
        receipt=dict(requestId='request',routineId='routine',botId='default',status='accepted',startedAt=experience.timestamp())
        self.journal.db.execute('INSERT INTO experience_runs VALUES(?,?,?,?,?)',('request','default','routine','one',json.dumps(receipt))); self.journal.db.commit()
        self.reservations=1
        self.runs.execute(self.data,before)
        self.assertTrue(self.job['enabled']); self.assertEqual(self.claims,0); self.assertEqual(self.fires,0)
        self.assertEqual(self.runs.lookup(self.data)['status'],'failed')
    def test_native_settings_edit_during_execution_is_not_overwritten_on_finish(self):
        self.runs.start(self.data); self.assertTrue(self.started.wait(2))
        self.job.update(enabled=True,state='scheduled',prompt='User changed the prompt')
        self.finish.set(); self.wait_done()
        self.assertTrue(self.job['enabled']); self.assertEqual(self.job['prompt'],'User changed the prompt')
    def test_restart_receipt_reconciles_exact_native_execution_without_replaying(self):
        receipt=dict(requestId='request',routineId='routine',botId='default',status='accepted',executionId='execution',startedAt=experience.timestamp())
        self.journal.db.execute('INSERT INTO experience_runs VALUES(?,?,?,?,?)',('request','default','routine','one',json.dumps(receipt))); self.journal.db.commit()
        self.execution=dict(id='execution',status='completed')
        restarted=experience.RoutineRuns(self.journal)
        self.assertEqual(restarted.lookup(self.data)['status'],'uncertain')
        self.assertEqual(restarted.reconcile(self.data)['status'],'completed')
        self.assertEqual(self.fires,0)
        with self.assertRaises(experience.ExperienceError): restarted.lookup({**self.data,'senderId':'two'})

class RoutineOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.directory = self.home / 'cron/output/routine'
        self.directory.mkdir(parents=True)
        self.db = types.SimpleNamespace(list_cron_job_runs=lambda *a, **kw: [], close=lambda: None)
        self.rows = [dict(id='cron_output:routine:2026-10-02_07-00-00', source='cron_output', title='Run', preview='Short preview')]
        self.scopes = []
        self.modules = {
            'hermes_cli.web_routers.cron': types.SimpleNamespace(
                _owner_home_scope=lambda profile: self.scoped(profile),
                _open_session_db_for_profile=lambda profile, **kw: self.db,
                _call_cron_for_profile=lambda *a: None,
                _list_cron_output_runs=lambda *a: self.rows,
                _reconcile_cron_runs=lambda sessions, docs, limit: sessions + docs,
                _cron_output_runs_dir=lambda *a: self.directory),
            'hermes_cli.web_routers.sessions': types.SimpleNamespace(_project_for_display=lambda rows, **kw: rows),
            'hermes_constants': types.SimpleNamespace(get_hermes_home=lambda: self.home),
        }
        self.patch = patch.dict(sys.modules, self.modules); self.patch.start()
        self.data = dict(operation='routine_output', profile='private', routineId='routine', resultId=self.rows[0]['id'])
    @contextlib.contextmanager
    def scoped(self, profile):
        self.scopes.append(profile); yield
    def tearDown(self):
        self.patch.stop(); self.temp.cleanup()
    def test_reads_full_document_after_job_removed_and_keeps_explicit_profile(self):
        (self.directory / '2026-10-02_07-00-00.md').write_text('Full script output beyond the preview')
        result = experience.routine_results(self.data)
        self.assertFalse(result['previewOnly'])
        self.assertEqual(result['messages'][0]['text'], 'Full script output beyond the preview')
        self.assertEqual(self.scopes, ['private'])
        with self.assertRaises(experience.ExperienceError) as raised:
            experience.routine_results({**self.data, 'resultId': 'unrelated-session'})
        self.assertEqual(raised.exception.status, 404)
    def test_symlink_and_cross_profile_fallback_cannot_expose_native_previews(self):
        outside = self.home / 'other-profile.md'; outside.write_text('Private unrelated output')
        document = self.directory / '2026-10-02_07-00-00.md'; document.symlink_to(outside)
        self.rows[0]['preview'] = outside.read_text()
        self.assertEqual(experience.routine_results({**self.data, 'operation': 'routine_results'}), [])
        with self.assertRaises(experience.ExperienceError): experience.routine_results(self.data)
        document.unlink()
        fallback = self.home / 'other-profile'; fallback.mkdir()
        (fallback / document.name).write_text('Private unrelated output')
        self.directory = fallback
        self.assertEqual(experience.routine_results({**self.data, 'operation': 'routine_results'}), [])
    def test_synthetic_metadata_id_cannot_disguise_a_symlink_document(self):
        outside = self.home / 'other-profile.md'; outside.write_text('Private unrelated output')
        for stem in ('latest', 'exec:1'):
            with self.subTest(stem=stem):
                path = self.directory / (stem + '.md'); path.symlink_to(outside)
                self.rows[0].update(id='cron_output:routine:' + stem, preview=outside.read_text())
                self.assertEqual(experience.routine_results({**self.data, 'operation': 'routine_results'}), [])
                path.unlink()
                self.rows[0]['preview'] = 'Native execution metadata'
                result = experience.routine_results({**self.data, 'resultId': self.rows[0]['id']})
                self.assertEqual(result['messages'][0]['text'], 'Native execution metadata')
    def test_document_size_is_bounded_and_truncation_is_visible(self):
        (self.directory / '2026-10-02_07-00-00.md').write_text('x' * 500001)
        text = experience.routine_results(self.data)['messages'][0]['text']
        self.assertTrue(text.startswith('x' * 500000)); self.assertIn('Output truncated', text)



class HistoryAttributionTests(unittest.TestCase):
    def setUp(self):
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(':memory:', check_same_thread=False))
        self.journal.db.execute('CREATE TABLE receipts(request_id TEXT,actor TEXT,run_id TEXT,attachments TEXT,input_text TEXT,stored_session TEXT,profile TEXT,row_id INTEGER,created REAL)')
        self.journal.db.execute("INSERT INTO receipts VALUES('run','one',NULL,'[]','Original ask','session','spike',1,1)")
        self.db = types.SimpleNamespace(_read_all=lambda sql, values: [{'id':1},{'id':300}],close=lambda:None)
        self.patch = patch.dict(sys.modules, {'hermes_cli.web_server_sessions':types.SimpleNamespace(_open_session_db_for_profile=lambda *a,**kw:self.db)})
        self.patch.start()
    def tearDown(self):
        self.patch.stop();self.journal.db.close()
    def test_exact_occurrence_does_not_adopt_an_older_receipt_for_native_user(self):
        self.assertIsNone(experience.history_receipt(self.journal,'spike',['session'],{'id':2,'role':'user'}))
        self.assertIsNone(experience.history_receipt(self.journal,'spike',['session'],{'id':3,'role':'tool'}))
        self.assertEqual(experience.history_receipt(self.journal,'spike',['session'],{'id':1,'role':'user'})[2],'run')
        self.assertIsNone(experience.history_receipt(self.journal,'other',['session'],{'id':1,'role':'user'}))
    def test_compaction_clone_retains_exact_original_attribution(self):
        self.assertEqual(experience.history_receipt(self.journal,'spike',['session'],{'id':300,'role':'user','message_uid':'same-occurrence'})[2],'run')
        self.assertIsNone(experience.history_receipt(self.journal,'spike',['other-session'],{'id':300,'role':'user','message_uid':'same-occurrence'}))



class HistoryDiscoveryTests(unittest.TestCase):
    setUp = HistoryAttributionTests.setUp
    tearDown = HistoryAttributionTests.tearDown
    def history(self, intervening_user):
        self.journal.db.execute('CREATE TABLE tools(id INTEGER PRIMARY KEY,profile TEXT,stored_session TEXT,tool_id TEXT,run_id TEXT,result TEXT,artifacts TEXT)')
        self.journal.db.execute("INSERT INTO tools VALUES(NULL,'spike','session','same-call','run','{\"success\":true}','[{\"path\":\"/fixture/old.pdf\"}]')")
        previous = [{'id':300,'message_uid':'original-user','role':'user','content':'Ask'}]
        if intervening_user:
            previous.append({'id':2,'role':'user','content':'Native desktop question'})
        tool = {'id':23,'message_uid':'stable-reply','role':'tool','content':'Done','tool_call_id':'same-call','app_tool_result':{'success':True}}
        calls = []
        def messages(sid, **kw):
            calls.append(kw)
            return [dict(tool)] if kw['offset'] == 100 else [dict(row) for row in previous]
        self.db.get_messages = messages
        self.db._resume_lineage_ids = lambda sid: ['session']
        self.db._read_one = lambda *a: None
        sessions = types.SimpleNamespace(_timeline_session_id=lambda db,sid,p:sid,_history_profile_home=lambda p:'/fixture')
        def projector(rows, **kw):
            return [dict(row,row_id=row['_row_id'],text=row.get('content','')) for row in rows]
        with patch.dict(sys.modules, {'hermes_cli.web_routers':types.SimpleNamespace(sessions=sessions,analytics=None)}):
            result = experience.discovery({'operation':'history','profile':'spike','sessionId':'session','offset':100},self.journal,projector)
        self.assertTrue(all(call['include_compacted'] for call in calls))
        self.assertEqual(result['messages'][0]['id'],'stable-reply')
        return result
    def test_page_boundary_uses_nearest_native_user_and_leaves_old_artifacts_unattributed(self):
        result=self.history(True)
        self.assertNotIn('app_artifacts',result['messages'][0])
    def test_page_boundary_clone_resolves_exact_old_run_in_display_order(self):
        result=self.history(False)
        self.assertEqual(result['messages'][0]['app_artifacts'],[{'path':'/fixture/old.pdf'}])

if __name__ == '__main__': unittest.main()
