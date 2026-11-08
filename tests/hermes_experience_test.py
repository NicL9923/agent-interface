"""Trial admission/race/recovery behavior with a controlled native scheduler seam.

The actual Hermes store/scheduler qualification lives in experience_probe.py.
"""
import contextlib
import copy
import datetime
import json
import re
import sqlite3
import sys
import threading
import time
import uuid
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from support import load_source

ROOT = Path(__file__).resolve().parents[1]
experience = load_source('src/hermes/experience.py', 'experience_test')


class MemoryRefreshTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'refresh.db'
        self.disk = {'memory': ['Old note'], 'user': ['About me']}
        self.locks = {target: threading.RLock() for target in self.disk}
        self.persisted = {'system_prompt': 'Old note|About me'}
        self.server = types.SimpleNamespace(_invoke_agent=lambda: None)
        self.session = dict(session_key='canonical', running=False, history=[{'role': 'user', 'content': 'earlier', '_row_id': 7}],
                            task_id='root', pending_approval=object(), goal=object())
        owner = self
        class Store:
            def __init__(self): self.load_from_disk()
            def load_from_disk(self): self.loaded = copy.deepcopy(owner.disk)
            def _path_for(self, target): return target
            def _file_lock(self, path): return owner.locks[path]
            def _read_raw_checked(self, path): return '\n§\n'.join(owner.disk[path]), True
            def target_enabled(self, target): return True
            def _mutate(self, target, fn, **kwargs):
                with owner.locks[target]:
                    result = fn(list(owner.disk[target]), 5000)
                    if isinstance(result, dict): return result
                    owner.disk[target] = result[0]
                    return {'success': True}
        self.Store = Store
        def persist(session):
            agent = session['agent']
            agent._cached_system_prompt = agent._build_system_prompt(None)
            self.persisted['system_prompt'] = agent._cached_system_prompt
        self.server._persist_live_session_system_prompt = persist
        self.modules = {
            'tools.memory_tool': types.SimpleNamespace(load_on_disk_store=Store),
            'tools.memory_tool_store': types.SimpleNamespace(ENTRY_DELIMITER='\n§\n', _scan_memory_content=lambda text: False),
        }
        self.patch = patch.dict(sys.modules, self.modules); self.patch.start()
        self.open_journal()
        self.make_agent()

    def open_journal(self):
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(self.path, check_same_thread=False))
        self.refresh = experience.MemoryRefresh(self.journal, self.server, lambda profile: [self.session] if profile == 'default' else [])

    def make_agent(self):
        store = self.Store()
        agent = types.SimpleNamespace(_memory_store=store, _cached_system_prompt=self.persisted['system_prompt'],
            _cached_system_prompt_static='old static', session_id='canonical',
            _session_db=types.SimpleNamespace(get_session=lambda sid: dict(self.persisted), update_system_prompt=lambda *args: None))
        def invalidate():
            agent._cached_system_prompt = None; agent._cached_system_prompt_static = None
            store.load_from_disk()
        def build(_):
            agent._cached_system_prompt_static = 'new static'
            return '|'.join(text for entries in store.loaded.values() for text in entries)
        agent._invalidate_system_prompt = invalidate; agent._build_system_prompt = build
        self.session['agent'] = self.agent = agent

    def tearDown(self):
        self.patch.stop(); self.journal.db.close(); self.directory.cleanup()

    def save(self, text):
        document = experience.profile_memory('default')['documents'][0]
        return experience.mutate_memory(dict(operation='save_memory', profile='default', target='memory',
            revision=document['revision'], entries=[dict(text=text)]), self.refresh)

    def test_edit_during_run_waits_then_rebuilds_and_persists_without_changing_session(self):
        self.refresh.before_turn('default', self.session, self.agent)
        self.session['running'] = True
        before = dict(self.session)
        result = self.save('New note')
        self.assertEqual(result['refresh']['state'], 'pending')
        self.assertTrue(result['refresh']['busy'])
        self.assertEqual(self.agent._memory_store.loaded['memory'], ['Old note'])
        self.assertEqual(self.persisted['system_prompt'], 'Old note|About me')
        self.session['running'] = False
        self.assertEqual(self.refresh.status('default')['state'], 'next_turn')
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.persisted['system_prompt'], 'New note|About me')
        self.assertEqual(self.agent._cached_system_prompt_static, 'new static')
        self.assertEqual(self.refresh.status('default')['state'], 'applied')
        self.assertEqual(self.session, {**before, 'running': False})
        # A subsequent native restore with nonempty canonical history sees the
        # persisted rebuild, rather than resurrecting the old memory snapshot.
        self.assertIn('New note', self.agent._session_db.get_session('canonical')['system_prompt'])

    def test_restart_recovers_unapplied_revision_and_saved_prompt(self):
        revision = self.save('Saved before restart')['refresh']['revision']
        self.journal.db.close(); self.open_journal(); self.make_agent()
        self.assertEqual(self.refresh.status('default')['revision'], revision)
        self.assertEqual(self.refresh.status('default')['state'], 'next_turn')
        self.assertEqual(self.agent._cached_system_prompt, 'Old note|About me')
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertIn('Saved before restart', self.persisted['system_prompt'])
        self.journal.db.close(); self.open_journal(); self.make_agent()
        self.assertEqual(self.refresh.status('default')['state'], 'applied')

    def test_native_persist_swallows_failure_or_missing_methods_never_acknowledge(self):
        self.save('Pending note')
        for persist in (lambda session: None, None):
            self.server._persist_live_session_system_prompt = persist
            with self.assertLogs(experience.__name__, level='WARNING'):
                self.refresh.before_turn('default', self.session, self.agent)
            self.assertEqual(self.refresh.status('default')['state'], 'pending')
            self.assertEqual(self.agent._cached_system_prompt, 'Old note|About me')
            self.assertEqual(self.agent._memory_store.loaded['memory'], ['Old note'])
            self.assertIsNone(getattr(self.agent, '_app_memory_revision', None))

    def test_disk_change_during_build_is_pending_and_next_boundary_retries_latest(self):
        self.save('First edit')
        persist = self.server._persist_live_session_system_prompt
        def racing(session):
            persist(session)
            # An uncooperative external writer can ignore Hermes's locks.
            self.disk['memory'] = ['External edit']
        self.server._persist_live_session_system_prompt = racing
        with self.assertLogs(experience.__name__, level='WARNING'):
            self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.refresh.status('default')['state'], 'pending')
        self.server._persist_live_session_system_prompt = persist
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.persisted['system_prompt'], 'External edit|About me')
        self.assertEqual(self.refresh.status('default')['state'], 'applied')

    def test_cas_failure_does_not_write_refresh_receipt_and_other_profile_is_separate(self):
        with self.assertRaises(experience.ExperienceError):
            experience.mutate_memory(dict(operation='save_memory', profile='default', target='memory', revision='stale', entries=[]), self.refresh)
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM memory_refresh_edits').fetchone()[0], 0)
        self.save('Profile note')
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.refresh.status('other')['state'], 'applied')
        self.assertEqual(self.refresh.status('other')['revision'], '')
        self.assertEqual(self.journal.db.execute('SELECT profile FROM memory_refresh_sessions').fetchall(), [('default',)])

    def test_native_writer_is_serialized_with_app_reload_then_keeps_frozen_prompt(self):
        self.save('First edit')
        entered, attempted, written = threading.Event(), threading.Event(), threading.Event()
        persist = self.server._persist_live_session_system_prompt
        def writer():
            entered.wait(2); attempted.set()
            with self.locks['memory']:
                self.disk['memory'] = ['Later native edit']
                written.set()
        worker = threading.Thread(target=writer); worker.start()
        def building(session):
            entered.set()
            self.assertTrue(attempted.wait(2))
            self.assertFalse(written.is_set(), 'Native write crossed the prompt reload lock')
            persist(session)
        self.server._persist_live_session_system_prompt = building
        self.refresh.before_turn('default', self.session, self.agent)
        worker.join(2); self.assertFalse(worker.is_alive())
        self.assertEqual(self.persisted['system_prompt'], 'First edit|About me')
        self.assertEqual(self.refresh.status('default')['state'], 'applied')
        self.server._persist_live_session_system_prompt = persist
        self.agent._invalidate_system_prompt = Mock(wraps=self.agent._invalidate_system_prompt)
        self.refresh.before_turn('default', self.session, self.agent)
        self.agent._invalidate_system_prompt.assert_not_called()
        self.assertEqual(self.persisted['system_prompt'], 'First edit|About me')

    def test_status_and_native_tool_writes_never_create_app_refresh_requests(self):
        self.agent._invalidate_system_prompt = Mock(wraps=self.agent._invalidate_system_prompt)
        self.refresh.before_turn('default', self.session, self.agent)
        self.disk['memory'].append('A native tool wrote this')
        self.refresh.status('default')
        self.refresh.before_turn('default', self.session, self.agent)
        self.agent._invalidate_system_prompt.assert_not_called()
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM memory_refresh_edits').fetchone()[0], 0)
        self.assertEqual(self.persisted['system_prompt'], 'Old note|About me')

    def test_busy_app_edit_followed_by_native_tool_write_loads_latest_disk_once(self):
        self.session['running'] = True
        revision = self.save('An app edit')['refresh']['revision']
        self.disk['memory'].append('Subsequent native tool edit')
        self.assertEqual(self.refresh.status('default')['revision'], revision)
        self.session['running'] = False
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.persisted['system_prompt'], 'An app edit|Subsequent native tool edit|About me')
        self.assertEqual(self.refresh.status('default')['state'], 'applied')

    def test_other_native_session_is_untouched_even_with_pending_app_edit(self):
        self.save('App edit for Bot Chat')
        native = {**self.session, 'session_key': 'unrelated-native-session'}
        self.agent._invalidate_system_prompt = Mock(wraps=self.agent._invalidate_system_prompt)
        self.refresh.before_turn('default', native, self.agent)
        self.agent._invalidate_system_prompt.assert_not_called()
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM memory_refresh_sessions').fetchone()[0], 0)
        self.assertEqual(self.persisted['system_prompt'], 'Old note|About me')

    def test_restored_acknowledged_agent_uses_persisted_prompt_without_rebuilding(self):
        revision = self.save('Persisted app edit')['refresh']['revision']
        self.refresh.before_turn('default', self.session, self.agent)
        prompt = self.persisted['system_prompt']
        self.disk['memory'].append('Native write after acknowledgement')
        self.journal.db.close(); self.open_journal(); self.make_agent()
        self.agent._cached_system_prompt = None
        self.agent._invalidate_system_prompt = Mock(wraps=self.agent._invalidate_system_prompt)
        self.agent._build_system_prompt = Mock(wraps=self.agent._build_system_prompt)
        self.refresh.before_turn('default', self.session, self.agent)
        self.agent._invalidate_system_prompt.assert_not_called()
        self.agent._build_system_prompt.assert_not_called()
        self.assertEqual(self.persisted['system_prompt'], prompt)
        self.assertEqual(self.refresh.status('default')['revision'], revision)
        self.assertEqual(self.refresh.status('default')['state'], 'applied')

    def test_acknowledged_stale_cache_defers_to_verified_native_restore(self):
        self.save('Persisted app edit')
        self.refresh.before_turn('default', self.session, self.agent)
        self.agent._cached_system_prompt = 'Old note|About me'
        self.agent._build_system_prompt = Mock(wraps=self.agent._build_system_prompt)
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertIsNone(self.agent._cached_system_prompt)
        self.assertIsNone(self.agent._cached_system_prompt_static)
        self.agent._build_system_prompt.assert_not_called()

    def test_native_model_prompt_rewrite_rebuilds_and_acknowledges_once(self):
        revision = self.save('Persisted app edit')['refresh']['revision']
        self.refresh.before_turn('default', self.session, self.agent)
        original_ack = self.refresh.acknowledgement('default', 'canonical')
        native_build = self.agent._build_system_prompt
        self.agent.model = 'switched-model'
        self.agent._build_system_prompt = Mock(side_effect=lambda message: self.agent.model + '|' + native_build(message))
        # The native model-switch path persists its new runtime identity before
        # the next invocation, replacing the digest in the existing receipt.
        self.server._persist_live_session_system_prompt(self.session)
        rewritten = self.persisted['system_prompt']
        self.assertNotEqual(experience.digest(rewritten), original_ack[2])
        self.agent._build_system_prompt.reset_mock()
        self.agent._invalidate_system_prompt = Mock(wraps=self.agent._invalidate_system_prompt)
        session_before = dict(self.session)
        self.refresh.before_turn('default', self.session, self.agent)
        self.agent._invalidate_system_prompt.assert_called_once_with()
        self.agent._build_system_prompt.assert_called_once_with(None)
        self.assertEqual(self.refresh.acknowledgement('default', 'canonical'), (revision, None, experience.digest(rewritten)))
        self.assertEqual(self.refresh.status('default')['state'], 'applied')
        self.assertEqual(self.session, session_before)
        self.assertEqual(self.agent.model, 'switched-model')
        self.assertEqual(self.journal.db.execute('SELECT count(*) FROM memory_refresh_edits').fetchone()[0], 1)
        # A later native tool write still keeps the newly acknowledged prefix.
        self.disk['memory'].append('Native-only edit after model switch')
        self.refresh.before_turn('default', self.session, self.agent)
        self.agent._build_system_prompt.assert_called_once_with(None)
        self.assertEqual(self.persisted['system_prompt'], rewritten)

    def test_missing_acknowledged_prompt_remains_pending_until_persistence_recovers(self):
        self.save('Persisted app edit')
        self.refresh.before_turn('default', self.session, self.agent)
        self.persisted['system_prompt'] = None
        persist = self.server._persist_live_session_system_prompt
        self.server._persist_live_session_system_prompt = lambda session: None
        with self.assertLogs(experience.__name__, level='WARNING'):
            self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.refresh.status('default')['state'], 'pending')
        self.server._persist_live_session_system_prompt = persist
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.persisted['system_prompt'], 'Persisted app edit|About me')
        self.assertEqual(self.refresh.status('default')['state'], 'applied')

    def test_crash_after_native_cas_before_saved_marker_keeps_recoverable_intent(self):
        native_mutate = self.Store._mutate
        def crash_after_write(store, *args, **kwargs):
            native_mutate(store, *args, **kwargs)
            raise SystemExit('Simulated process crash after native CAS')
        with patch.object(self.Store, '_mutate', crash_after_write):
            # Read the revision before installing the crashing native seam.
            revision = experience.digest('default', 'memory', ['Old note'])
            with self.assertRaises(SystemExit):
                experience.mutate_memory(dict(operation='save_memory', profile='default', target='memory', revision=revision, entries=[dict(text='Crash durable app edit')]), self.refresh)
        self.assertEqual(self.journal.db.execute('SELECT state FROM memory_refresh_edits').fetchall(), [('prepared',)])
        self.disk['memory'].append('Later native write')
        self.journal.db.close(); self.open_journal(); self.make_agent()
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.persisted['system_prompt'], 'Crash durable app edit|Later native write|About me')
        self.assertEqual(self.refresh.status('default')['state'], 'applied')

    def test_native_compression_tip_gets_its_own_durable_acknowledgement(self):
        self.save('Current memory')
        self.refresh.before_turn('default', self.session, self.agent)
        # Hermes may compress/rotate its own tip after a turn. Memory refresh
        # follows that native identity without creating a new conversation.
        self.session['session_key'] = self.agent.session_id = 'native-compressed-tip'
        self.refresh.before_turn('default', self.session, self.agent)
        self.assertEqual(self.refresh.status('default')['state'], 'applied')
        self.assertEqual(self.session['task_id'], 'root')
        self.assertEqual(self.session['history'][0]['_row_id'], 7)


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
    def test_a_stopped_trial_ends_its_wait_and_releases_native_admission(self):
        self.runs.start(self.data); self.assertTrue(self.started.wait(2))
        self.assertEqual(self.reservations,1)
        # Stop run cancels the live execution; the trial must not wait for a completion that never comes.
        self.execution.update(status='cancelled', finished_at='2026-10-02T00:00:00+00:00')
        self.wait_done()
        receipt=self.runs.lookup(self.data)
        self.assertEqual((receipt['status'],receipt['message']),('failed','This trial was stopped before it finished.'))
    def test_restarted_receipt_reconciles_a_stopped_trial_as_finished(self):
        receipt=dict(requestId='request',routineId='routine',botId='default',status='accepted',executionId='execution',startedAt=experience.timestamp())
        self.journal.db.execute('INSERT INTO experience_runs VALUES(?,?,?,?,?)',('request','default','routine','one',json.dumps(receipt))); self.journal.db.commit()
        self.execution=dict(id='execution',status='cancelled')
        reconciled=experience.RoutineRuns(self.journal).reconcile(self.data)
        self.assertEqual((reconciled['status'],reconciled['message']),('failed','This trial was stopped before it finished.'))
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


class RoutineRunStatusTests(unittest.TestCase):
    """Each run's normalized status, from the execution ledger when Hermes has one."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.directory = self.home / 'cron/output/routine'
        self.directory.mkdir(parents=True)
        (self.home / 'state.db').write_text('written store')
        self.sessions, self.docs, self.attempts, self.ledger, self.live = [], [], [], [], None
        self.job = None
        self.db = types.SimpleNamespace(list_cron_job_runs=lambda *a, **kw: self.sessions, close=lambda: None)
        executions = types.SimpleNamespace(list_executions=lambda **kw: self.ledger, live_inflight_execution=lambda job_id: self.live)
        self.modules = {
            'hermes_cli.web_routers.cron': types.SimpleNamespace(
                _owner_home_scope=lambda profile: contextlib.nullcontext(),
                _open_session_db_for_profile=lambda profile, **kw: self.db,
                _call_cron_for_profile=lambda *a: self.job,
                _list_cron_output_runs=lambda *a: (self.docs, self.attempts),
                _reconcile_cron_runs=lambda sessions, docs, attempts, job_id, limit: sessions + docs,
                _cron_output_runs_dir=lambda *a: self.directory),
            'hermes_cli.web_routers.sessions': types.SimpleNamespace(_project_for_display=lambda rows, **kw: rows),
            'hermes_cli.web_server_sessions': types.SimpleNamespace(_session_db_path_for_profile=lambda profile: self.home / 'state.db'),
            'hermes_constants': types.SimpleNamespace(get_hermes_home=lambda: self.home),
            'cron': types.SimpleNamespace(executions=executions), 'cron.executions': executions,
        }
        self.patch = patch.dict(sys.modules, self.modules); self.patch.start()
        self.data = dict(operation='routine_results', profile='private', routineId='routine')
    def tearDown(self):
        self.patch.stop(); self.temp.cleanup()
    def results(self):
        return {row['id']: row for row in experience.routine_results(self.data)}

    def test_unified_session_takes_its_executions_status_and_delivery(self):
        self.sessions += [dict(id='local-1', source='cron', title='Brief', started_at=1000.0, ended_at=1060.0, cron_execution_id='e1'),
            dict(id='local-2', source='cron', title='Brief', started_at=500.0, ended_at=560.0, cron_execution_id='e2')]
        self.ledger += [dict(id='e1', status='completed', claimed_at='1970-01-01T00:16:39+00:00', finished_at='1970-01-01T00:17:41+00:00', delivery_outcome='failed'),
            dict(id='e2', status='failed', claimed_at='1970-01-01T00:08:19+00:00', finished_at='1970-01-01T00:09:20+00:00', error='Model refused')]
        rows = self.results()
        self.assertEqual((rows['local-1']['status'], rows['local-1']['deliveryFailed'], rows['local-1']['error']), ('succeeded', True, None))
        self.assertEqual(rows['local-1']['finishedAt'], '1970-01-01T00:17:41+00:00')
        self.assertEqual((rows['local-2']['status'], rows['local-2']['error']), ('failed', 'Model refused'))
        # The row keeps every field older apps read.
        self.assertLessEqual({'id', 'title', 'startedAt', 'preview', 'previewOnly'}, set(rows['local-2']))

    def test_a_stopped_or_missed_run_reads_as_neither_success_nor_failure(self):
        self.sessions += [dict(id='local-3', source='cron', title='Brief', started_at=700.0, ended_at=710.0, cron_execution_id='e3'),
            dict(id='local-4', source='cron', title='Brief', started_at=800.0, ended_at=800.0, cron_execution_id='e4')]
        self.ledger += [dict(id='e3', status='cancelled', claimed_at='1970-01-01T00:11:40+00:00', finished_at='1970-01-01T00:11:50+00:00', error='cancelled on request (Stop)'),
            dict(id='e4', status='missed', claimed_at='1970-01-01T00:13:20+00:00', finished_at='1970-01-01T00:13:20+00:00')]
        rows = self.results()
        self.assertEqual((rows['local-3']['status'], rows['local-4']['status']), ('stopped', 'missed'))

    def test_open_session_is_running_only_while_active(self):
        now = time.time()
        self.sessions += [dict(id='cron_routine_live', source='cron', started_at=now - 30, last_active=now - 5, ended_at=None),
            dict(id='cron_routine_stale', source='cron', started_at=now - 4000, last_active=now - 3600, ended_at=None)]
        rows = self.results()
        self.assertEqual((rows['cron_routine_live']['status'], rows['cron_routine_live']['finishedAt']), ('running', None))
        self.assertEqual(rows['cron_routine_stale']['status'], 'unknown')

    def test_script_document_pairs_with_the_attempt_that_wrote_it(self):
        self.docs.append(dict(id='cron_output:routine:2026-10-02_07-00-05', source='cron_output', title='FAILED · Certificate expired', started_at=2005.0))
        (self.directory / '2026-10-02_07-00-05.md').write_text('Certificate expired')
        self.attempts += [dict(id='e3', status='failed', claimed_at=2000.0, finished_at=2006.0, error='Certificate expired'),
            dict(id='e2', status='completed', claimed_at=1000.0, finished_at=1004.0, error='')]
        row = self.results()['cron_output:routine:2026-10-02_07-00-05']
        self.assertEqual((row['status'], row['error']), ('failed', 'Certificate expired'))
        self.assertEqual((row['startedAt'], row['finishedAt']), ('1970-01-01T00:33:20+00:00', '1970-01-01T00:33:26+00:00'))

    def test_metadata_row_indexes_terminal_attempts(self):
        self.docs.append(dict(id='cron_output:routine:exec:1', source='cron_output', title='COMPLETED · Script-only run', started_at=1004.0))
        self.attempts += [dict(id='e3', status='failed', claimed_at=2000.0, finished_at=2006.0, error='x'),
            dict(id='e2', status='completed', claimed_at=1000.0, finished_at=1004.0, error='')]
        self.assertEqual(self.results()['cron_output:routine:exec:1']['status'], 'succeeded')

    def test_metadata_rows_read_stopped_and_missed_attempts_after_newer_runs(self):
        # Hermes's own reconciliation writes exec:N rows for a stopped script run and a missed occurrence.
        self.docs += [dict(id='cron_output:routine:exec:0', source='cron_output', title='Stopped run', started_at=1000.0),
            dict(id='cron_output:routine:exec:1', source='cron_output', title='Missed run', started_at=1500.0)]
        self.attempts += [dict(id='e1', status='cancelled', claimed_at=1000.0, finished_at=1002.0, error='cancelled on request (Stop)'),
            dict(id='e2', status='missed', claimed_at=1500.0, finished_at=1500.0, error=''),
            dict(id='e3', status='completed', claimed_at=2000.0, finished_at=2006.0, error='')]
        rows = self.results()
        self.assertEqual((rows['cron_output:routine:exec:0']['status'], rows['cron_output:routine:exec:1']['status']), ('stopped', 'missed'))

    def test_an_overlapping_stopped_run_never_takes_a_finished_runs_document(self):
        # Hermes pairs each output document once: A's document stays A's though B started later.
        self.docs.append(dict(id='cron_output:routine:2026-10-02_07-00-19', source='cron_output', title='COMPLETED · A', started_at=1019.0))
        (self.directory / '2026-10-02_07-00-19.md').write_text('A finished')
        self.attempts += [dict(id='a', status='completed', claimed_at=1000.0, finished_at=1020.0, error=''),
            dict(id='b', status='cancelled', claimed_at=1005.0, finished_at=1025.0, error='cancelled on request (Stop)')]
        self.assertEqual(self.results()['cron_output:routine:2026-10-02_07-00-19']['status'], 'succeeded')

    def test_metadata_row_index_counts_unknown_attempts_as_hermes_does(self):
        # Hermes numbers exec:N by position in the whole attempts list, so exec:1 is e2, not e3.
        self.docs.append(dict(id='cron_output:routine:exec:1', source='cron_output', title='COMPLETED · Script-only run', started_at=1004.0))
        self.attempts += [dict(id='e1', status='unknown', claimed_at=500.0, finished_at=None, error=''),
            dict(id='e2', status='completed', claimed_at=1000.0, finished_at=1004.0, error=''),
            dict(id='e3', status='failed', claimed_at=2000.0, finished_at=2006.0, error='x')]
        row = self.results()['cron_output:routine:exec:1']
        self.assertEqual((row['status'], row['error'], row['finishedAt']), ('succeeded', None, '1970-01-01T00:16:44+00:00'))

    def test_older_hermes_without_a_ledger_reads_unknown_except_the_newest_known_run(self):
        del self.modules['cron'], self.modules['cron.executions']
        self.patch.stop(); self.patch = patch.dict(sys.modules, self.modules); self.patch.start()
        sys.modules.pop('cron', None); sys.modules.pop('cron.executions', None)
        self.modules['hermes_cli.web_routers.cron']._list_cron_output_runs = lambda *a: self.docs
        self.modules['hermes_cli.web_routers.cron']._reconcile_cron_runs = lambda sessions, docs, limit: sessions + docs
        self.sessions += [dict(id='cron_routine_2', source='cron', started_at=3000.0, ended_at=3050.0),
            dict(id='cron_routine_1', source='cron', started_at=1000.0, ended_at=1050.0)]
        self.job = dict(last_run_at=3049.0, last_status='delivery_failed')
        rows = self.results()
        self.assertEqual((rows['cron_routine_2']['status'], rows['cron_routine_2']['deliveryFailed']), ('succeeded', True))
        self.assertEqual(rows['cron_routine_1']['status'], 'unknown')
        self.job = dict(last_run_at=9000.0, last_status='ok')
        self.assertEqual(self.results()['cron_routine_2']['status'], 'unknown')

    def test_live_script_attempt_is_a_running_row_with_a_preview(self):
        self.live = dict(id='e9', status='running', claimed_at='1970-01-01T01:00:00+00:00')
        self.ledger.append(self.live)
        rows = self.results()
        running = rows['cron_output:routine:running']
        self.assertEqual((running['status'], running['startedAt'], running['finishedAt']), ('running', '1970-01-01T01:00:00+00:00', None))
        output = experience.routine_results({**self.data, 'operation': 'routine_output', 'resultId': 'cron_output:routine:running'})
        self.assertEqual((output['previewOnly'], output['messages'][0]['text']), (True, 'This run is still in progress.'))
        # An agent run's own open session already stands for the live attempt.
        self.sessions.append(dict(id='local-9', source='cron', started_at=3600.0, last_active=time.time(), ended_at=None, cron_execution_id='e9'))
        self.assertNotIn('cron_output:routine:running', self.results())



class HistoryAttributionTests(unittest.TestCase):
    def setUp(self):
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(':memory:', check_same_thread=False))
        self.journal.db.execute('CREATE TABLE receipts(request_id TEXT,actor TEXT,run_id TEXT,attachments TEXT,input_text TEXT,stored_session TEXT,profile TEXT,row_id INTEGER,created REAL)')
        self.journal.db.execute("INSERT INTO receipts VALUES('run','one',NULL,'[]','Original ask','session','spike',1,1)")
        # Every clone lookup finds rows 1 and 300 as copies of the first occurrence it asks about.
        self.db = types.SimpleNamespace(_read_all=lambda sql, values: [{'id':1,'message_uid':values[0]},{'id':300,'message_uid':values[0]}],close=lambda:None)
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
    def test_page_reads_receipts_and_tool_records_once_and_attributes_each_turn(self):
        self.journal.db.execute('CREATE TABLE tools(id INTEGER PRIMARY KEY,profile TEXT,stored_session TEXT,tool_id TEXT,run_id TEXT,result TEXT,artifacts TEXT)')
        self.journal.db.execute("INSERT INTO receipts VALUES('second','two','run-two','[]','Second ask','session','spike',12,2)")
        self.journal.db.execute("INSERT INTO tools VALUES(NULL,'spike','session','call','run','{\"n\":1}','[{\"path\":\"/fixture/one.pdf\"}]')")
        self.journal.db.execute("INSERT INTO tools VALUES(NULL,'spike','session','call','run-two','{\"n\":2}','[{\"path\":\"/fixture/two.pdf\"}]')")
        page = [{'id':1,'role':'user','content':'First'},{'id':11,'role':'tool','content':'Done','tool_call_id':'call','app_tool_result':{'n':1}},
                {'id':12,'role':'user','content':'Second'},{'id':13,'role':'tool','content':'Done','tool_call_id':'call','app_tool_result':{'n':2}}]
        self.db.get_messages = lambda sid, **kw: [dict(row) for row in page]
        self.db._resume_lineage_ids = lambda sid: ['session']
        sessions = types.SimpleNamespace(_timeline_session_id=lambda db,sid,p:sid,_history_profile_home=lambda p:'/fixture')
        statements = []
        self.journal.db.set_trace_callback(statements.append)
        with patch.dict(sys.modules, {'hermes_cli.web_routers':types.SimpleNamespace(sessions=sessions,analytics=None)}):
            result = experience.discovery({'operation':'history','profile':'spike','sessionId':'session','offset':0},self.journal,
                                          lambda rows, **kw: [dict(row,row_id=row['_row_id'],text=row.get('content','')) for row in rows])
        self.journal.db.set_trace_callback(None)
        messages = result['messages']
        self.assertEqual([message.get('app_sender_id') for message in messages], ['one', None, 'two', None])
        self.assertEqual([message.get('app_artifacts') for message in messages], [None, [{'path':'/fixture/one.pdf'}], None, [{'path':'/fixture/two.pdf'}]])
        self.assertEqual(sum('FROM receipts' in statement for statement in statements), 1)
        self.assertEqual(sum('FROM tools' in statement for statement in statements), 1)
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


class ModelNamesTests(unittest.TestCase):
    def names(self, models, info):
        calls = []
        def get_model_info(provider, model, allow_network=None):
            calls.append((provider, model, allow_network))
            result = info(provider, model)
            return None if result is None else types.SimpleNamespace(name=result)
        module = types.SimpleNamespace(get_model_info=get_model_info)
        with patch.dict(sys.modules, {'agent': types.SimpleNamespace(models_dev=module), 'agent.models_dev': module}):
            return experience.model_names(dict(operation='model_names', profile='default', models=models)), calls

    def test_reads_only_the_cache_and_asks_once_per_pair(self):
        pairs = [dict(provider='anthropic', model='claude-opus-5-5')] * 2 + [dict(provider='openai', model='gpt-6.1-terra')]
        result, calls = self.names(pairs, lambda provider, model: 'Claude Opus 5.5' if provider == 'anthropic' else None)
        self.assertEqual(result['names'], [dict(provider='anthropic', model='claude-opus-5-5', name='Claude Opus 5.5')] * 2
            + [dict(provider='openai', model='gpt-6.1-terra', name=None)])
        self.assertEqual(calls, [('anthropic', 'claude-opus-5-5', False), ('openai', 'gpt-6.1-terra', False)])

    def test_a_name_that_only_echoes_the_slug_or_fails_is_left_for_the_app_to_format(self):
        def info(provider, model):
            if model == 'broken': raise RuntimeError('cache unreadable')
            return {'echo': 'echo', 'blank': '   '}.get(model)
        result, _ = self.names([dict(provider='p', model=model) for model in ('echo', 'blank', 'broken')], info)
        self.assertEqual([row['name'] for row in result['names']], [None, None, None])

    def test_rejects_malformed_or_oversized_requests(self):
        for models in ('x', [dict(provider='p')], [dict(provider='p', model='')], [dict(provider='p', model=3)],
                       [dict(provider='p', model='m')] * (experience.MAX_MODEL_NAMES + 1)):
            with self.subTest(models=str(models)[:40]), self.assertRaises(experience.ExperienceError):
                experience.model_names(dict(models=models))


def strict(**configured):
    """A stand-in Hermes module whose unconfigured attributes fail loudly."""
    class Module(types.SimpleNamespace):
        def __getattr__(self, name):
            if name.startswith('__'): raise AttributeError(name)
            raise AssertionError(f'unexpected Hermes call: {name}')
    return Module(**configured)


class AccountUsageTests(unittest.TestCase):
    """Hermes's provider config, credential pool and usage fetchers are faked at the module boundary; the add-on runs for real.

    The pool fake has no select(): a listing or read that rotated or refreshed a credential would fail loudly.
    """
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(Path(self.directory.name) / 'journal.db', check_same_thread=False))
        self.resets = experience.AccountResets(self.journal)
        experience._account_locks.clear()

    def tearDown(self):
        self.journal.db.close()
        self.directory.cleanup()

    def entry(self, token, base_url=None, status=None):
        return types.SimpleNamespace(runtime_api_key=token, runtime_base_url=base_url, last_status=status)

    def hermes(self, *, main='openai-codex', fallback=(), pools=None, auto='openrouter', snapshots=None, supported=None,
               portal=None, chatgpt=None, refresh=None, legacy=False, home='/srv/hermes/profiles/ranch'):
        pools = {'openai-codex': [self.entry('codex-acct1-a')], 'openrouter': [self.entry('sk-or-1')], 'anthropic': [self.entry('sk-ant-oat-1')], **(pools or {})}
        self.fetched, self.network, self.refreshed = [], [], []
        # Filled in place, so a test holding the dict sees ChatGPT's state and can change it between calls.
        chatgpt = {} if chatgpt is None else chatgpt
        for name, value in (('banked', 2), ('exhausted', True), ('code', None), ('consumed', set())):
            chatgpt.setdefault(name, value)
        config = {'fallback_providers': list(fallback)}
        def fetch(provider, base_url=None, api_key=None, read_only=False, identity_id=None):
            self.fetched.append(dict(provider=provider, base_url=base_url, api_key=api_key, read_only=read_only, identity_id=identity_id))
            value = (snapshots or {})[provider]
            return value(api_key) if callable(value) else value
        def legacy_fetch(provider, *, base_url=None, api_key=None):
            self.fetched.append(dict(provider=provider, api_key=api_key))
            return (snapshots or {})[provider]
        # ChatGPT's reset endpoints, faked at the HTTP client: the add-on's own spend runs for real.
        class Response:
            def __init__(self, body): self.body = body
            def raise_for_status(self): pass
            def json(self): return self.body
        class Client:
            def __init__(self, timeout): pass
            def __enter__(self): return self
            def __exit__(self, *exc): return False
            def get(this, url, headers):
                self.network.append(('GET', url, headers['Authorization'], None))
                if chatgpt.get('on_get'): chatgpt['on_get']()
                if chatgpt.get('get_error'): raise chatgpt['get_error']
                return Response({'banked': chatgpt['banked'], 'exhausted': chatgpt['exhausted']})
            def post(this, url, headers, json):
                # ChatGPT spends once per redeem_request_id and answers a repeat with already_redeemed.
                self.network.append(('POST', url, headers['Authorization'], json))
                code = chatgpt['code']
                if code is None:
                    code = 'already_redeemed' if json['redeem_request_id'] in chatgpt['consumed'] else 'reset'
                    if code == 'reset':
                        chatgpt['consumed'].add(json['redeem_request_id']); chatgpt['banked'] -= 1
                lost = chatgpt.get('lost_answers', 0)
                if lost:
                    # The consume landed; only its answer is lost.
                    chatgpt['lost_answers'] = lost - 1
                    raise RuntimeError('connection reset after send')
                return Response({'code': code})
        guard = lambda payload, available, force: None if force or payload['exhausted'] else types.SimpleNamespace(status='not_exhausted', available_count=available)
        outcome = lambda body, available: types.SimpleNamespace(status=body['code'], available_count=available - 1, windows_reset=2)
        def refresh_matching(api_key_hint=None):
            self.refreshed.append(api_key_hint)
            token = (refresh or {}).get(api_key_hint)
            return self.entry(token) if token else None
        def portal_account(timeout):
            if isinstance(portal, Exception): raise portal
            return portal
        usage = strict(fetch_account_usage=legacy_fetch if legacy else fetch,
                       _fetch_portal_account=portal_account, build_nous_credits_snapshot=lambda account: account.snapshot,
                       _USAGE_FETCHERS={'openai-codex': 1, 'openrouter': 1, 'anthropic': 1},
                       _codex_backend_urls=lambda base: (base + '/usage', base + '/credits', base + '/consume'),
                       _codex_headers=lambda token, account_id: {'Authorization': token},
                       _codex_banked_resets=lambda payload: payload['banked'], _codex_reset_guard=guard, _codex_reset_outcome=outcome)
        cache = strict(has_account_usage=lambda provider: provider in (supported or ('openai-codex', 'openrouter', 'anthropic')))
        pool = strict(STATUS_DEAD='dead', load_pool=lambda provider: strict(entries=lambda: list(pools.get(provider, [])), try_refresh_matching=refresh_matching),
                      _codex_principal_identity=lambda token: ('acct1', 'user') if 'acct1' in token else ('acct2', 'user') if 'acct2' in token else None)
        modules = {
            'hermes_cli': types.SimpleNamespace(), 'hermes_cli.config': strict(load_config_readonly=lambda: config),
            'hermes_cli.runtime_provider': strict(resolve_requested_provider=lambda requested: main),
            'hermes_cli.auth': strict(resolve_provider=lambda requested: auto),
            'hermes_cli.fallback_config': strict(get_fallback_chain=lambda cfg: [dict(entry) for entry in cfg['fallback_providers']],
                                                 resolve_entry_api_key=lambda entry: entry.get('api_key')),
            # Hermes sends pooled ChatGPT rows through its configured route (HERMES_CODEX_BASE_URL); here that route is gateway A.
            'hermes_cli.auth_codex': strict(_codex_pool_route_base_url=lambda base: (base or 'https://chatgpt.com/backend-api/codex').replace('gateway-b', 'gateway-a')),
            'agent': types.SimpleNamespace(account_usage=usage, account_usage_cache=cache, credential_pool=pool),
            'agent.account_usage': usage, 'agent.account_usage_cache': None if legacy else cache, 'agent.credential_pool': pool,
            'hermes_constants': strict(get_hermes_home=lambda: Path(home)),
            'httpx': strict(Client=Client),
        }
        return patch.dict(sys.modules, modules)

    def accounts(self, **options):
        with self.hermes(**options):
            return experience.account_list()['accounts']

    def snapshot(self, **fields):
        return types.SimpleNamespace(**{'plan': None, 'title': 'Account limits', 'windows': (), 'details': (), 'unavailable_reason': None,
            'identity': None, 'raw': None, 'fetched_at': datetime.datetime(2026, 11, 8, 12, tzinfo=datetime.timezone.utc), **fields})

    def test_lists_the_main_route_then_the_effective_fallback_chain_without_selecting_a_credential(self):
        rows = self.accounts(main='auto', fallback=[dict(provider='openai-codex', model='m'), dict(provider='OpenRouter', model='m'), dict(provider='custom', model='m')])
        self.assertEqual([(row['provider'], row['role']) for row in rows], [('openrouter', 'main'), ('openai-codex', 'fallback'), ('custom', 'fallback')])
        self.assertTrue(all(re.fullmatch('[0-9a-f]{32}', row['key']) for row in rows))
        self.assertNotIn('sk-or-1', json.dumps(rows))
        self.assertEqual(rows, self.accounts(main='auto', fallback=[dict(provider='openai-codex', model='m'), dict(provider='OpenRouter', model='m'), dict(provider='custom', model='m')]))

    def test_one_row_per_account_in_a_pool_and_one_for_several_sign_ins_to_the_same_account(self):
        rows = self.accounts(pools={'openai-codex': [self.entry('codex-acct1-a'), self.entry('codex-acct1-b'), self.entry('codex-acct2-a'), self.entry('codex-other-dead', status='dead'), self.entry('')]})
        self.assertEqual(len(rows), 2)
        # A route that names another host is another account, even with the same sign-in.
        rows = self.accounts(pools={'openai-codex': [self.entry('codex-acct1-a'), self.entry('codex-acct1-b', base_url='https://gateway.example/codex')]})
        self.assertEqual(len(rows), 2)

    def test_a_fallback_with_its_own_key_is_its_own_account_and_a_route_without_a_credential_still_shows(self):
        rows = self.accounts(main='openrouter', fallback=[dict(provider='openrouter', model='other', api_key='sk-or-route')], pools={'anthropic': []})
        self.assertEqual([(row['provider'], row['role']) for row in rows], [('openrouter', 'main'), ('openrouter', 'fallback')])
        self.assertNotEqual(*(row['key'] for row in rows))
        empty = self.accounts(main='anthropic')
        self.assertEqual([(row['provider'], row['role']) for row in empty], [('anthropic', 'main')])
        # The same credential as main is the same account, and keeps the main role.
        same = self.accounts(main='openrouter', fallback=[dict(provider='openrouter', model='other')])
        self.assertEqual([row['role'] for row in same], ['main'])

    def test_keys_follow_the_credential_across_profiles(self):
        first, same, other = (self.accounts(main='openrouter', pools={'openrouter': [self.entry(key)]})[0]['key'] for key in ('sk-or-1', 'sk-or-1', 'sk-or-2'))
        self.assertEqual(first, same)
        self.assertNotEqual(first, other)

    def test_reads_each_account_with_its_own_credential_and_never_repairs_it(self):
        snapshot = lambda token: self.snapshot(details=(f'read {token[-1]}',))
        with self.hermes(pools={'openai-codex': [self.entry('codex-acct1-a'), self.entry('codex-acct2-b', base_url='https://gw.example/codex')]}, snapshots={'openai-codex': snapshot}):
            first, second = (row['key'] for row in experience.account_list()['accounts'])
            self.assertEqual(experience.account_usage(dict(key=second))['details'], ['read b'])
            self.assertEqual(experience.account_usage(dict(key=first))['details'], ['read a'])
        # Read-only: Hermes never repairs a failed read by picking or refreshing a credential itself.
        self.assertEqual(self.fetched[0], dict(provider='openai-codex', base_url='https://gw.example/codex', api_key='codex-acct2-b', read_only=True, identity_id='codex:acct2:user'))
        self.assertEqual(self.fetched[1]['api_key'], 'codex-acct1-a')

    def test_normalizes_a_codex_snapshot_and_turns_banked_resets_into_a_count(self):
        window = lambda label, used, scope='account': types.SimpleNamespace(label=label, used_percent=used, scope=scope, detail=None,
            reset_at=datetime.datetime(2026, 11, 8, 17, tzinfo=datetime.timezone.utc))
        codex = self.snapshot(plan='Pro', identity='codex:acct:user', raw={'rate_limit_reset_credits': {'available_count': 2}},
            windows=(window('Session', 120.0), window('Weekly', float('nan'), 'model'), window('Odd', 5, 'weird')),
            details=('You have 2 resets banked - use /usage reset to activate', 'Credits balance: $4.00', 'Top up via /topup'))
        with self.hermes(snapshots={'openai-codex': codex}):
            result = experience.account_usage(dict(key=experience.account_list()['accounts'][0]['key']))
        self.assertEqual(result['bankedResets'], 2)
        self.assertEqual(result['details'], ['Credits balance: $4.00'])
        self.assertEqual([(row['usedPercent'], row['scope']) for row in result['windows']], [(100.0, 'account'), (None, 'model'), (5.0, 'account')])
        self.assertEqual(result['windows'][0]['resetsAt'], '2026-11-08T17:00:00+00:00')
        self.assertEqual((result['plan'], result['unavailableReason'], result['transient']), ('Pro', None, False))
        self.assertRegex(result['identity'], '^[0-9a-f]{32}$')
        self.assertNotIn('acct', json.dumps(result))

    def test_explains_an_account_hermes_cannot_read_and_marks_only_failures_to_retry(self):
        cases = [
            (dict(main='custom', pools={'custom': [self.entry('k')]}), 'does not report', False),
            (dict(main='anthropic', pools={'anthropic': []}), 'no signed-in account', False),
            (dict(main='openrouter', snapshots={'openrouter': None}), 'could not read', True),
            (dict(main='nous', portal=types.SimpleNamespace(logged_in=False)), 'Sign in to Nous Portal', False),
            (dict(main='nous', portal=None), 'Sign in to Nous Portal', False),
            (dict(main='nous', portal=RuntimeError('portal down')), 'could not read', True),
        ]
        for options, reason, transient in cases:
            with self.subTest(reason=reason), self.hermes(**options):
                result = experience.account_usage(dict(key=experience.account_list()['accounts'][0]['key']))
                self.assertIn(reason, result['unavailableReason'])
                self.assertEqual((result['windows'], result['bankedResets'], result['transient']), ([], 0, transient))

    def test_reads_nous_credits_through_the_portal_resolver_whatever_login_it_finds(self):
        account = types.SimpleNamespace(logged_in=True, user_id='portal-user', org_id='org', snapshot=self.snapshot(details=('Top-up credits: $3.00', 'Top up: https://portal')))
        with self.hermes(main='nous', portal=account):
            result = experience.account_usage(dict(key=experience.account_list()['accounts'][0]['key']))
        self.assertEqual(result['details'], ['Top-up credits: $3.00'])
        # The app merges profiles signed in to one Portal account by this digest; the user id never leaves.
        self.assertRegex(result['identity'], '^[0-9a-f]{32}$')
        self.assertNotIn('portal-user', json.dumps(result))

    def test_each_profile_has_its_own_nous_account_until_the_portal_says_whose_it_is(self):
        ranch, garden = (self.accounts(main='nous', home=home)[0]['key'] for home in ('/srv/hermes/profiles/ranch', '/srv/hermes/profiles/garden'))
        self.assertNotEqual(ranch, garden)

    def test_an_explicit_chatgpt_fallback_key_is_read_and_spent_where_the_fallback_names(self):
        with self.hermes(main='openrouter', fallback=[dict(provider='openai-codex', model='m', api_key='codex-acct2-route', base_url='https://gateway-b.example/codex')],
                         snapshots={'openai-codex': self.snapshot()}):
            key = experience.account_list()['accounts'][1]['key']
            experience.account_usage(dict(key=key))
            self.reset(key)
        self.assertEqual(self.fetched[0]['base_url'], 'https://gateway-b.example/codex')
        self.assertEqual({call[1] for call in self.network}, {'https://gateway-b.example/codex/usage', 'https://gateway-b.example/codex/consume'})

    def test_an_older_hermes_without_the_usage_cache_or_read_only_fetches_still_reads(self):
        with self.hermes(main='openrouter', fallback=[dict(provider='spike-fixture', model='m')], pools={'spike-fixture': [self.entry('k')]},
                         snapshots={'openrouter': self.snapshot(details=('Credits balance: $1.00',))}, legacy=True):
            router, fixture = (row['key'] for row in experience.account_list()['accounts'])
            self.assertEqual(experience.account_usage(dict(key=router))['details'], ['Credits balance: $1.00'])
            self.assertIn('does not report', experience.account_usage(dict(key=fixture))['unavailableReason'])
        self.assertEqual(self.fetched, [dict(provider='openrouter', api_key='sk-or-1')])
        # Without read-only fetches, Hermes's resolver can answer a 401 with another pooled ChatGPT account, so it is not asked.
        with self.hermes(legacy=True):
            result = experience.account_usage(dict(key=experience.account_list()['accounts'][0]['key']))
        self.assertIn('Update Hermes', result['unavailableReason'])
        self.assertEqual(self.fetched, [])

    def test_refuses_a_malformed_key_or_one_this_profile_does_not_use(self):
        with self.hermes():
            for key in (None, 'x' * 32, 'A' * 32, 3):
                with self.subTest(key=key), self.assertRaisesRegex(experience.ExperienceError, 'Invalid account') as caught:
                    experience.account_usage(dict(key=key))
                self.assertEqual(caught.exception.status, 400)
            with self.assertRaisesRegex(experience.ExperienceError, 'no longer uses') as caught:
                experience.account_usage(dict(key='0' * 32))
            self.assertEqual(caught.exception.status, 404)
        self.assertEqual(self.fetched, [])

    REQUEST = '6f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b'

    def reset(self, key, request_id=REQUEST, force=False):
        return self.resets.spend(dict(key=key, requestId=request_id, force=force))

    def jwt(self, who, expires_in):
        claims = __import__('base64').urlsafe_b64encode(json.dumps({'exp': time.time() + expires_in}).encode()).decode().rstrip('=')
        return f'header.{claims}.{who}'

    def test_spends_a_reset_with_the_accounts_own_token_and_chatgpts_own_request_id(self):
        with self.hermes(fallback=[dict(provider='openrouter', model='m')]):
            codex, openrouter = (row['key'] for row in experience.account_list()['accounts'])
            first = self.reset(codex)
            self.assertEqual(first, dict(status='reset', message="ChatGPT reset this account's limits.", availableCount=1, windowsReset=2))
            # A retry of the same request answers from its receipt without asking ChatGPT.
            self.assertEqual(self.reset(codex), first)
            with self.assertRaisesRegex(experience.ExperienceError, 'Only ChatGPT') as caught:
                self.reset(openrouter, '7f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b')
            self.assertEqual(caught.exception.status, 409)
            for request_id, force, reason in ((None, False, 'request ID'), ('request-0001', False, 'request ID'), ('8f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b', 'yes', 'Choose whether')):
                with self.subTest(request_id=request_id, force=force), self.assertRaisesRegex(experience.ExperienceError, reason):
                    self.reset(codex, request_id, force)
        base = 'https://chatgpt.com/backend-api/codex'
        self.assertEqual(self.network, [('GET', base + '/usage', 'codex-acct1-a', None), ('POST', base + '/consume', 'codex-acct1-a', {'redeem_request_id': self.REQUEST}),
                                        ('GET', base + '/usage', 'codex-acct1-a', None)])

    def test_hermes_guard_refuses_a_wasted_reset_unless_forced(self):
        with self.hermes(chatgpt={'exhausted': False}):
            key = experience.account_list()['accounts'][0]['key']
            self.assertEqual(self.reset(key)['status'], 'not_exhausted')
            self.assertEqual(self.reset(key, '7f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b', force=True)['status'], 'reset')
        self.assertEqual([call[0] for call in self.network], ['GET', 'GET', 'POST', 'GET'])

    def test_a_consume_whose_answer_was_lost_is_settled_only_by_sending_the_same_id_again(self):
        chatgpt = {'lost_answers': 2}
        with self.hermes(chatgpt=chatgpt):
            key = experience.account_list()['accounts'][0]['key']
            self.assertEqual(self.reset(key)['status'], 'uncertain')
            # A retry never asks Hermes's guard or a usage read to decide it: the first consume may already have
            # emptied the bank. Even with ChatGPT's usage read now failing, it stays uncertain until the consume answers.
            chatgpt['get_error'] = RuntimeError('ChatGPT usage read failed')
            self.assertEqual(self.reset(key)['status'], 'uncertain')
            chatgpt['get_error'] = None
            result = self.reset(key)
            self.assertEqual((result['status'], result['availableCount']), ('already_redeemed', 1))
            # Now recorded: another try never reaches ChatGPT.
            self.assertEqual(self.reset(key), result)
        consumes = [call[3] for call in self.network if call[0] == 'POST']
        self.assertEqual(consumes, [{'redeem_request_id': self.REQUEST}] * 3)
        self.assertEqual(chatgpt['banked'], 1, 'One reset was spent')

    def test_a_failure_before_the_consume_is_a_definite_no(self):
        with self.hermes(chatgpt={'get_error': RuntimeError('ChatGPT unreachable')}):
            key = experience.account_list()['accounts'][0]['key']
            self.assertEqual(self.reset(key)['status'], 'unavailable')
            self.assertEqual(self.reset(key)['status'], 'unavailable')
        self.assertEqual([call[0] for call in self.network], ['GET'])

    def test_a_request_hermes_stopped_during_resumes_where_it_stopped(self):
        owner = experience._digest('openai-codex', 'identity', 'codex:acct1:user')
        for sent, calls in ((0, ['GET', 'POST', 'GET']), (1, ['POST', 'GET'])):
            with self.subTest(sent=sent), self.hermes():
                key = experience.account_list()['accounts'][0]['key']
                request_id = str(uuid.uuid4())
                # A receipt with no answer is what a stop before (sent 0) or after (sent 1) the consume went out leaves.
                with self.journal.lock, self.journal.db:
                    self.journal.db.execute('INSERT INTO account_resets(request_id,account,sent) VALUES(?,?,?)', (request_id, owner, sent))
                self.assertEqual(self.reset(key, request_id)['status'], 'reset')
                self.assertEqual([call[0] for call in self.network], calls)

    def test_an_unrenewable_token_leaves_a_maybe_consumed_reset_uncertain(self):
        old = self.jwt('acct1-old', 30)
        owner = experience._digest('openai-codex', 'identity', 'codex:acct1:user')
        with self.hermes(pools={'openai-codex': [self.entry(old)]}):
            key = experience.account_list()['accounts'][0]['key']
            with self.journal.lock, self.journal.db:
                self.journal.db.execute('INSERT INTO account_resets(request_id,account,sent) VALUES(?,?,1)', (self.REQUEST, owner))
            self.assertEqual(self.reset(key)['status'], 'uncertain')
        self.assertEqual(self.network, [])

    def test_a_request_id_cannot_be_reused_for_another_account(self):
        with self.hermes(pools={'openai-codex': [self.entry('codex-acct1-a'), self.entry('codex-acct2-a')]}):
            first, second = (row['key'] for row in experience.account_list()['accounts'])
            self.reset(first)
            with self.assertRaisesRegex(experience.ExperienceError, 'another reset') as caught:
                self.reset(second)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(len([call for call in self.network if call[0] == 'POST']), 1)

    def test_one_reset_at_a_time_per_account_whichever_sign_in_it_comes_through(self):
        holder = {}
        def during():
            # While this spend is out, a second request through the account's other sign-in is refused.
            with self.assertRaisesRegex(experience.ExperienceError, 'already in progress'):
                self.reset(holder['other'], '7f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b')
        with self.hermes(pools={'openai-codex': [self.entry('codex-acct1-a'), self.entry('codex-acct1-b', base_url='https://gw.example/codex')]}, chatgpt={'on_get': during}):
            first, holder['other'] = (row['key'] for row in experience.account_list()['accounts'])
            self.assertEqual(self.reset(first)['status'], 'reset')
        self.assertEqual(len([call for call in self.network if call[0] == 'POST']), 1)

    def test_a_consume_answer_chatgpt_does_not_document_leaves_the_request_open_and_never_quotes_it(self):
        chatgpt = {'code': 'queued'}
        with self.hermes(chatgpt=chatgpt):
            key = experience.account_list()['accounts'][0]['key']
            result = self.reset(key)
            self.assertEqual(result, dict(status='uncertain', message=experience._RESET_MESSAGES['uncertain'], availableCount=0, windowsReset=0))
            # Unrecorded, so trying again resends the same consume.
            chatgpt['code'] = None
            self.assertEqual(self.reset(key)['status'], 'reset')
        self.assertEqual([call[3] for call in self.network if call[0] == 'POST'], [{'redeem_request_id': self.REQUEST}] * 2)

    def test_a_count_chatgpt_could_not_be_asked_for_is_unknown_not_zero(self):
        chatgpt = {}
        def after_consume():
            if any(call[0] == 'POST' for call in self.network):
                raise RuntimeError('usage read failed after the consume')
        chatgpt['on_get'] = after_consume
        with self.hermes(chatgpt=chatgpt):
            result = self.reset(experience.account_list()['accounts'][0]['key'])
        self.assertEqual((result['status'], result['availableCount']), ('reset', None))

    def test_an_open_receipt_from_before_the_sent_column_is_treated_as_maybe_consumed(self):
        owner = experience._digest('openai-codex', 'identity', 'codex:acct1:user')
        db = sqlite3.connect(Path(self.directory.name) / 'old.db', check_same_thread=False)
        db.execute('CREATE TABLE account_resets(request_id TEXT PRIMARY KEY,account TEXT NOT NULL,result TEXT)')
        db.execute('INSERT INTO account_resets VALUES(?,?,NULL)', (self.REQUEST, owner))
        db.execute('INSERT INTO account_resets VALUES(?,?,?)', ('7f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b', owner, '{"status":"reset"}'))
        db.commit()
        resets = experience.AccountResets(types.SimpleNamespace(lock=threading.RLock(), db=db))
        self.assertEqual(dict(db.execute('SELECT request_id,sent FROM account_resets').fetchall()), {self.REQUEST: 1, '7f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b': 0})
        # Its consume may already have emptied the bank, so it is resent rather than refused by the guard.
        with self.hermes(chatgpt={'exhausted': False}):
            result = resets.spend(dict(key=experience.account_list()['accounts'][0]['key'], requestId=self.REQUEST, force=False))
        self.assertEqual(result['status'], 'reset')
        self.assertEqual([call[0] for call in self.network], ['POST', 'GET'])
        db.close()

    def test_an_expiring_token_is_renewed_only_through_its_own_pool_entry_and_only_as_the_same_account(self):
        old, renewed, other = self.jwt('acct1-old', 30), self.jwt('acct1-new', 3600), self.jwt('acct2-new', 3600)
        with self.hermes(pools={'openai-codex': [self.entry(old)]}, refresh={old: renewed}, snapshots={'openai-codex': self.snapshot()}):
            key = experience.account_list()['accounts'][0]['key']
            self.assertIsNone(experience.account_usage(dict(key=key))['unavailableReason'])
            self.assertEqual(self.reset(key)['status'], 'reset')
        self.assertEqual(self.refreshed, [old, old])
        self.assertEqual((self.fetched[0]['api_key'], self.network[0][2], self.network[1][2]), (renewed, renewed, renewed))
        # A renewal that comes back as another account, or not at all, is never used.
        for refresh in ({old: other}, {}):
            with self.subTest(refresh=refresh), self.hermes(pools={'openai-codex': [self.entry(old)]}, refresh=refresh, snapshots={'openai-codex': self.snapshot()}):
                key = experience.account_list()['accounts'][0]['key']
                self.assertIn('could not renew', experience.account_usage(dict(key=key))['unavailableReason'])
                self.assertEqual(self.reset(key, '7f1d2c3b-4a59-4e7d-8c1b-2a3f4e5d6c7b')['status'], 'unavailable')
                self.assertEqual((self.fetched, self.network), ([], []))

    def test_an_expiring_explicit_fallback_key_is_never_renewed(self):
        old = self.jwt('acct2-route', 30)
        with self.hermes(main='openrouter', fallback=[dict(provider='openai-codex', model='m', api_key=old)], snapshots={'openai-codex': self.snapshot()}):
            key = experience.account_list()['accounts'][1]['key']
            self.assertIn('could not renew', experience.account_usage(dict(key=key))['unavailableReason'])
        self.assertEqual((self.refreshed, self.fetched), ([], []))


if __name__ == '__main__': unittest.main()
