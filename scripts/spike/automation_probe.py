"""Real native automation contracts against the already running disposable executor.

The launcher owns source revision, dependency interpreter, gateway and admission.
This probe never starts a gateway, promotes a task or fires a routine.
Goal resume uses the existing deterministic provider and durable app admission.
"""
import asyncio
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from extension_probe import Client, settled
from guard import verify_target


PROFILE = 'automation-owner'
OTHER = 'automation-other'


def call(operation, profile=PROFILE, **fields):
    data = dict(operation=operation, profile=profile, **fields)
    data.setdefault('visibleProfiles', [PROFILE, OTHER])
    request = urllib.request.Request(os.environ['HERMES_SPIKE_URL'] + '/api/agent-interface/service/agent-interface/automation',
        method='POST', headers={'Authorization': 'Bearer ' + os.environ['HERMES_SPIKE_TOKEN'], 'Content-Type': 'application/json'}, data=json.dumps(data).encode())
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


async def main():
    home = Path(os.environ['HERMES_HOME'])
    verify_target(home, os.environ['HERMES_SPIKE_URL'], os.environ['HERMES_SPIKE_TOKEN'])
    client = await Client().connect()
    checks, created_tasks = {}, []
    job_id, trigger_id = None, 'native-automation-probe'
    from hermes_cli.web_server_profiles import _profile_scope
    from hermes_cli import kanban_db as kb
    from hermes_cli.kanban_db_connect import connect_closing
    from tools import write_approval as wa
    try:
        await client.call('profiles.create', name=PROFILE, no_alias=True)
        await client.call('profiles.create', name=OTHER, no_alias=True)
        status, overview = call('overview')
        assert status == 200, overview
        assert all(overview[key]['supported'] for key in ('goals', 'tasks', 'triggers', 'skills')), overview
        canonical = await client.call('agent-interface.open', profile=PROFILE, omit_messages=True)
        baseline_id = str(uuid.uuid4())
        baseline = await client.call('agent-interface.submit', profile=PROFILE, session_id=canonical['session_id'],
            request_id=baseline_id, sender_id='automation-fixture', text='Public synthetic chat before native goal controls', attachments=[])
        assert baseline['status'] == 'accepted', baseline
        canonical = await settled(client, profile=PROFILE)
        from hermes_cli import active_sessions as active
        from hermes_cli.profiles import get_profile_dir
        profile_home = get_profile_dir(PROFILE)
        entries = active.active_session_registry_snapshot(registry_home=profile_home, strict=True)
        assert any(row.get('session_id') == canonical['canonical_stored_session_id'] and row.get('metadata', {}).get('live_session_id') == canonical['session_id'] for row in entries), 'Native chat did not leave its own lifetime lease'
        checks['native_goal_controls_after_prior_chat_own_lease'] = True
        goal_title = 'PROBE_SLOW Public synthetic native goal ' + uuid.uuid4().hex
        status, goal = call('goal_set', title=goal_title, maxTurns=7)
        assert status == 200 and goal['goals']['goal']['status'] == 'paused', goal
        assert call('overview', profile=OTHER)[1]['goals']['goal'] is None
        # A real native registry entry from THIS separate probe process is a
        # foreign writer to the dashboard. Preserve every existing lease.
        state_path, lock_path = active._lease_paths(registry_home=profile_home)
        foreign = active._lease_entry(lease_id='automation-probe-' + uuid.uuid4().hex, session_id=canonical['canonical_stored_session_id'],
            surface='automation-probe', metadata={'live_session_id': 'foreign-probe'}, track_liveness=True)
        try:
            with active._FileLock(lock_path):
                rows = active._read_entries(state_path, strict=True)
                active._write_entries(state_path, [*rows, foreign])
            status, denied = call('goal_set', title='Foreign owner must refuse this edit', maxTurns=7)
            assert status == 409, denied
            assert call('skill_policy', approvalRequired=True)[0] == 200, 'Profile policy was incorrectly gated on a chat lease'
        finally:
            with active._FileLock(lock_path):
                rows = active._read_entries(state_path, strict=True)
                active._write_entries(state_path, [row for row in rows if row.get('lease_id') != foreign['lease_id']])
        assert call('overview')[1]['goals']['goal']['title'] == goal_title
        checks['native_goal_foreign_lease_refused'] = True
        checks['native_profile_changes_do_not_require_chat_idleness'] = True
        canonical = await client.call('agent-interface.open', profile=PROFILE, omit_messages=True)
        from hermes_cli.goals import GoalManager, save_goal
        with _profile_scope(PROFILE):
            manager = GoalManager(session_id=canonical['canonical_stored_session_id'])
            assert manager.state is not None
            manager.state.turns_used = manager.state.max_turns
            save_goal(manager.session_id, manager.state)
        request_id = str(uuid.uuid4())
        status, resumed = call('goal_resume', requestId=request_id, senderId='automation-fixture')
        assert status == 200 and resumed['goals']['resume']['status'] == 'accepted', resumed
        assert resumed['goals']['goal']['turnsUsed'] == 0, resumed
        log = Path(os.environ['HERMES_SPIKE_PROVIDER_LOG'])
        def requests():
            return [row for line in log.read_text().splitlines(keepends=True) if line.endswith('\n') and (row := json.loads(line)).get('messages')
                and any(message.get('role') == 'user' and goal_title in str(message.get('content', '')) for message in row['messages'])]
        for _ in range(300):
            if log.exists() and requests():
                break
            await asyncio.sleep(.05)
        else:
            raise AssertionError('Goal Resume did not invoke the deterministic provider')
        active = await client.call('agent-interface.open', profile=PROFILE, omit_messages=True)
        assert active['app_run_id'] == request_id and active.get('info', {}).get('running'), active
        status, paused = call('goal_pause')
        assert status == 200 and paused['goals']['goal']['status'] == 'paused', paused
        assert call('goal_resume', requestId=request_id, senderId='automation-fixture')[0] == 200
        assert call('overview')[1]['goals']['goal']['status'] == 'paused', 'A same-goal receipt replay resumed work'
        status, cleared = call('goal_clear')
        assert status == 200 and cleared['goals']['goal'] is None, cleared
        for _ in range(300):
            settled_snapshot = await client.call('agent-interface.open', profile=PROFILE, omit_messages=True)
            if not settled_snapshot.get('app_run_id') and not settled_snapshot.get('info', {}).get('running') and not (settled_snapshot.get('inflight') or {}).get('streaming'):
                break
            await asyncio.sleep(.05)
        else:
            raise AssertionError('Native goal provider turn did not settle')
        count = len(requests())
        assert call('goal_resume', requestId=request_id, senderId='automation-fixture')[0] == 409
        assert len(requests()) == count, 'A repeated resume request invoked the provider twice'
        receipt = await client.call('agent-interface.receipt', request_id=request_id)
        assert receipt['receipt']['runId'] == request_id and receipt['receipt']['senderId'] == 'automation-fixture', receipt
        checks['native_persistent_goal_controls'] = True
        checks['native_goal_resume_provider_and_durable_receipt'] = True
        checks['native_goal_exhausted_budget_reset'] = True
        checks['native_goal_pause_clear_during_provider_turn'] = True
        checks['native_goal_resume_no_replay'] = True
        checks['native_goal_cleared_replay_refused'] = True

        recovery_title = 'PROBE_SLOW Public synthetic interrupted goal ' + uuid.uuid4().hex
        assert call('goal_set', title=recovery_title, maxTurns=7)[0] == 200
        interrupted_id = str(uuid.uuid4())
        assert call('goal_resume', requestId=interrupted_id, senderId='automation-fixture')[1]['goals']['resume']['status'] == 'accepted'
        def recovery_requests():
            return [line for line in log.read_text().splitlines() if recovery_title in line]
        for _ in range(300):
            if recovery_requests():
                break
            await asyncio.sleep(.05)
        else:
            raise AssertionError('Recovery goal did not invoke the native provider')
        assert call('goal_pause')[1]['goals']['goal']['status'] == 'paused'
        await client.call('session.interrupt', profile=PROFILE, session_id=canonical['session_id'])
        await settled(client, profile=PROFILE)
        status, interrupted = call('overview')
        assert status == 200 and interrupted['goals']['interruptionPending'], interrupted
        unreviewed = str(uuid.uuid4())
        before_retry = len(recovery_requests())
        assert call('goal_resume', requestId=unreviewed, senderId='automation-fixture')[0] == 409
        assert call('overview')[1]['goals']['goal']['status'] == 'paused'
        assert len(recovery_requests()) == before_retry
        reviewed = str(uuid.uuid4())
        status, retry = call('goal_resume', requestId=reviewed, senderId='automation-fixture', reviewedInterruption=True)
        assert status == 200 and retry['goals']['resume']['status'] == 'accepted', retry
        for _ in range(300):
            if len(recovery_requests()) > before_retry:
                break
            await asyncio.sleep(.05)
        else:
            raise AssertionError('Explicitly reviewed goal retry did not invoke provider')
        assert call('goal_pause')[0] == 200
        assert call('goal_clear')[1]['goals']['goal'] is None
        await settled(client, profile=PROFILE)
        checks['native_goal_interruption_requires_explicit_review'] = True
        checks['native_goal_reviewed_retry_is_durably_admitted'] = True

        task_input = dict(requestId=str(uuid.uuid4()), title='Public synthetic durable task', body='Synthetic probe only', assignee=PROFILE)
        status, task = call('task_create', task=task_input)
        assert status == 200 and task['status'] == 'blocked' and task['owner'] == PROFILE, task
        created_tasks.append(task['id'])
        # Native idempotency returns the same blocked task after a lost response.
        status, repeat = call('task_create', task=task_input)
        assert status == 200 and repeat['id'] == task['id'], repeat
        assert call('task_get', profile=OTHER, taskId=task['id'])[0] == 404
        status, child = call('task_create', task=dict(requestId=str(uuid.uuid4()), title='Public synthetic dependent', dependencies=[task['id']]))
        assert status == 200 and child['dependencies'] == [task['id']], child
        created_tasks.append(child['id'])
        assert call('task_update', taskId=task['id'], title='Updated native durable task')[1]['title'] == 'Updated native durable task'
        assert call('task_update', taskId=task['id'], assignee=None)[1]['assignee'] is None
        assert call('task_update', taskId=task['id'], body='Unassigned native task')[1]['assignee'] is None
        checks['native_kanban_explicit_unassignment_and_omission'] = True
        assert call('task_dependency', taskId=child['id'], dependencyId=task['id'], remove=True)[1]['dependencies'] == []
        with _profile_scope(PROFILE), connect_closing() as conn:
            foreign_id = kb.create_task(conn, title='Hidden native task', assignee=OTHER, created_by=OTHER, initial_status='blocked', workspace_kind='scratch')
            created_tasks.append(foreign_id)
        assert call('task_dependency', taskId=child['id'], dependencyId=foreign_id, remove=False)[0] == 404
        status, hidden = call('overview', visibleProfiles=[PROFILE])
        assert status == 200 and foreign_id not in json.dumps(hidden), hidden
        checks['native_kanban_durable_blocked_creation'] = True
        checks['native_kanban_owner_dependencies_visibility'] = True
        checks['native_kanban_create_idempotency'] = True

        routine = await client.call('cron.manage', profile=PROFILE, action='add', name='[bot:automation-owner] Native event proof', prompt='Public synthetic routine', schedule='0 7 * * *', deliver='bot-chat:' + PROFILE, continuity=True)
        job = routine.get('job') or routine
        job_id = job.get('job_id') or job.get('id')
        if not job_id:
            jobs = (await client.call('cron.manage', profile=PROFILE, action='list'))['jobs']
            job_id = next(row.get('job_id') or row.get('id') for row in jobs if 'Native event proof' in row.get('name', ''))
        await client.call('cron.manage', profile=PROFILE, action='pause', name=job_id)
        trigger = dict(id=trigger_id, description='Public synthetic event subscription', events=['probe.created'], routineId=job_id)
        status, created = call('trigger_create', trigger=trigger)
        assert status == 200 and created.get('secret') and not created['subscription']['enabled'], created
        secret = created.pop('secret')
        assert secret not in json.dumps(call('overview')[1])
        assert call('trigger_create', profile=OTHER, trigger=trigger)[0] == 404
        assert call('trigger_toggle', triggerId=trigger_id, enabled=True, revision='0' * 64)[0] == 409
        status, updated = call('trigger_update', trigger={**trigger, 'description': 'Updated native event proof'}, revision=created['subscription']['revision'])
        assert status == 200 and 'secret' not in updated and not updated['subscription']['enabled'], updated
        assert call('trigger_delete', triggerId=trigger_id, revision=updated['subscription']['revision'])[0] == 200
        checks['native_event_subscription_routine_owner'] = True
        checks['native_event_subscription_paused_secret_once_cas'] = True

        assert call('skill_policy', approvalRequired=True)[0] == 200
        assert call('overview')[1]['skills']['approvalRequired'] is True
        name = 'automation-native-proof'
        content = '---\nname: automation-native-proof\ndescription: Synthetic native automation probe skill\n---\n\nPublic synthetic skill content.\n'
        with _profile_scope(PROFILE):
            record = wa.stage_write(wa.SKILLS, dict(action='create', name=name, content=content), summary='Public synthetic learned skill', origin='background_review')
        pending_id = record['id']
        status, diff = call('skill_diff', pendingId=pending_id)
        assert status == 200 and 'Public synthetic skill content' in diff['diff'] and not diff['truncated'], diff
        assert call('skill_diff', profile=OTHER, pendingId=pending_id)[0] == 404
        assert call('skill_decide', pendingId=pending_id, revision='0' * 64, decision='approve')[0] == 409
        status, decided = call('skill_decide', pendingId=pending_id, revision=diff['revision'], decision='approve')
        assert status == 200, decided
        assert call('skill_content', name=name)[1]['content'] == content
        assert call('skill_diff', pendingId=pending_id)[0] == 404
        with _profile_scope(PROFILE):
            record = wa.stage_write(wa.SKILLS, dict(action='delete', name=name), summary='Public synthetic reject proof', origin='foreground')
        detail = call('skill_diff', pendingId=record['id'])[1]
        assert call('skill_decide', pendingId=record['id'], revision=detail['revision'], decision='reject')[0] == 200
        assert call('skill_content', name=name)[0] == 200
        checks['native_learned_skill_diff_approve_reject'] = True
        checks['native_skill_policy_and_profile_scope'] = True
        evidence = Path(os.environ.get('HERMES_SPIKE_EVIDENCE_DIR', home)) / 'hermes-automation-probe.json'
        evidence.write_text(json.dumps(dict(revision=os.environ.get('HERMES_SPIKE_REVISION'), checks=checks), indent=2) + '\n')
        print(json.dumps(dict(checks=checks)))
    finally:
        original_error = sys.exception()
        cleanup_errors = []
        # Do not initialize a board after an earlier assertion failed. Close
        # native tasks in reverse dependency order and keep the original failure.
        if created_tasks:
            try:
                with _profile_scope(PROFILE), connect_closing() as conn:
                    for task_id in reversed(created_tasks):
                        kb.archive_task(conn, task_id)
            except Exception as error:
                cleanup_errors.append(('tasks', error))
        if job_id:
            try:
                await client.call('cron.manage', profile=PROFILE, action='remove', name=job_id)
            except Exception as error:
                cleanup_errors.append(('routine', error))
        # Profiles stay inside the launcher's marked disposable home. This native
        # revision has no profiles.delete RPC, and CLI deletion can stop the
        # executor that the remaining probes still own.
        try:
            await client.close()
        except Exception as error:
            cleanup_errors.append(('client', error))
        if cleanup_errors:
            if original_error is None:
                raise cleanup_errors[0][1]
            print('Probe cleanup incomplete after original failure: ' + ', '.join(name for name, _ in cleanup_errors), file=sys.stderr)


if __name__ == '__main__':
    asyncio.run(main())
