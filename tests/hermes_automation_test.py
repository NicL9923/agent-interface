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
            lambda *_: {'result': self.value}, threading.RLock(), threading.RLock(), threading.RLock(), lambda: self.maintenance, self.journal)

    def tearDown(self):
        self.patcher.stop()
        self.db.close()

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
            for operation in ('task_create', 'trigger_create', 'skill_policy'):
                self.assertEqual(self.controller.run(dict(profile='ranch', operation=operation)), {'ok': True})
            self.assertEqual((task.call_count, trigger.call_count, skill.call_count), (1, 1, 1))
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

    def test_truncated_diff_and_path_traversal_are_not_approvable(self):
        self.diff = 'x' * 100001
        detail = automation.skill_operation(dict(profile='ranch', operation='skill_diff', pendingId='deadbeef'), self.journal)
        self.assertTrue(detail['truncated'])
        with self.assertRaisesRegex(automation.AutomationError, 'too large'):
            automation.skill_operation(dict(profile='ranch', operation='skill_decide', pendingId='deadbeef', revision=detail['revision'], decision='approve'), self.journal)
        self.assertEqual(self.applies, 0)
        with self.assertRaises(automation.AutomationError): automation.identity('../native')


if __name__ == '__main__': unittest.main()
