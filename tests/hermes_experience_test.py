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

if __name__ == '__main__': unittest.main()
