"""Trial admission/race/recovery behavior with a controlled native scheduler seam.

The actual Hermes store/scheduler qualification lives in experience_probe.py.
"""
import contextlib
import copy
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

from support import load_source

ROOT = Path(__file__).resolve().parents[1]
experience = load_source('src/hermes/experience.py', 'experience_test')


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
            'hermes_cli.web_server_sessions': types.SimpleNamespace(_session_db_path_for_profile=lambda profile: self.home / 'state.db'),
            'hermes_constants': types.SimpleNamespace(get_hermes_home=lambda: self.home),
        }
        (self.home / 'state.db').write_text('written store')
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

    def test_two_documents_keep_both_runs(self):
        (self.directory / '2026-10-02_07-00-00.md').write_text('First output')
        (self.directory / '2026-10-03_07-00-00.md').write_text('Second output')
        self.rows.append({**self.rows[0], 'id': 'cron_output:routine:2026-10-03_07-00-00'})
        results = experience.routine_results({**self.data, 'operation': 'routine_results'})
        self.assertEqual([row['id'] for row in results], [row['id'] for row in self.rows])

    def test_unwritten_profile_store_still_lists_output_documents(self):
        # The unified runtime refuses to open a store no session has written yet,
        # while a script-only run can still save its output document.
        (self.home / 'state.db').write_text('')
        self.modules['hermes_cli.web_routers.cron']._open_session_db_for_profile = lambda *a, **kw: self.fail('opened an unwritten store')
        (self.directory / '2026-10-02_07-00-00.md').write_text('Script output')
        results = experience.routine_results({**self.data, 'operation': 'routine_results'})
        self.assertEqual([row['id'] for row in results], [self.rows[0]['id']])
        self.assertEqual(experience.routine_results(self.data)['messages'][0]['text'], 'Script output')
        self.rows.append(dict(id='cron_routine_session', source='session', title='Run'))
        with self.assertRaises(experience.ExperienceError) as missing:
            experience.routine_results({**self.data, 'resultId': 'cron_routine_session'})
        self.assertEqual(missing.exception.status, 404)


class RoutineLedgerOutputTests(RoutineOutputTests):
    """Exercise the same output and profile fences with the new native contract."""
    def setUp(self):
        super().setUp()
        self.attempts = []
        cron = self.modules['hermes_cli.web_routers.cron']
        cron._list_cron_output_runs = lambda *a: (self.rows, self.attempts)
        def reconcile(sessions, docs, attempts, job_id, limit):
            if self.directory == self.home / 'cron/output/routine':
                self.assertIs(attempts, self.attempts)
            else:
                self.assertEqual(attempts, [])
            self.assertEqual(job_id, 'routine')
            self.assertEqual(limit, 100)
            return sessions + docs + [dict(id=f'cron_output:{job_id}:exec:{i}', source='cron_output', title='Failed run', preview=attempt['error']) for i, attempt in enumerate(attempts)]
        cron._reconcile_cron_runs = reconcile

    def test_pruned_execution_remains_readable_without_a_document(self):
        self.rows.clear()
        self.attempts.append(dict(error='Native execution failed'))
        results = experience.routine_results({**self.data, 'operation': 'routine_results'})
        self.assertEqual([row['id'] for row in results], ['cron_output:routine:exec:0'])
        result = experience.routine_results({**self.data, 'resultId': results[0]['id']})
        self.assertTrue(result['previewOnly'])
        self.assertEqual(result['messages'][0]['text'], 'Native execution failed')

    def test_reconciled_metadata_cannot_disguise_a_symlink_document(self):
        self.rows.clear()
        self.attempts.append(dict(error='Native execution failed'))
        outside = self.home / 'other-profile.md'; outside.write_text('Private unrelated output')
        (self.directory / 'exec:0.md').symlink_to(outside)
        self.assertEqual(experience.routine_results({**self.data, 'operation': 'routine_results'}), [])

    def test_unsafe_directory_never_lists_native_output(self):
        self.directory = self.home / 'other-profile'
        self.modules['hermes_cli.web_routers.cron']._list_cron_output_runs = lambda *a: self.fail('listed another profile directory')
        self.assertEqual(experience.routine_results({**self.data, 'operation': 'routine_results'}), [])



class HistoryAttributionTests(unittest.TestCase):
    def setUp(self):
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(':memory:', check_same_thread=False))
        self.journal.db.execute('CREATE TABLE receipts(request_id TEXT,actor TEXT,run_id TEXT,attachments TEXT,input_text TEXT,stored_session TEXT,profile TEXT,row_id INTEGER,created REAL)')
        self.journal.db.execute("INSERT INTO receipts VALUES('run','one',NULL,'[]','Original ask','session','spike',1,1)")
        self.db = types.SimpleNamespace(_read_all=lambda sql, values: [{'id':1},{'id':300}],close=lambda:None)
        self.temp = tempfile.TemporaryDirectory()
        self.store = Path(self.temp.name) / 'state.db'
        self.store.write_text('written store')
        self.patch = patch.dict(sys.modules, {'hermes_cli.web_server_sessions':types.SimpleNamespace(
            _open_session_db_for_profile=lambda *a,**kw:self.db, _session_db_path_for_profile=lambda profile:self.store)})
        self.patch.start()
    def tearDown(self):
        self.patch.stop();self.journal.db.close();self.temp.cleanup()
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
        self.assertEqual(result['app_prior_prompt']['text'], 'Native desktop question')
    def test_page_boundary_clone_resolves_exact_old_run_in_display_order(self):
        result=self.history(False)
        self.assertEqual(result['messages'][0]['app_artifacts'],[{'path':'/fixture/old.pdf'}])
        self.assertEqual(result['app_prior_prompt']['app_sender_id'], 'one')
    def test_unwritten_profile_store_reads_as_empty_history(self):
        # A new bot's store stays empty until its first session; Hermes no longer creates it on read.
        self.store.write_text('')
        self.db = None
        with patch.dict(sys.modules, {'hermes_cli.web_routers':types.SimpleNamespace(sessions=None,analytics=None)}):
            self.assertEqual(experience.discovery({'operation':'search','profile':'new','query':'synthetic'},self.journal,None),[])
            usage = experience.discovery({'operation':'usage','profile':'new','days':7},self.journal,None)
            self.assertEqual((usage['sessions'],usage['inputTokens'],usage['actualCost']),(0,0,None))
            with self.assertRaises(experience.ExperienceError) as missing:
                experience.discovery({'operation':'history','profile':'new','sessionId':'elsewhere','offset':0},self.journal,None)
            self.assertEqual(missing.exception.status,404)
            with self.assertRaises(experience.ExperienceError) as invalid:
                experience.discovery({'operation':'usage','profile':'new','days':5},self.journal,None)
            self.assertEqual(invalid.exception.status,400)



class HistoryPointerTests(unittest.TestCase):
    def test_finds_visible_uid_after_hidden_rows_and_compression(self):
        rows = [dict(id=i, message_uid=f"uid-{i}", role="assistant", content="text") for i in range(1, 206)]
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.row_factory = sqlite3.Row
        connection.execute("CREATE TABLE messages(id TEXT, session_id TEXT, message_uid TEXT)")
        connection.execute("INSERT INTO messages VALUES ('old-row', 'old', 'uid-205')")
        reads = []
        def messages(sid, **kw):
            self.assertNotIn("limit", kw)
            reads.append(sid)
            return rows
        db = types.SimpleNamespace(
            _resume_lineage_ids=lambda sid: ["old", "tip"],
            _read_one=lambda sql, params: connection.execute(sql, params).fetchone(),
            get_messages=messages)
        def project(page, **kw):
            return [dict(row, row_id=row["id"], display_kind="hidden" if row["id"] == 204 else "conversation") for row in page]
        pointer = experience.history_pointer(db, "tip", ["old-row"], projector=project, profile_home="/fixture")
        self.assertEqual(pointer, {"messageId": "uid-205", "offset": 200})
        self.assertEqual(reads, ["tip"], "A locator must merge native compression lineage only once")
        self.assertIsNone(experience.history_pointer(db, "tip", ["204"], projector=project, profile_home="/fixture"))
        self.assertIsNone(experience.history_pointer(db, "tip", ["missing"], projector=project, profile_home="/fixture"))


    def test_search_pointers_are_cheap_and_optional(self):
        hits = [dict(sessionId="retired"), dict(sessionId="live")]
        def resolve(db, sid, profile):
            if sid == "retired":
                raise RuntimeError("retired native session")
            return sid
        sessions = types.SimpleNamespace(_timeline_session_id=resolve)
        db = types.SimpleNamespace(_resume_lineage_ids=lambda sid: ["old", sid],
            search_messages=lambda **kw: [dict(id=205, session_id="old")],
            get_messages=lambda *args, **kw: self.fail("Search must not scan history pages"))
        experience.enrich_search_pointers(db, hits, [], sessions, "profile", "synthetic")
        self.assertNotIn("messageId", hits[0]); self.assertEqual(hits[1]["messageId"], "205")
        db.search_messages = lambda **kw: (_ for _ in ()).throw(ValueError("unsupported native FTS query"))
        untouched = [dict(sessionId="live", title="Still useful")]
        experience.enrich_search_pointers(db, untouched, [], sessions, "profile", 'foo"')
        self.assertEqual(untouched, [dict(sessionId="live", title="Still useful")])

    def test_attachment_tool_pointer_is_only_assigned_when_unambiguous(self):
        hits = [dict(sessionId="live")]
        db = types.SimpleNamespace(_resume_lineage_ids=lambda sid: [sid], search_messages=lambda **kw: [],
            _read_all=lambda *args: [dict(identity="stable")])
        sessions = types.SimpleNamespace(_timeline_session_id=lambda db, sid, profile: sid)
        files = [("live", "artifact.pdf", None, "tool")]
        experience.enrich_search_pointers(db, hits, files, sessions, "profile", "artifact.pdf")
        self.assertEqual(hits[0]["messageId"], "stable")
        db._read_all = lambda *args: [dict(identity="first-run"), dict(identity="second-run")]
        hits = [dict(sessionId="live")]
        experience.enrich_search_pointers(db, hits, files, sessions, "profile", "artifact.pdf")
        self.assertNotIn("messageId", hits[0])


if __name__ == '__main__': unittest.main()
