"""Automation boundary tests. Real native persistence is exercised by automation_probe.py."""
import contextlib
import asyncio
import copy
import importlib.util
import json
import os
import sqlite3
import sys
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('automation_test', ROOT / 'src/hermes/automation.py')
automation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(automation)


def module(name, **fields):
    result = types.ModuleType(name)
    result.__dict__.update(fields)
    return result


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=self.db)
        self.session = dict(session_key='canonical', running=False, history_lock=threading.Lock())
        self.server = types.SimpleNamespace(_sessions={'live': self.session}, _sessions_lock=threading.Lock())
        self.value = dict(session_id='live', open_requests=[])
        self.maintenance = False
        self.entries = []
        self.entered = 0
        self.registry_locked = False
        self.gate = dict(stored='canonical', running=False, current=None, interrupted=False)
        self.journal.submission_state = lambda *_: dict(self.gate)
        self.receipts = {}
        self.journal.receipt = lambda key: self.receipts.get(key)
        self.goal_state = types.SimpleNamespace(goal='Repair fence', created_at=123, status='paused', turns_used=7, max_turns=7, paused_reason=None)
        @contextlib.contextmanager
        def file_lock(*_):
            self.registry_locked = True
            self.entered += 1
            try:
                yield
            finally:
                self.registry_locked = False
        def read_entries(*args, **kwargs):
            self.assertTrue(self.registry_locked)
            return list(self.entries)
        def same_writer(entry, metadata):
            self.assertTrue(self.registry_locked)
            return entry.get('pid') == os.getpid() and entry.get('metadata', {}).get('live_session_id') == metadata['live_session_id']
        active = module('hermes_cli.active_sessions', _lease_paths=lambda **_: ('state', 'lock'), _FileLock=file_lock,
            _read_entries=read_entries, _prune_dead=lambda entries, **_: entries, _is_same_writer=same_writer)
        self.modules = {
            'tui_gateway': module('tui_gateway'),
            'tui_gateway.server_requests': module('tui_gateway.server_requests', _lock=threading.RLock(), _open={}),
            'hermes_cli': module('hermes_cli', active_sessions=active),
            'hermes_cli.active_sessions': active,
            'hermes_constants': module('hermes_constants', get_hermes_home=lambda: Path('/synthetic/profile')),
        }
        self.modules['tui_gateway'].server_requests = self.modules['tui_gateway.server_requests']
        self.patcher = patch.dict(sys.modules, self.modules)
        self.patcher.start()
        self.controller = automation.Controller(self.server, lambda *_: {'profiles': [{'name': 'ranch'}, {'name': 'private'}]},
            lambda *_: {'result': self.value}, threading.RLock(), threading.RLock(), lambda: self.maintenance, self.journal)

    def tearDown(self):
        self.patcher.stop()
        self.db.close()

    def test_admission_stops_a_background_compaction_before_reading_busy_state(self):
        # A background compaction holds the session running; it is no work to refuse a change for.
        preempted = []
        def preempt(sid):
            preempted.append(sid)
            self.session.pop('running', None)
            return True
        controller = automation.Controller(self.server, lambda *_: {'profiles': [{'name': 'ranch'}]}, lambda *_: {'result': self.value},
            threading.RLock(), threading.RLock(), lambda: self.maintenance, self.journal, None, preempt)
        self.session['running'] = True
        with controller.admitted('ranch'):
            self.assertEqual(preempted, [self.value['session_id']])

    def test_admission_refuses_running_queued_unanswered_and_native_leased_owners(self):
        for key in ('running', 'queued_prompt', 'pending_steer', '_auto_continue_scheduled', '_compute_host_open_request'):
            self.session[key] = True
            with self.assertRaisesRegex(automation.AutomationError, 'active work'):
                with self.controller.admitted('ranch'):
                    self.fail('mutation admitted')
            del self.session[key]
        self.value['open_requests'] = [{'id': 'approval'}]
        with self.assertRaisesRegex(automation.AutomationError, 'unanswered'):
            with self.controller.admitted('ranch'):
                self.fail('mutation admitted')
        self.value['open_requests'] = []
        self.entries = [dict(session_id='canonical', lease_id='foreign', pid=os.getpid() + 1)]
        with self.assertRaisesRegex(automation.AutomationError, 'Another native executor'):
            with self.controller.admitted('ranch'):
                self.fail('mutation admitted')
        self.entries = []
        with self.controller.admitted('ranch'):
            self.assertGreater(self.entered, 0)
        self.maintenance = True
        with self.assertRaisesRegex(automation.AutomationError, 'upgraded'):
            with self.controller.admitted('ranch'):
                self.fail('mutation admitted')

    def test_roster_rejects_unknown_profiles_and_unknown_operations(self):
        with self.assertRaises(automation.AutomationError):
            self.controller.run(dict(profile='ranch', visibleProfiles=['ranch'], operation='arbitrary.shell'))
        with self.assertRaises(automation.AutomationError):
            self.controller.roster(dict(profile='private', visibleProfiles=['ranch']))
        self.assertEqual(self.controller.roster(dict(profile='ranch', visibleProfiles=['ranch', 'invented'])), {'ranch'})

    def test_goal_creation_is_saved_paused_in_one_native_write(self):
        states = {}
        class Manager:
            def __init__(self, session_id): self.key = session_id
            @property
            def state(self): return states.get(self.key)
            def refresh(self): pass
            def set(self, title, max_turns):
                states[self.key] = types.SimpleNamespace(goal=title, status='active', turns_used=3, max_turns=max_turns, paused_reason=None)
            def pause(self, reason='user-paused'): self.state.status, self.state.paused_reason = 'paused', reason
            def resume(self, reset_budget=True):
                self.state.status = 'active'
                if reset_budget: self.state.turns_used = 0
            def clear(self): states.pop(self.key, None)
        with patch.dict(sys.modules, {'hermes_cli.goals': module('hermes_cli.goals', GoalManager=Manager, GoalState=lambda **fields: types.SimpleNamespace(turns_used=0, **fields), save_goal=lambda key, state: states.__setitem__(key, state))}):
            goal = self.controller.goal('ranch', 'goal_set', dict(title='Repair fence', maxTurns=20))
            self.assertEqual((goal['status'], goal['maxTurns']), ('paused', 20))
            self.assertEqual(self.controller.goal('ranch')['status'], 'paused')

    def goals_module(self):
        owner = self
        class Manager:
            def __init__(self, session_id): self.key = session_id
            @property
            def state(self): return owner.goal_state
            def refresh(self): pass
            def resume(self): self.state.status, self.state.turns_used = 'active', 0
            def pause(self, reason='user-paused'): self.state.status, self.state.paused_reason = 'paused', reason
            def clear(self): self.state.status = 'cleared'
            def next_continuation_prompt(self): return 'Native goal continuation prompt'
        return module('hermes_cli.goals', GoalManager=Manager)

    def resume_overview(self, profile, visible):
        return dict(botId=profile, goals=dict(goal=dict(status=self.goal_state.status), interruptionPending=self.gate['interrupted'], **self.controller.resume_status(profile, automation.digest([self.goal_state.goal, self.goal_state.created_at]) if self.goal_state.status != 'cleared' else None)))

    def test_own_lifetime_lease_and_native_same_writer_are_allowed_under_registry_lock(self):
        self.session['active_session_lease'] = types.SimpleNamespace(lease_id='own', session_id='canonical', released=False)
        self.entries = [dict(session_id='canonical', lease_id='own', pid=os.getpid() + 1)]
        with self.controller.admitted('ranch'):
            self.assertTrue(self.registry_locked)
        self.session.pop('active_session_lease')
        self.entries = [dict(session_id='canonical', lease_id='own', pid=os.getpid(), metadata=dict(live_session_id='live'))]
        with self.controller.admitted('ranch'):
            self.assertTrue(self.registry_locked)
        self.entries[0]['metadata']['live_session_id'] = 'another-runtime'
        with self.assertRaisesRegex(automation.AutomationError, 'Another native executor'):
            with self.controller.admitted('ranch'): self.fail('foreign live runtime admitted')

    def test_goal_guard_holds_history_lock_but_releases_request_and_global_session_locks(self):
        request_lock = self.modules['tui_gateway.server_requests']._lock = threading.Lock()
        with self.controller.admitted('ranch'):
            self.assertFalse(self.session['history_lock'].acquire(blocking=False))
            self.assertTrue(request_lock.acquire(blocking=False))
            request_lock.release()
            self.assertTrue(self.server._sessions_lock.acquire(blocking=False))
            self.server._sessions_lock.release()

    def test_profile_operations_ignore_chat_idleness_and_release_maintenance_lock(self):
        self.session['running'] = True
        self.value['open_requests'] = [dict(id='native-approval')]
        self.entries = [dict(session_id='canonical', lease_id='foreign', pid=os.getpid() + 1)]
        with patch.object(automation, 'task_operation', return_value={'ok': True}) as task, patch.object(automation, 'trigger_operation', return_value={'ok': True}) as trigger, patch.object(automation, 'skill_operation', return_value={'ok': True}) as skill:
            for operation in ('task_create', 'trigger_create', 'skill_policy', 'skill_lock'):
                self.assertEqual(self.controller.run(dict(profile='ranch', operation=operation)), {'ok': True})
            self.assertEqual((task.call_count, trigger.call_count, skill.call_count), (1, 1, 2))
            self.maintenance = True
            with self.assertRaisesRegex(automation.AutomationError, 'upgraded'):
                self.controller.run(dict(profile='ranch', operation='skill_lock', name='fence', locked=True))
            self.assertEqual(skill.call_count, 2)
        self.assertEqual(self.entered, 0)

    def test_resume_uses_durable_submit_once_and_pause_clear_work_while_busy(self):
        sends = []
        def submit(rid, params):
            self.assertFalse(self.registry_locked)
            self.assertTrue(self.session['history_lock'].acquire(blocking=False))
            self.session['history_lock'].release()
            sends.append(params)
            self.receipts[params['request_id']] = dict(status='accepted', runId=params['request_id'])
            self.session['running'] = True
            return {'result': self.receipts[params['request_id']]}
        self.controller.submit = submit
        self.controller.overview = self.resume_overview
        request = dict(profile='ranch', visibleProfiles=['ranch'], operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person')
        with patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
            result = self.controller.run(request)
            self.assertEqual(result['goals']['resume']['status'], 'accepted')
            self.assertEqual(self.goal_state.turns_used, 0)
            self.assertEqual(sends[0]['sender_id'], 'person')
            self.assertEqual(sends[0]['text'], 'Native goal continuation prompt')
            self.assertTrue(sends[0]['require_idle'])
            self.controller.run(request)
            self.assertEqual(len(sends), 1)
            self.controller.run(dict(profile='ranch', operation='goal_pause'))
            self.assertEqual(self.goal_state.status, 'paused')
            self.controller.run(dict(profile='ranch', operation='goal_clear'))
            self.assertEqual(self.goal_state.status, 'cleared')

    def test_resume_preflight_requires_interruption_review_and_settled_prior_receipt(self):
        request = dict(profile='ranch', operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person')
        sends = []
        def submit(rid, params):
            sends.append(params)
            return {'result': dict(status='accepted')}
        self.controller.submit, self.controller.overview = submit, self.resume_overview
        with patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
            self.gate['current'] = ('unsettled',)
            with self.assertRaisesRegex(automation.AutomationError, 'settling'):
                self.controller.run(request)
            self.gate.update(current=None, interrupted=True)
            with self.assertRaisesRegex(automation.AutomationError, 'Review the interrupted work'):
                self.controller.run(request)
            self.assertEqual(self.goal_state.status, 'paused')
            self.assertEqual(sends, [])
            self.controller.run(dict(request, reviewedInterruption=True))
            self.assertTrue(sends[0]['reviewed_interruption'])

    def test_rpc_and_result_rejections_pause_the_goal_keep_outcome_and_allow_reviewed_retry(self):
        self.controller.overview = self.resume_overview
        request = dict(profile='ranch', operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person')
        for index, response in enumerate(({'error': dict(code=4094)}, {'result': dict(status='rejected', message='The previous task is still settling.')})):
            with self.subTest(response=response), patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
                self.goal_state.status = 'paused'
                request['requestId'] = f'12345678-1234-1234-1234-123456789ab{index}'
                sends = []
                self.controller.submit = lambda rid, params, sends=sends, response=response: sends.append(params) or response
                result = self.controller.run(request)
                self.assertEqual(result['goals']['resume']['status'], 'rejected')
                self.assertTrue(result['goals']['resume']['message'])
                self.assertEqual(self.goal_state.status, 'paused')
                self.controller.run(request)
                self.assertEqual(len(sends), 1)
                retry = dict(request, requestId=f'12345678-1234-1234-1234-123456789ac{index}', reviewedInterruption=True)
                self.controller.submit = lambda rid, params, sends=sends: sends.append(params) or {'result': dict(status='accepted')}
                self.assertEqual(self.controller.run(retry)['goals']['resume']['status'], 'accepted')
                self.assertEqual(len(sends), 2)
                self.assertTrue(sends[1]['reviewed_interruption'])

    def test_uncertain_submit_pauses_and_cannot_replay(self):
        self.controller.overview = self.resume_overview
        request = dict(profile='ranch', operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person')
        sends = []
        def submit(*args):
            sends.append(args)
            raise RuntimeError('Lost native response')
        self.controller.submit = submit
        with patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
            result = self.controller.run(request)
            self.assertEqual(result['goals']['resume']['status'], 'uncertain')
            self.assertEqual(self.goal_state.status, 'paused')
            self.controller.run(request)
            self.assertEqual(len(sends), 1)

    def test_crashed_resume_intent_never_sends_on_retry(self):
        self.db.execute("INSERT INTO automation_goal_resumes(request_id,profile,actor) VALUES('12345678-1234-1234-1234-123456789abc','ranch','person')")
        self.db.commit()
        self.controller.submit = lambda *_: self.fail('uncertain resume was replayed')
        self.controller.overview = self.resume_overview
        with patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
            with self.assertRaisesRegex(automation.AutomationError, 'earlier goal') as refusal:
                self.controller.run(dict(profile='ranch', operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person'))
        self.assertEqual(refusal.exception.status, 409)
        self.assertEqual(self.goal_state.status, 'paused')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM automation_goal_resumes').fetchone()[0], 1)

    def test_resume_preparation_refusal_is_retryable_without_any_submission(self):
        self.controller.overview = self.resume_overview
        request = dict(profile='ranch', operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person')
        sends = []
        self.controller.submit = lambda rid, params: sends.append(params) or {'result': dict(status='accepted')}
        goals = self.goals_module()
        goals.GoalManager.next_continuation_prompt = lambda _: None
        with patch.dict(sys.modules, {'hermes_cli.goals': goals}):
            result = self.controller.run(request)
            self.assertEqual(result['goals']['resume']['status'], 'rejected')
            self.assertEqual(self.goal_state.status, 'paused')
            self.assertEqual(sends, [])
            self.controller.run(request)
            self.assertEqual(sends, [])
        with patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
            retry = dict(request, requestId='12345678-1234-1234-1234-123456789abd', reviewedInterruption=True)
            self.assertEqual(self.controller.run(retry)['goals']['resume']['status'], 'accepted')
            self.assertEqual(len(sends), 1)

    def test_cross_goal_replay_refuses_without_mutation_and_fresh_reviewed_attempt_can_resume(self):
        self.controller.overview = self.resume_overview
        request = dict(profile='ranch', operation='goal_resume', requestId='12345678-1234-1234-1234-123456789abc', senderId='person')
        sends = []
        def submit(*args):
            sends.append(args)
            raise RuntimeError('Lost submission response')
        self.controller.submit = submit
        with patch.dict(sys.modules, {'hermes_cli.goals': self.goals_module()}):
            self.assertEqual(self.controller.run(request)['goals']['resume']['status'], 'uncertain')
            # Even a replacement with the same title has a different identity.
            self.goal_state.created_at = 999
            self.assertNotIn('resume', self.resume_overview('ranch', {'ranch'})['goals'])
            with self.assertRaisesRegex(automation.AutomationError, 'earlier goal') as refusal:
                self.controller.run(request)
            self.assertEqual(refusal.exception.status, 409)
            self.assertEqual(self.goal_state.status, 'paused')
            self.assertEqual(len(sends), 1)
            self.assertEqual(self.db.execute('SELECT status FROM automation_goal_resumes WHERE request_id=?', (request['requestId'],)).fetchone()[0], 'uncertain')
            self.controller.submit = lambda *args: sends.append(args) or {'result': dict(status='accepted')}
            fresh = dict(request, requestId='12345678-1234-1234-1234-123456789abd', reviewedInterruption=True)
            self.assertEqual(self.controller.run(fresh)['goals']['resume']['status'], 'accepted')
            self.assertEqual(self.goal_state.status, 'active')
            self.controller.run(fresh)
            self.assertEqual(len(sends), 2)
            self.goal_state.status = 'cleared'
            with self.assertRaisesRegex(automation.AutomationError, 'earlier goal'):
                self.controller.run(fresh)
            self.assertNotIn('resume', self.resume_overview('ranch', {'ranch'})['goals'])
            self.assertEqual(self.goal_state.status, 'cleared')
            self.assertEqual(len(sends), 2)
            self.assertEqual(self.db.execute('SELECT COUNT(*) FROM automation_goal_resumes').fetchone()[0], 2)

    def test_native_transaction_rechecks_owner_after_competing_writer(self):
        self.db.execute('CREATE TABLE tasks(id TEXT,created_by TEXT,assignee TEXT)')
        self.db.execute("INSERT INTO tasks VALUES('t_task','ranch','ranch')")
        self.db.commit()
        def check(conn):
            row = conn.execute("SELECT created_by,assignee FROM tasks WHERE id='t_task'").fetchone()
            if row != ('ranch', 'ranch'):
                raise automation.AutomationError('Task not found', 404)
        guarded = automation.GuardedTasks(self.db, check)
        self.db.execute("UPDATE tasks SET assignee='private'")
        self.db.commit()
        with self.assertRaises(automation.AutomationError): guarded.execute('BEGIN IMMEDIATE')
        self.assertFalse(self.db.in_transaction)

    def test_overview_hides_foreign_owner_assignee_and_dependency_ids(self):
        rows = {
            'owned': types.SimpleNamespace(id='owned', created_by='ranch', assignee='ranch', claim_lock=None, current_run_id=None, status='blocked', title='Fix fence', body='Public', priority=0),
            'hidden': types.SimpleNamespace(id='hidden', created_by='private', assignee='private', title='Private title'),
        }
        kb = types.SimpleNamespace(get_task=lambda conn, task_id: rows.get(task_id), parent_ids=lambda *_: ['hidden'], list_events=lambda *_: [types.SimpleNamespace(kind='blocked', payload=dict(reason='Waiting on fence supplies'))])
        dto = automation.task_dto(kb, None, rows['owned'], 'ranch', {'ranch'})
        self.assertEqual(dto['dependencies'], [])
        self.assertEqual(dto['blockedReason'], 'Waiting on fence supplies')
        self.assertNotIn('Private title', json.dumps(dto))
        rows['owned'].assignee = 'private'
        with self.assertRaises(automation.AutomationError): automation.task_dto(kb, None, rows['owned'], 'ranch', {'ranch'})


class InstallationTests(unittest.TestCase):
    def test_separate_runtime_module_keeps_native_refusal_status(self):
        other_spec = importlib.util.spec_from_file_location('separate_automation_runtime', ROOT / 'src/hermes/automation.py')
        runtime_module = importlib.util.module_from_spec(other_spec)
        other_spec.loader.exec_module(runtime_module)
        self.assertIsNot(runtime_module.AutomationError, automation.AutomationError)
        routes = []
        def run(_): raise runtime_module.AutomationError('Task not found in this assistant.', 404)
        journal = types.SimpleNamespace(automation=types.SimpleNamespace(error_type=runtime_module.AutomationError, run=run))
        web = types.SimpleNamespace(_require_token=lambda _: None, app=types.SimpleNamespace(add_api_route=lambda path, handler, **kwargs: routes.append(handler)))
        async def scoped(profile, fn): return fn()
        class Response:
            def __init__(self, data, status_code=200, headers=None): self.data, self.status_code = data, status_code
        async def body(): return dict(operation='task_get', profile='ranch', taskId='t_12345678')
        request = types.SimpleNamespace(state=types.SimpleNamespace(agent_interface_service_authenticated=True), json=body)
        with patch.dict(sys.modules, {'fastapi': module('fastapi', Request=object, HTTPException=type('HTTPException', (Exception,), {})),
            'starlette.responses': module('starlette.responses', JSONResponse=Response),
            'hermes_cli.web_routers._common': module('hermes_cli.web_routers._common', config_scoped_to_thread=scoped),
            'hermes_cli.backend_retirement': module('hermes_cli.backend_retirement', retirement=types.SimpleNamespace(work=lambda: contextlib.nullcontext(True)))}):
            automation.install(web, journal)
            response = asyncio.run(routes[0](request))
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.data, {'error': 'Task not found in this assistant.'})


class TaskConnectionTests(unittest.TestCase):
    def setUp(self):
        self.connection = types.SimpleNamespace(execute=lambda *args: types.SimpleNamespace(fetchall=lambda: [(self.task.id,)]))
        self.closed = 0
        self.created = None
        self.task = types.SimpleNamespace(id='t_12345678', created_by='ranch', assignee='ranch', claim_lock=None,
            current_run_id=None, status='blocked', title='Fix fence', body='Public task', priority=0)
        @contextlib.contextmanager
        def connect_closing():
            try:
                yield self.connection
            finally:
                self.closed += 1
        def create_task(conn, **fields):
            self.created = fields
            return self.task.id
        # Deliberately no connect_closing on kanban_db. Exact 41df exports it
        # from the split connection module only.
        kb = module('hermes_cli.kanban_db', kanban_db_path=lambda: types.SimpleNamespace(is_file=lambda: True),
            list_tasks=lambda conn, **_: [self.task], get_task=lambda conn, key: self.task if key == self.task.id else None,
            parent_ids=lambda *_: [], list_events=lambda *_: [], create_task=create_task)
        self.patcher = patch.dict(sys.modules, {'hermes_cli': module('hermes_cli', kanban_db=kb), 'hermes_cli.kanban_db': kb,
            'hermes_cli.kanban_db_connect': module('hermes_cli.kanban_db_connect', connect_closing=connect_closing)})
        self.patcher.start()

    def tearDown(self): self.patcher.stop()

    def test_native_split_connection_is_used_and_closed_for_reads_and_create(self):
        self.assertEqual(automation.task_list('ranch', {'ranch'})['items'][0]['id'], self.task.id)
        self.assertEqual(automation.task_operation(dict(profile='ranch', operation='task_get', taskId=self.task.id), {'ranch'})['id'], self.task.id)
        result = automation.task_operation(dict(profile='ranch', operation='task_create', task=dict(title='Fix fence', requestId='12345678-1234-1234-1234-123456789abc')), {'ranch'})
        self.assertEqual(result['id'], self.task.id)
        self.assertEqual(self.created['initial_status'], 'blocked')
        self.assertEqual(self.created['created_by'], 'ranch')
        self.assertEqual(self.created['assignee'], 'ranch')
        self.assertEqual(self.created['idempotency_key'], 'wildbots:ranch:12345678-1234-1234-1234-123456789abc')
        self.assertEqual(self.closed, 3)

    def test_nullable_assignee_clears_native_assignment_and_omission_preserves_it(self):
        calls = []
        kb = sys.modules['hermes_cli.kanban_db']
        def assign(conn, task_id, assignee):
            calls.append(assignee)
            self.task.assignee = assignee
            return True
        kb.assign_task = assign
        result = automation.task_operation(dict(profile='ranch', operation='task_update', taskId=self.task.id, assignee=None), {'ranch'})
        self.assertIsNone(result['assignee'])
        self.assertEqual(calls, [None])
        automation.task_operation(dict(profile='ranch', operation='task_update', taskId=self.task.id), {'ranch'})
        self.assertEqual(calls, [None])
        automation.task_operation(dict(profile='ranch', operation='task_create', task=dict(title='Fix fence', requestId='12345678-1234-1234-1234-123456789abc', assignee=None)), {'ranch'})
        self.assertIsNone(self.created['assignee'])


class TaskPageTests(unittest.TestCase):
    def test_owner_and_visible_assignee_filter_precede_newest_task_limit(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.execute('CREATE TABLE tasks(id TEXT,title TEXT,body TEXT,status TEXT,priority INTEGER,created_by TEXT,assignee TEXT,created_at INTEGER)')
        rows = [(f'foreign{i}', 'Private title', '', 'blocked', 100, 'private', 'private', 30000 + i) for i in range(1005)]
        rows += [(f'hidden{i}', 'Hidden assignment', '', 'blocked', 100, 'ranch', 'private', 20000 + i) for i in range(105)]
        rows += [(f'owned{i}', 'Visible title', '', 'blocked', 0, 'ranch', 'ranch', i) for i in range(105)]
        rows += [('unassigned', 'Unassigned visible', '', 'blocked', 0, 'ranch', None, 1000)]
        db.executemany('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)', rows)
        def get_task(conn, task_id):
            row = conn.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
            return types.SimpleNamespace(**dict(row), claim_lock=None, current_run_id=None) if row else None
        kb = module('hermes_cli.kanban_db', kanban_db_path=lambda: types.SimpleNamespace(is_file=lambda: True), get_task=get_task,
            parent_ids=lambda *_: [], list_events=lambda *_: [])
        @contextlib.contextmanager
        def connect_closing(): yield db
        try:
            with patch.dict(sys.modules, {'hermes_cli': module('hermes_cli', kanban_db=kb),
                'hermes_cli.kanban_db_connect': module('hermes_cli.kanban_db_connect', connect_closing=connect_closing)}):
                page = automation.task_list('ranch', {'ranch'})
                self.assertTrue(page['truncated'])
                self.assertEqual(page['limit'], 100)
                self.assertEqual(len(page['items']), 100)
                self.assertEqual(page['items'][0]['id'], 'unassigned')
                self.assertEqual(page['items'][1]['id'], 'owned104')
                self.assertNotIn('Private title', json.dumps(page))
                self.assertNotIn('Hidden assignment', json.dumps(page))
                db.execute("DELETE FROM tasks WHERE created_by='ranch' AND id NOT IN ('owned104','unassigned')")
                self.assertFalse(automation.task_list('ranch', {'ranch'})['truncated'])
        finally:
            db.close()


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.routes = {}
        def mutate(fn):
            draft = copy.deepcopy(self.routes)
            result = fn(draft)
            self.routes = draft
            return result
        wh = module('hermes_cli.webhook', _mutate_subscriptions=mutate, _load_subscriptions=lambda: self.routes,
            _is_webhook_enabled=lambda: True, _route_url=lambda name, row: 'https://synthetic.invalid/p/' + row['profile'] + '/webhooks/' + name)
        cli = module('hermes_cli', webhook=wh)
        cron = module('hermes_cli.web_routers.cron', _call_cron_for_profile=lambda profile, method, job: {'id': job} if job == 'own-routine' and profile == 'ranch' else None)
        self.patcher = patch.dict(sys.modules, {'hermes_cli': cli, 'hermes_cli.webhook': wh, 'hermes_cli.web_routers.cron': cron})
        self.patcher.start()

    def tearDown(self): self.patcher.stop()

    def test_secret_only_on_create_paused_defaults_profile_routine_and_cas(self):
        trigger = dict(id='fence-event', description='Fence update', events=['issue.created'], routineId='own-routine')
        created = automation.trigger_operation(dict(operation='trigger_create', profile='ranch', trigger=trigger))
        self.assertTrue(created['secret'])
        self.assertFalse(created['subscription']['enabled'])
        self.assertNotIn(created['secret'], json.dumps(automation.trigger_list('ranch')))
        self.assertEqual(automation.trigger_list('private')['items'], [])
        with self.assertRaises(automation.AutomationError): automation.trigger_operation(dict(operation='trigger_create', profile='ranch', trigger=trigger))
        with self.assertRaises(automation.AutomationError): automation.trigger_operation(dict(operation='trigger_create', profile='ranch', trigger={**trigger, 'id': 'foreign', 'routineId': 'foreign-routine'}))
        with self.assertRaises(automation.AutomationError): automation.trigger_operation(dict(operation='trigger_toggle', profile='private', triggerId='fence-event', enabled=True, revision=created['subscription']['revision']))
        with self.assertRaises(automation.AutomationError): automation.trigger_operation(dict(operation='trigger_toggle', profile='ranch', triggerId='fence-event', enabled=True, revision='stale'))
        toggled = automation.trigger_operation(dict(operation='trigger_toggle', profile='ranch', triggerId='fence-event', enabled=True, revision=created['subscription']['revision']))
        self.assertNotIn('secret', toggled)
        self.assertTrue(toggled['subscription']['enabled'])


class SkillTests(unittest.TestCase):
    def setUp(self):
        self.record = dict(id='deadbeef', summary='Update fence skill', payload={'action': 'patch'})
        self.diff = '-old\n+new'
        self.applies = 0
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.execute('CREATE TABLE automation_skill_decisions(profile TEXT,pending_id TEXT,revision TEXT,status TEXT,PRIMARY KEY(profile,pending_id))')
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=self.db)
        wa = module('tools.write_approval', SKILLS='skills', get_pending=lambda *_: self.record, skill_pending_diff=lambda *_: self.diff, discard_pending=lambda *_: True)
        def apply(*_):
            self.applies += 1
            raise RuntimeError('Outcome uncertain after native write')
        self.patcher = patch.dict(sys.modules, {'tools': module('tools', write_approval=wa), 'tools.write_approval': wa,
            'hermes_cli.web_server_profiles': module('hermes_cli.web_server_profiles', _profile_scope=lambda _: contextlib.nullcontext()),
            'hermes_cli.write_approval_commands': module('hermes_cli.write_approval_commands', _apply_one=apply)})
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.db.close()

    def test_create_approval_waits_for_foreign_native_skill_globals_and_restores_them(self):
        self.record['payload'] = dict(action='create', name='fence', content='Fence skill')
        request = dict(profile='ranch', operation='skill_diff', pendingId='deadbeef')
        decision = dict(request, operation='skill_decide', revision=automation.skill_operation(request, self.journal)['revision'], decision='approve')
        launch = Path('/launch')
        skill_modules = [module(name, HERMES_HOME=launch, SKILLS_DIR=launch / 'skills')
            for name in ('tools.skills_tool', 'tools.skill_manager_tool')]
        native_lock = threading.RLock()
        foreign_entered, release_foreign, approval_waiting, applied = (threading.Event() for _ in range(4))
        results, failures, destinations = [], [], []

        @contextlib.contextmanager
        def profile_scope(profile):
            if profile == 'ranch':
                approval_waiting.set()
            # Mirrors native _profile_scope's shared lock and module-global
            # save/swap/restore, including the globals _skills_dir prefers.
            with native_lock:
                saved = [(m.HERMES_HOME, m.SKILLS_DIR) for m in skill_modules]
                for m in skill_modules:
                    m.HERMES_HOME = Path('/profiles') / profile
                    m.SKILLS_DIR = m.HERMES_HOME / 'skills'
                try:
                    yield
                finally:
                    for m, (home, skills) in zip(skill_modules, saved):
                        m.HERMES_HOME, m.SKILLS_DIR = home, skills

        def create(*_):
            destinations.extend(m.SKILLS_DIR / 'fence' / 'SKILL.md' for m in skill_modules)
            applied.set()
            return True, '', dict(success=True)

        def foreign_request():
            with profile_scope('private'):
                foreign_entered.set()
                if not release_foreign.wait(5):
                    failures.append('Foreign profile was never released')

        def approve():
            try:
                results.append(automation.skill_operation(decision, self.journal))
            except Exception as exc:
                failures.append(exc)

        sys.modules['hermes_cli.web_server_profiles']._profile_scope = profile_scope
        sys.modules['hermes_cli.write_approval_commands']._apply_one = create
        foreign, approval = threading.Thread(target=foreign_request), threading.Thread(target=approve)
        foreign.start()
        try:
            self.assertTrue(foreign_entered.wait(5))
            approval.start()
            self.assertTrue(approval_waiting.wait(5))
            self.assertFalse(applied.is_set())
            self.assertTrue(all(m.SKILLS_DIR == Path('/profiles/private/skills') for m in skill_modules))
        finally:
            release_foreign.set()
            foreign.join(5)
            if approval.ident is not None:
                approval.join(5)
        self.assertFalse(foreign.is_alive())
        self.assertFalse(approval.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(results, [dict(ok=True)])
        self.assertEqual(destinations, [Path('/profiles/ranch/skills/fence/SKILL.md')] * 2)
        self.assertTrue(all((m.HERMES_HOME, m.SKILLS_DIR) == (launch, launch / 'skills') for m in skill_modules))
        self.assertEqual(self.db.execute('SELECT status FROM automation_skill_decisions').fetchone()[0], 'completed')

    def test_diff_revision_fences_stale_content_and_uncertain_approval_cannot_replay(self):
        request = dict(profile='ranch', operation='skill_diff', pendingId='deadbeef')
        detail = automation.skill_operation(request, self.journal)
        decision = dict(request, operation='skill_decide', revision=detail['revision'], decision='approve')
        self.diff += '\n+native changed this file'
        with self.assertRaisesRegex(automation.AutomationError, 'changed'): automation.skill_operation(decision, self.journal)
        self.assertEqual(self.applies, 0)
        decision['revision'] = automation.skill_operation(request, self.journal)['revision']
        with self.assertRaises(RuntimeError): automation.skill_operation(decision, self.journal)
        self.assertEqual(self.applies, 1)
        with self.assertRaisesRegex(automation.AutomationError, 'already attempted'): automation.skill_operation(decision, self.journal)
        self.assertEqual(self.applies, 1)

    def test_proven_native_patch_refusal_can_be_reviewed_and_retried(self):
        request = dict(profile='ranch', operation='skill_diff', pendingId='deadbeef')
        decision = dict(request, operation='skill_decide', revision=automation.skill_operation(request, self.journal)['revision'], decision='approve')
        applier = sys.modules['hermes_cli.write_approval_commands']
        applier._apply_one = lambda *_: (False, 'No unique match', dict(success=False, error='No unique match', file_preview='Current file'))
        with self.assertRaisesRegex(automation.AutomationError, 'without a surviving content change'):
            automation.skill_operation(decision, self.journal)
        self.assertEqual(self.db.execute('SELECT status FROM automation_skill_decisions').fetchone()[0], 'rejected')
        decision['revision'] = automation.skill_operation(request, self.journal)['revision']
        applier._apply_one = lambda *_: (True, '', dict(success=True))
        self.assertEqual(automation.skill_operation(decision, self.journal), {'ok': True})
        self.assertEqual(self.db.execute('SELECT status FROM automation_skill_decisions').fetchone()[0], 'completed')

    def test_ambiguous_false_result_stays_uncertain_and_batch_rollback_must_be_complete(self):
        request = dict(profile='ranch', operation='skill_diff', pendingId='deadbeef')
        decision = dict(request, operation='skill_decide', revision=automation.skill_operation(request, self.journal)['revision'], decision='approve')
        sys.modules['hermes_cli.write_approval_commands']._apply_one = lambda *_: (False, 'Possibly partial', {})
        with self.assertRaisesRegex(automation.AutomationError, 'could not confirm whether'):
            automation.skill_operation(decision, self.journal)
        with self.assertRaisesRegex(automation.AutomationError, 'already attempted'):
            automation.skill_operation(decision, self.journal)
        batch = dict(payload=dict(operations=[dict(action='patch')]))
        rolled_back = dict(success=False, failed_index=1, completed_before_failure=1, error="operations[1] failed — batch aborted, all touched skills rolled back.")
        self.assertTrue(automation.skill_refusal_is_definite(batch, rolled_back))
        self.assertFalse(automation.skill_refusal_is_definite(batch, {**rolled_back, 'error': 'ROLLBACK FAILED', 'file_preview': 'Partial file'}))
        self.assertFalse(automation.skill_refusal_is_definite(dict(payload=dict(action='delete')), dict(success=False, error='Archive failed after a partial move')))
        self.assertTrue(automation.skill_refusal_is_definite(dict(payload=dict(action='create')), dict(success=False, error='Skill already exists')))
        self.assertTrue(automation.skill_refusal_is_definite(batch, dict(success=False, error='Invalid operation shape')))

    def test_approving_a_change_to_a_locked_skill_is_a_definite_refusal(self):
        # Native skill_manage refuses a locked skill in its preflight, before any write or batch snapshot,
        # even for a delete, whose other false results stay uncertain.
        for payload in (dict(action='delete', name='fence'), dict(operations=[dict(action='delete', name='fence')])):
            with self.subTest(payload=payload):
                self.db.execute('DELETE FROM automation_skill_decisions')
                self.record['payload'] = payload
                request = dict(profile='ranch', operation='skill_diff', pendingId='deadbeef')
                decision = dict(request, operation='skill_decide', revision=automation.skill_operation(request, self.journal)['revision'], decision='approve')
                refusal = dict(success=False, error="Refusing delete: Skill 'fence' is locked by the user", _locked=True)
                sys.modules['hermes_cli.write_approval_commands']._apply_one = lambda *_, _refusal=refusal: (False, _refusal['error'], _refusal)
                with self.assertRaisesRegex(automation.AutomationError, 'skill is locked') as raised:
                    automation.skill_operation(decision, self.journal)
                self.assertEqual(raised.exception.status, 409)
                self.assertEqual(self.db.execute('SELECT status FROM automation_skill_decisions').fetchone()[0], 'rejected')
        self.assertFalse(automation.skill_refusal_is_definite(dict(payload=dict(action='delete')), dict(success=False, _locked=False)))

    def test_a_lock_that_stops_a_batch_midway_is_definite_only_after_a_complete_rollback(self):
        # Another process locked the second skill after the first op applied. Native copies the
        # failing op's _locked onto the batch result, whatever its rollback did.
        self.record['payload'] = dict(operations=[dict(action='patch', name='fence'), dict(action='patch', name='gate')])
        request = dict(profile='ranch', operation='skill_diff', pendingId='deadbeef')
        decision = dict(request, operation='skill_decide', revision=automation.skill_operation(request, self.journal)['revision'], decision='approve')
        partial = dict(success=False, failed_index=1, completed_before_failure=1, _locked=True,
                       error="operations[1] (patch on 'gate') failed: Refusing patch: Skill 'gate' is locked — batch aborted, ROLLBACK FAILED for fence.")
        applier = sys.modules['hermes_cli.write_approval_commands']
        applier._apply_one = lambda *_: (False, partial['error'], partial)
        with self.assertRaisesRegex(automation.AutomationError, 'could not confirm whether'):
            automation.skill_operation(decision, self.journal)
        self.assertEqual(self.db.execute('SELECT status FROM automation_skill_decisions').fetchone()[0], 'uncertain')
        applier._apply_one = lambda *_: self.fail('an uncertain partial batch was replayed')
        with self.assertRaisesRegex(automation.AutomationError, 'already attempted'):
            automation.skill_operation(decision, self.journal)
        rolled_back = dict(partial, error="operations[1] (patch on 'gate') failed: Refusing patch — batch aborted, all touched skills rolled back.")
        self.assertTrue(automation.skill_refusal_is_definite(self.record, rolled_back))

    def test_truncated_diff_and_path_traversal_are_not_approvable(self):
        self.diff = 'x' * 100001
        detail = automation.skill_operation(dict(profile='ranch', operation='skill_diff', pendingId='deadbeef'), self.journal)
        self.assertTrue(detail['truncated'])
        with self.assertRaisesRegex(automation.AutomationError, 'too large'):
            automation.skill_operation(dict(profile='ranch', operation='skill_decide', pendingId='deadbeef', revision=detail['revision'], decision='approve'), self.journal)
        self.assertEqual(self.applies, 0)
        with self.assertRaises(automation.AutomationError): automation.identity('../native')


class SkillLockTests(unittest.TestCase):
    """The lock uses native Hermes's own record, keyed by skill directory, inside the profile's write scope."""
    def setUp(self):
        self.locks, self.scope, self.writes = {'fence-check'}, [], []
        self.saved = True
        self.skills = {'ranch/fence': Path('/profiles/ranch/skills/ranch/fence-check'), 'gate': Path('/profiles/ranch/skills/gate')}
        @contextlib.contextmanager
        def write_scope(profile):
            self.scope.append(profile)
            try:
                yield
            finally:
                self.scope.pop()
        def set_locked(key, locked):
            self.writes.append((key, locked, list(self.scope)))
            return self.saved
        catalog = lambda: (set(self.locks), {'ranch/fence': 'fence-check', 'gate': 'gate'})
        self.usage = module('tools.skill_usage', set_locked=set_locked)
        self.routers = module('hermes_cli.web_routers.skills', _locked_index=catalog)
        wa = module('tools.write_approval', SKILLS='skills', list_pending=lambda *_: [], write_approval_enabled=lambda *_: True)
        skills_tool = module('tools.skills_tool', find_all_skills=lambda **_: [dict(name='ranch/fence', description='Fence'), dict(name='gate', description='Gate')])
        manager = module('tools.skill_manager_tool', _find_skill=lambda name: dict(path=self.skills[name]) if name in self.skills else None)
        self.patcher = patch.dict(sys.modules, {
            'tools': module('tools', write_approval=wa, skill_usage=self.usage, skills_tool=skills_tool, skill_manager_tool=manager),
            'tools.write_approval': wa, 'tools.skill_usage': self.usage, 'tools.skills_tool': skills_tool, 'tools.skill_manager_tool': manager,
            'hermes_cli.web_routers.skills': self.routers,
            'hermes_cli.web_routers._common': module('hermes_cli.web_routers._common', config_write_scope=write_scope)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def lock(self, **fields):
        return automation.skill_operation(dict(profile='ranch', operation='skill_lock', **fields))

    def test_list_reports_each_skills_lock_by_its_directory(self):
        listed = automation.skill_list()
        self.assertTrue(listed['lockSupported'])
        self.assertEqual([(row['name'], row['locked']) for row in listed['installed']], [('ranch/fence', True), ('gate', False)])

    def test_lock_and_unlock_write_the_directory_key_inside_the_profile_write_scope(self):
        self.assertEqual(self.lock(name='gate', locked=True), dict(ok=True, name='gate', locked=True))
        self.assertEqual(self.lock(name='ranch/fence', locked=False), dict(ok=True, name='ranch/fence', locked=False))
        self.assertEqual(self.writes, [('gate', True, ['ranch']), ('fence-check', False, ['ranch'])])

    def test_invalid_missing_or_unsaved_locks_refuse(self):
        for fields, status in ((dict(name='../gate', locked=True), 400), (dict(name='gate', locked='yes'), 400),
                               (dict(name='gone', locked=True), 404)):
            with self.subTest(fields=fields), self.assertRaises(automation.AutomationError) as raised:
                self.lock(**fields)
            self.assertEqual(raised.exception.status, status)
        self.assertEqual(self.writes, [])
        self.saved = False
        with self.assertRaisesRegex(automation.AutomationError, "couldn't save"):
            self.lock(name='gate', locked=True)

    def test_a_hermes_without_skill_locks_lists_skills_but_cannot_lock(self):
        del self.routers._locked_index
        listed = automation.skill_list()
        self.assertFalse(listed['lockSupported'])
        self.assertNotIn('locked', listed['installed'][0])
        with self.assertRaisesRegex(automation.AutomationError, "can't lock skills") as raised:
            self.lock(name='gate', locked=True)
        self.assertEqual((raised.exception.status, self.writes), (409, []))


class ApprovalSettingsTests(unittest.TestCase):
    """Always-allowed patterns and auto-review go through the profile's own config, inside its write scope."""
    def setUp(self):
        self.config = {'command_allowlist': ['recursive delete', 'SQL DROP'], 'approvals': {'mode': 'manual'}}
        self.scope, self.saves = [], []
        @contextlib.contextmanager
        def write_scope(profile):
            self.scope.append(profile)
            try:
                yield
            finally:
                self.scope.pop()
        def save(config):
            self.assertEqual(self.scope, [self.profile], 'config written outside the profile write scope')
            self.saves.append(copy.deepcopy(config))
            self.config = copy.deepcopy(config)
        approval = module('tools.approval', _lock=threading.Lock(),
            _session_approved={'ranch-chat': {'recursive delete', 'rm -r', 'SQL DROP'}, 'other-chat': {'recursive delete'}, 'launch-chat': {'recursive delete'}},
            _read_permanent_allowlist=lambda: set(self.config.get('command_allowlist') or []),
            # Hermes b9cb268 and d23cc6b read these once and keep them: the launch profile's grants
            # under "", a routed profile's under its home key.
            _permanent_approved={'recursive delete', 'rm -r', 'SQL DROP'},
            _permanent_approved_by_home={'/hermes/profiles/ranch': {'recursive delete', 'SQL DROP'}, '/hermes/profiles/other': {'recursive delete'}},
            _permanent_baseline_by_home={'': {'recursive delete'}, '/hermes/profiles/ranch': {'recursive delete', 'SQL DROP'}})
        self.approval = approval
        context = module('tools.approval_context', _get_approval_config=lambda: self.config.get('approvals') or {},
            _normalize_approval_mode=lambda mode: 'off' if mode is False else mode if mode in ('manual', 'smart', 'off') else 'manual')
        detection = module('tools.approval_detection', _approval_key_aliases=lambda key: {key, 'rm -r'} if key == 'recursive delete' else {key})
        profiles = module('hermes_cli.profiles', get_profile_dir=lambda name: Path('/hermes') if name == 'default' else Path('/hermes/profiles') / name)
        config = module('hermes_cli.config', load_config=lambda: copy.deepcopy(self.config), save_config=save)
        self.server = types.SimpleNamespace(_hermes_home='/hermes', _sessions={
            'a': dict(session_key='ranch-chat', profile_home='/hermes/profiles/ranch'),
            'b': dict(session_key='other-chat', profile_home='/hermes/profiles/other'),
            # The launch profile's sessions carry no profile_home.
            'c': dict(session_key='launch-chat', profile_home=None)})
        self.patcher = patch.dict(sys.modules, {
            'tools': module('tools', approval=approval, approval_context=context, approval_detection=detection),
            'tools.approval': approval, 'tools.approval_context': context, 'tools.approval_detection': detection,
            'hermes_cli': module('hermes_cli'), 'hermes_cli.profiles': profiles, 'hermes_cli.config': config,
            'hermes_constants': module('hermes_constants', hermes_home_key=lambda path: str(path)),
            'hermes_cli.web_routers._common': module('hermes_cli.web_routers._common', config_write_scope=write_scope)})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def run_operation(self, operation, profile='ranch', **fields):
        self.profile = profile
        return automation.approval_operation(dict(operation=operation, profile=profile, **fields), self.server)

    def test_settings_list_the_allowlist_sorted_with_the_review_mode(self):
        self.assertEqual(self.run_operation('approval_settings'), dict(allowlist=['SQL DROP', 'recursive delete'], mode='manual'))

    def test_removing_a_pattern_saves_the_rest_and_withdraws_its_session_grants_in_that_profile_only(self):
        result = self.run_operation('approval_allowlist_remove', pattern='recursive delete')
        self.assertEqual(result, dict(ok=True, allowlist=['SQL DROP'], mode='manual'))
        self.assertEqual(self.saves[-1]['command_allowlist'], ['SQL DROP'])
        # Every key the pattern has had leaves this profile's sessions; other grants and profiles stay.
        self.assertEqual(self.approval._session_approved['ranch-chat'], {'SQL DROP'})
        self.assertEqual(self.approval._session_approved['other-chat'], {'recursive delete'})
        self.assertEqual(self.approval._session_approved['launch-chat'], {'recursive delete'})
        # The permanent cache an older Hermes never rereads loses it too, for this profile only.
        self.assertEqual(self.approval._permanent_approved_by_home['/hermes/profiles/ranch'], {'SQL DROP'})
        self.assertEqual(self.approval._permanent_baseline_by_home['/hermes/profiles/ranch'], {'SQL DROP'})
        self.assertEqual(self.approval._permanent_approved_by_home['/hermes/profiles/other'], {'recursive delete'})
        self.assertIn('recursive delete', self.approval._permanent_approved)

    def test_the_launch_profile_matches_sessions_without_a_profile_home(self):
        self.run_operation('approval_allowlist_remove', profile='default', pattern='recursive delete')
        self.assertEqual(self.approval._session_approved['launch-chat'], set())
        self.assertIn('recursive delete', self.approval._session_approved['ranch-chat'])
        # Its grants live in the module-level set, under every key the pattern has had.
        self.assertEqual(self.approval._permanent_approved, {'SQL DROP'})
        self.assertEqual(self.approval._permanent_baseline_by_home[''], set())
        self.assertIn('recursive delete', self.approval._permanent_approved_by_home['/hermes/profiles/ranch'])

    def test_removing_a_pattern_not_on_disk_still_withdraws_its_session_grant_without_writing(self):
        self.config['command_allowlist'] = ['SQL DROP']
        self.run_operation('approval_allowlist_remove', pattern='recursive delete')
        self.assertEqual(self.saves, [])
        self.assertEqual(self.approval._session_approved['ranch-chat'], {'SQL DROP'})

    def test_auto_review_writes_smart_or_manual_and_nothing_else(self):
        self.assertEqual(self.run_operation('approval_mode', mode='smart')['mode'], 'smart')
        self.assertEqual(self.saves[-1]['approvals'], {'mode': 'smart'})
        self.config['approvals'] = None
        self.assertEqual(self.run_operation('approval_mode', mode='manual')['mode'], 'manual')
        self.assertEqual(self.saves[-1]['approvals'], {'mode': 'manual'})

    def test_invalid_patterns_and_modes_refuse_before_any_write(self):
        for operation, fields, reason in (
            ('approval_allowlist_remove', dict(pattern=''), 'always-allowed command pattern'),
            ('approval_allowlist_remove', dict(pattern='   '), 'always-allowed command pattern'),
            ('approval_allowlist_remove', dict(pattern=['recursive delete']), 'always-allowed command pattern'),
            ('approval_allowlist_remove', dict(pattern='x' * 201), 'always-allowed command pattern'),
            ('approval_allowlist_remove', dict(pattern='rm\n-rf'), 'always-allowed command pattern'),
            # Turning approvals off entirely stays a native-only choice.
            ('approval_mode', dict(mode='off'), 'manual or smart'),
            ('approval_mode', dict(mode=None), 'manual or smart'),
        ):
            with self.subTest(fields=fields), self.assertRaisesRegex(automation.AutomationError, reason) as raised:
                self.run_operation(operation, **fields)
            self.assertEqual(raised.exception.status, 400)
        self.assertEqual(self.saves, [])
        self.assertIn('recursive delete', self.approval._session_approved['ranch-chat'])

    def test_controller_routes_approval_operations_and_pauses_writes_for_maintenance(self):
        maintenance = [False]
        self.server._sessions['a']['running'] = True
        controller = automation.Controller(self.server, lambda *_: {'profiles': [{'name': 'ranch'}]}, None,
            threading.RLock(), threading.RLock(), lambda: maintenance[0], types.SimpleNamespace(lock=threading.RLock(), db=sqlite3.connect(':memory:')))
        run = lambda operation, **fields: controller.run(dict(operation=operation, profile='ranch', visibleProfiles=['ranch'], **fields))
        self.profile = 'ranch'
        # A busy chat does not hold up a policy change.
        self.assertEqual(run('approval_mode', mode='smart')['mode'], 'smart')
        with self.assertRaises(automation.AutomationError) as raised:
            controller.run(dict(operation='approval_settings', profile='ranch', visibleProfiles=['other']))
        self.assertEqual(raised.exception.status, 404)
        maintenance[0] = True
        self.assertEqual(run('approval_settings')['allowlist'], ['SQL DROP', 'recursive delete'])
        with self.assertRaisesRegex(automation.AutomationError, 'upgraded'):
            run('approval_allowlist_remove', pattern='SQL DROP')
        self.assertEqual(len(self.saves), 1)



SOURCE = os.environ.get('HERMES_SOURCE')


@unittest.skipUnless(SOURCE, 'Set HERMES_SOURCE to a Hermes checkout to run against its real approval cache')
class RealApprovalCacheTests(unittest.TestCase):
    """Removal against the real tools.approval of the checkout HERMES_SOURCE names, in a temp home.

    Run it on every qualified revision: b9cb268 and d23cc6b keep the permanent set without
    rereading config.yaml, ed1afb0 resyncs it on each check.
    """
    def setUp(self):
        import tempfile
        self.directory = tempfile.TemporaryDirectory()
        self.home = Path(self.directory.name).resolve()
        (self.home / 'profiles' / 'ranch').mkdir(parents=True)
        for home in (self.home, self.home / 'profiles' / 'ranch'):
            (home / 'config.yaml').write_text('command_allowlist:\n- recursive delete\napprovals:\n  mode: manual\n')
        self.environment = patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'HOME': str(self.home)})
        self.environment.start()
        sys.path.insert(0, SOURCE)
        for name in [name for name in sys.modules if name.split('.')[0] in ('tools', 'hermes_cli', 'hermes_constants', 'agent', 'gateway')]:
            del sys.modules[name]
        from tools import approval
        from hermes_cli.web_routers._common import config_write_scope
        self.approval, self.scope = approval, config_write_scope
        self.server = types.SimpleNamespace(_hermes_home=str(self.home), _sessions={
            'launch': dict(session_key='launch-chat', profile_home=None),
            'ranch': dict(session_key='ranch-chat', profile_home=str(self.home / 'profiles' / 'ranch'))})

    def tearDown(self):
        sys.path.remove(SOURCE)
        self.environment.stop()
        self.directory.cleanup()

    def approved(self, profile, session):
        with self.scope(profile):
            return self.approval.is_approved(session, 'recursive delete')

    def test_removal_revokes_the_live_permanent_and_session_grants_for_each_profile(self):
        self.approval.load_permanent_allowlist()
        self.approval.approve_session('launch-chat', 'recursive delete')
        # Each check warms the profile's cache, as a command check in a live chat would.
        self.assertTrue(self.approval.is_approved('fresh-launch-chat', 'recursive delete'))
        self.assertTrue(self.approved('ranch', 'fresh-ranch-chat'))
        self.assertTrue(self.approved('default', 'fresh-launch-chat'))
        automation.approval_operation(dict(operation='approval_allowlist_remove', profile='ranch', pattern='recursive delete'), self.server)
        self.assertFalse(self.approved('ranch', 'fresh-ranch-chat'), 'The routed profile still allows it from its cache')
        self.assertTrue(self.approval.is_approved('fresh-launch-chat', 'recursive delete'), 'Another profile keeps its own grant')
        result = automation.approval_operation(dict(operation='approval_allowlist_remove', profile='default', pattern='recursive delete'), self.server)
        self.assertEqual(result['allowlist'], [])
        self.assertFalse(self.approval.is_approved('launch-chat', 'recursive delete'), 'The live session keeps it')
        self.assertFalse(self.approval.is_approved('fresh-launch-chat', 'recursive delete'), 'The launch profile still allows it from its cache')
        self.assertFalse(self.approved('default', 'fresh-launch-chat'))


if __name__ == '__main__': unittest.main()
