"""Native credential acceptance inside service_probe's marked Google-gated home.

Only public synthetic values are used. Returned evidence contains booleans,
never password values, native secret files or household metadata.
"""
import json
import os
from pathlib import Path
import threading
import time
from unittest.mock import patch


def exercise(client, headers, journal):
    home = Path(os.environ['HERMES_HOME'])
    assert home.is_absolute() and (home / '.agent-interface-isolated').read_text() == 'agent-interface-disposable-spike'
    from hermes_constants import get_default_hermes_root, get_process_hermes_home
    from hermes_cli import profiles as profiles_module
    assert get_default_hermes_root().resolve() == home.resolve(), "Fixture root escaped marked home"
    assert get_process_hermes_home().resolve() == home.resolve(), "Fixture process home escaped marked home"
    assert profiles_module._get_profiles_root().resolve() == (home / 'profiles').resolve(), "Fixture profiles escaped marked home"
    from tui_gateway import server, server_requests
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_cli.config import save_env_value_secure, load_env, remove_env_value
    from agent.redact import redact_sensitive_text
    from agent.vault_backends import backend_for_handle
    from tools import browser_vault_tool as browser
    from service_auth import PREFIX
    profile, other = 'vault-proof', 'vault-other'
    canary = 'CanarySyntheticVaultPassword-619ef86f!'
    env_canary = 'CanarySyntheticApiSecret-5228de36!'
    checks = {}
    def rpc(method, **params):
        frame = server.handle_request(dict(jsonrpc='2.0', id='vault-probe', method=method, params=params))
        assert 'error' not in frame, 'Native credential fixture RPC refused: ' + method
        return frame.get('result', {})
    def call(operation='overview', target=profile, **fields):
        response = client.post(PREFIX + 'agent-interface/credentials', headers=headers,
            json=dict(operation=operation, profile=target, **fields))
        assert canary not in response.text and env_canary not in response.text, 'Secret escaped native bridge response'
        return response
    roster = rpc('profiles.list', include_sessions=False)['profiles']
    assert Path(next(row['path'] for row in roster if row['name']=='default')).resolve() == home.resolve(), "Native default profile escaped marked fixture"
    assert not any(row['name'] in (profile, other) for row in roster), "Owned fixture profile names already exist"
    rpc('profiles.create', name=profile, no_alias=True)
    rpc('profiles.create', name=other, no_alias=True)
    for name in (profile, other):
        assert Path(profiles_module.get_profile_dir(name)).resolve() == (home / 'profiles' / name).resolve(), "Native created profile outside marked home"
    snapshot = rpc('agent-interface.open', profile=profile)
    sid, epoch = snapshot['session_id'], snapshot['executor_epoch']
    login = dict(label='Synthetic login', origin='https://site.example.test', identifierType='email', identifier='public@example.test', password=canary)
    try:
        assert client.post('/api/agent-interface/credentials', headers=headers, json=dict(operation='overview',profile=profile)).status_code == 401
        assert client.post(PREFIX + 'agent-interface/credentials', json={}).status_code == 401
        assert client.post(PREFIX + 'agent-interface/credentials/extra', headers=headers, json={}).status_code == 404
        response = call('add_login', login=login)
        assert response.status_code == 200, 'Native login save failed'
        identity = response.json()['id']
        response = call()
        assert response.status_code == 200
        row = next(item for item in response.json()['items'] if item['id'] == identity)
        assert row['canRemove'] and row['backend'] == 'local' and row['identifier'] == login['identifier']
        assert not any(item['id'] == identity for item in call(target=other).json()['items'])
        with _config_profile_scope(profile):
            backend = backend_for_handle(identity)
            assert backend.resolve_secret(identity)['password'] == canary
            profile_home = Path(server._profile_home(profile))
            encrypted = profile_home / 'vault/vault.json.enc'
            key = profile_home / 'vault/vault.key'
            assert canary.encode() not in encrypted.read_bytes()
            assert encrypted.stat().st_mode & 0o777 == key.stat().st_mode & 0o777 == 0o600
        checks['native_encrypted_store_profile_scope_metadata_only'] = True
        # Native request registry + actual canonical session owner. No substitute
        # request.answer call is used: every answer crosses the finite private HTTP bridge.
        for method, params in [('vault.save_login', {'origin':login['origin'],'site':'Synthetic site'}),
                               ('vault.code', {'site':'Synthetic site','hint':'Public code hint'}),
                               ('vault.unlock_prompt', {'backend':'bitwarden','display_name':'Bitwarden'}),
                               ('secret', {'env_var':'VAULT_PROBE_API_SECRET','prompt':'Synthetic API secret'})]:
            request = server_requests.ServerRequest(sid, method, params)
            server_requests._register(request)
            payload = dict(epoch=epoch, sessionId=sid, method=method)
            payload.update(dict(identifier=login['identifier'],password=canary) if method=='vault.save_login' else dict(value=env_canary if method=='secret' else '123456'))
            for wrong in [dict(epoch='old'),dict(sessionId='wrong'),dict(method='vault.code' if method!='vault.code' else 'secret')]:
                assert call('answer',requestId=request.id,answer={**payload,**wrong}).status_code in (400,409)
                assert not request.answered
            assert call('answer',target=other,requestId=request.id,answer=payload).status_code == 409
            assert call('answer',requestId=request.id,answer={**payload, 'origin':'https://foreign.example.test'}).status_code == 400
            response = call('answer',requestId=request.id,answer=payload)
            assert response.status_code == 200 and response.json()['status'] == 'ok'
            assert request.answered and request.result['value']
            assert call('answer',requestId=request.id,answer=payload).json()['status'] == 'expired'
            if method == 'secret':
                # Same native saver called by native secret_cb, under actual
                # owning profile's secret scope. API-secret storage is .env,
                # distinct from the encrypted login vault, exactly as Hermes owns it.
                with _config_profile_scope(profile):
                    result = save_env_value_secure(params['env_var'], request.result['value'])
                    assert result == {'success':True,'stored_as':params['env_var'],'validated':False}
                    assert load_env()[params['env_var']] == env_canary
                    assert env_canary not in redact_sensitive_text('echo ' + env_canary, force=True)
                    from tools.registry import registry
                    import shlex
                    output_file=profile_home / 'synthetic-output.txt'
                    output_file.write_text(env_canary)
                    file_result=registry.dispatch('read_file',{'path':str(output_file)},task_id='vault-proof')
                    terminal_result=registry.dispatch('terminal',{'command':'cat '+shlex.quote(str(output_file)),'timeout':5},task_id='vault-proof')
                    for output in (file_result,terminal_result):
                        parsed=json.loads(output) if isinstance(output,str) else output
                        assert not parsed.get('error') and parsed.get('exit_code',0)==0, 'Native subsequent tool failed instead of exercising redaction: '+str(parsed).replace(env_canary,'[masked]').replace(canary,'[masked]')
                        assert env_canary not in str(parsed) and '«redacted-vault-secret»' in str(parsed), "Native subsequent tool did not produce redacted captured content"
                    output_file.unlink()
                with _config_profile_scope(other):
                    assert load_env().get(params['env_var']) != env_canary
                    assert redact_sensitive_text('echo '+env_canary,force=True)=='echo '+env_canary, "Redactor borrowed another profile's secret"
        checks['native_four_prompt_scopes_once_epoch_and_model_blind_values'] = True
        checks['native_named_secret_scope_persistence_and_redaction'] = True
        # Cancellation and another native client settling between validation
        # and resolution must never replay or settle a later request.
        for action in ('cancel', 'answer'):
            request = server_requests.ServerRequest(sid,'vault.code',{'site':'Synthetic site','hint':''})
            server_requests._register(request)
            original = server_requests.resolve_response
            def raced(frame):
                original(dict(id=request.id,result={'value':'' if action=='cancel' else '654321'}))
                return original(frame)
            with patch.object(server_requests,'resolve_response',raced):
                response = call('answer',requestId=request.id,answer=dict(epoch=epoch,sessionId=sid,method='vault.code',value='123456'))
                assert response.json()['status'] == 'expired'
        checks['native_cancel_and_other_answer_race_expired_without_replay'] = True
        # Actual native origin and model-egress guards. Browser hardware is
        # replaced at the supervisor boundary only; native vault lookup, origin
        # checks, classifiers, secret resolution and result redaction execute.
        with _config_profile_scope(profile):
            with patch.object(browser,'_focus_bound_origin',return_value=None), patch.object(browser,'_current_page_origin',return_value='https://foreign.example.test'), patch.object(browser,'_eval_js_secret') as write:
                result=json.loads(browser.browser_vault_fill(identity,task_id='vault-proof'))
                assert result['error_type']=='origin_mismatch'; write.assert_not_called()
            controls=[dict(index=0,tag='input',type='password',name='password',id='password',autocomplete='current-password',visible=True,disabled=False,readonly=False)]
            with patch.object(browser,'_focus_bound_origin',return_value=login['origin']), patch.object(browser,'_eval_js',return_value={'success':True,'result':controls}), patch.object(browser,'_eval_js_secret',return_value={'success':True,'result':{'refused':'origin_changed','found':'https://foreign.example.test'}}):
                result=json.loads(browser.browser_vault_fill(identity,task_id='vault-proof'))
                assert result.get('error_type')=='origin_changed', 'Native mid-fill origin guard was bypassed'
            assert canary not in redact_sensitive_text('Browser echo '+canary,force=True)
        checks['native_exact_origin_mid_fill_navigation_and_vault_egress_redaction'] = True
        # Incoming capture never calls admission or the journal. Verify native
        # canonical history and all durable add-on rows remain secret-free.
        final = rpc('agent-interface.open',profile=profile)
        assert final['messages'] == snapshot['messages']
        for table in ('receipts','events','tools'):
            rows=journal.db.execute('SELECT * FROM '+table).fetchall()
            assert canary not in repr(rows) and env_canary not in repr(rows)
        if home.joinpath('logs').exists():
            for path in home.joinpath('logs').rglob('*'):
                if path.is_file():
                    assert canary.encode() not in path.read_bytes() and env_canary.encode() not in path.read_bytes()
        checks['synthetic_values_absent_canonical_rows_addon_journal_logs_and_http'] = True
        response=call('remove_login',itemId=identity)
        assert response.status_code==200 and response.json()['removed']
        assert not any(item['id']==identity for item in call().json()['items'])
        checks.update(canonical_task(client,headers,journal,home,profile,call,canary))
        checks['native_remove_local_and_missing_manager_explicit'] = True
        for row in call().json()['sources']:
            if row['name']!='local' and not row['installed']:
                assert not row['canUnlock'] and not row['canToggle']
                assert call('unlock',source=row['name'],password=canary).status_code==409
        return checks
    finally:
        with _config_profile_scope(profile): remove_env_value('VAULT_PROBE_API_SECRET')
        rpc('session.close',session_id=sid)
        # Owned marked-home fixture only; remove its temporary credentials.
        # Remove only temporary credential files. Retain sanitized log/history
        # evidence until the disposable process and queued native log sink exit.
        import shutil
        for name in (profile,other):
            owned = Path(profiles_module.get_profile_dir(name)).resolve()
            assert owned == (home / 'profiles' / name).resolve()
            shutil.rmtree(owned / "vault", ignore_errors=True)
            assert not (owned / "vault").exists(), "Temporary encrypted credential cleanup failed"


def canonical_task(client, headers, journal, home, profile, call, canary):
    """Real canonical model-wire tool call and native fill on a disposable page."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import queue
    import signal
    import subprocess
    import urllib.request
    import uuid
    from websockets.sync.client import connect
    from provider import Provider
    from hermes_cli.web_server_profiles import _config_profile_scope
    from hermes_cli.config import load_config, save_config
    from tools import browser_vault_tool as browser
    from tools.registry import registry
    from tui_gateway import server
    from service_auth import TICKET_PATH
    from computer import install as install_computer
    class Page(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def do_GET(self):
            self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers()
            self.wfile.write(b'<html><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password"></html>')
    page = ThreadingHTTPServer(('127.0.0.1',0), Page)
    model = ThreadingHTTPServer(('127.0.0.1',0), Provider)
    threads=[threading.Thread(target=service.serve_forever,daemon=True) for service in (page,model)]
    for thread in threads: thread.start()
    origin='http://127.0.0.1:'+str(page.server_port)
    source=Path(__import__('hermes_cli').__file__).resolve().parents[1]
    # Native committed tool resolution; fixture never installs browser packages.
    from hermes_cli.browser_runtime import chromium_executable
    selected = chromium_executable()
    executable = Path(selected) if selected else None
    assert executable and executable.is_file() and os.access(executable,os.X_OK), 'An executable native Chromium is required for secure-fill acceptance'
    browser_home=home/'runtime/vault-browser';browser_home.mkdir(parents=True,mode=0o700)
    import tempfile
    chrome_tmp=Path(tempfile.mkdtemp(prefix='agentui-vault-browser-',dir='/tmp'))
    log=(browser_home/'chromium.log').open('wb')
    process=subprocess.Popen([str(executable),'--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--disable-breakpad','--disable-crash-reporter','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+str(browser_home/'data'),origin],stdout=log,stderr=log,start_new_session=True,env={**os.environ,'TMPDIR':str(chrome_tmp),'TMP':str(chrome_tmp),'TEMP':str(chrome_tmp)})
    provider_log=home/'runtime/vault-provider.jsonl'
    previous_log=os.environ.get('HERMES_SPIKE_PROVIDER_LOG')
    os.environ['HERMES_SPIKE_PROVIDER_LOG']=str(provider_log)
    resource=(home/'runtime/vault-computer').resolve()
    try:
        port_file=browser_home/'data/DevToolsActivePort'
        deadline=time.monotonic()+15
        while not port_file.exists() and process.poll() is None and time.monotonic()<deadline: time.sleep(.05)
        assert port_file.exists(), 'Disposable Chromium did not start; exit='+str(process.poll())
        endpoint='http://127.0.0.1:'+port_file.read_text().splitlines()[0]
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(endpoint+'/json/list',timeout=3) as response: targets=json.load(response)
        target=next(row for row in targets if row.get('type')=='page')
        class Supervisor:
            def evaluate_runtime(self,expression):
                with connect(target['webSocketDebuggerUrl'],open_timeout=3,proxy=None) as socket:
                    socket.send(json.dumps(dict(id=1,method='Runtime.evaluate',params=dict(expression=expression,returnByValue=True,awaitPromise=True))))
                    while True:
                        frame=json.loads(socket.recv(timeout=5))
                        if frame.get('id')==1:
                            result=frame.get('result',{})
                            return dict(ok='error' not in frame and 'exceptionDetails' not in result,result=result.get('result',{}).get('value'))
            def focus_page(self,bound,accept=None):
                found=self.evaluate_runtime('location.origin')['result']
                return dict(ok=not bound or found==bound,url=found)
        supervisor=Supervisor()
        deadline=time.monotonic()+10
        while supervisor.evaluate_runtime('location.origin')['result']!=origin and time.monotonic()<deadline:time.sleep(.05)
        assert supervisor.evaluate_runtime('location.origin')['result']==origin, 'Synthetic login page did not load'
        os.environ.update(HERMES_AGENT_INTERFACE_COMPUTER_HOME=str(resource),HERMES_AGENT_INTERFACE_COMPUTER_CDP_URL=endpoint)
        install_computer(server)
        computer=registry._agent_interface_computer
        # Browser is real; only native X11/desktop lifecycle is absent in this
        # isolated headless fixture. Actual file-backed native leases stay intact.
        computer.runtime.start=lambda:None
        computer.runtime.status=lambda:type('Status',(),dict(supported=True,installed=True,running=True))()
        with _config_profile_scope(profile):
            config=load_config();base='http://127.0.0.1:'+str(model.server_port)+'/v1'
            config.update(model=dict(default='spike-model',provider='spike-fixture',base_url=base),providers={'spike-fixture':dict(base_url=base,api_key='isolated-fixture',models=['spike-model'])},agent=dict(max_turns=3),terminal=dict(backend='local',cwd=str(home)))
            save_config(config)
        ticket=client.post(TICKET_PATH,headers=headers).json()['ticket']
        with client.websocket_connect('ws://127.0.0.1/api/ws?ticket='+ticket) as socket:
            incoming=queue.Queue(); frames=[]
            def reader():
                try:
                    while True:
                        frame=socket.receive_json();frames.append(frame);incoming.put(frame)
                except BaseException: pass
            reader_thread=threading.Thread(target=reader,daemon=True);reader_thread.start()
            count=0
            def rpc(method,**params):
                nonlocal count
                count+=1;identity=count
                socket.send_json(dict(jsonrpc='2.0',id=identity,method=method,params=params))
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    frame=incoming.get(timeout=max(.01,deadline-time.monotonic()))
                    if frame.get('id')==identity:
                        assert 'error' not in frame, 'Canonical credential fixture RPC refused: '+method
                        return frame.get('result',{})
                raise AssertionError('Canonical credential fixture RPC timed out')
            rpc('client.capabilities',server_requests=True)
            initial=rpc('agent-interface.open',profile=profile)
            sid=initial['session_id']
            before=len(call().json()['items'])
            def ordinary_eval(task_id,expression):
                result=supervisor.evaluate_runtime(expression)
                return dict(success=result['ok'],result=result['result'])
            with patch.object(browser,'_ensure_supervisor',return_value=supervisor),patch.object(browser,'_eval_js',side_effect=ordinary_eval),patch.object(browser,'_bot_desktop_browser_session',return_value=True):
                for takeover in (False,True):
                    request_id='vault-native-task-'+uuid.uuid4().hex
                    rpc('agent-interface.submit',profile=profile,session_id=sid,request_id=request_id,sender_id='synthetic-person',text='PROBE_VAULT_LOGIN Public synthetic login proof',attachments=[])
                    deadline=time.monotonic()+20
                    pending=None
                    while time.monotonic()<deadline:
                        state=rpc('agent-interface.open',profile=profile)
                        pending=next((r for r in state.get('open_requests',[]) if r['method']=='vault.save_login'),None)
                        if pending:break
                        if state.get('app_task_state') in ('done','failed') and not state.get('app_run_id'):break
                        time.sleep(.05)
                    assert pending and pending.get('app_local_secure') is True, 'Actual native canonical tool did not produce a locally owned secure prompt'
                    assert pending['params']['origin']==origin
                    if takeover:
                        actor=dict(actorId='synthetic-person',actorName='Synthetic person',service_key=os.environ['HERMES_AGENT_INTERFACE_TOKEN'])
                        viewer=computer.request(dict(action='observe',**actor))['viewerId']
                        computer.request(dict(action='take',viewerId=viewer,**actor))
                        computer.request(dict(action='release',viewerId=viewer,**actor))
                    response=call('answer',requestId=pending['id'],answer=dict(epoch=state['executor_epoch'],sessionId=sid,method='vault.save_login',identifier='public@example.test',password=canary))
                    assert response.status_code==200 and response.json()['status']=='ok'
                    deadline=time.monotonic()+20
                    while time.monotonic()<deadline:
                        state=rpc('agent-interface.open',profile=profile)
                        if not state.get('app_run_id') and not state.get('info',{}).get('running'):break
                        time.sleep(.05)
                    assert not state.get('app_run_id'), 'Canonical credential tool did not settle'
                    items=call().json()['items']
                    assert len(items)==before+(0 if takeover else 1), 'Human takeover did not fence native vault save'
                    if not takeover:
                        before+=1
                        assert supervisor.evaluate_runtime('document.querySelector("input[type=password]").value')['result']==canary, 'Native secret fill did not reach the synthetic page'
                        supervisor.evaluate_runtime('document.querySelector("input[type=password]").value=""')
                    else:
                        assert supervisor.evaluate_runtime('document.querySelector("input[type=password]").value')['result']=='', 'Old browser action filled after a human takeover'
                    assert canary not in json.dumps(state) and canary not in json.dumps(frames), 'Captured secret escaped canonical rows or event frames'
            foreign='http://localhost:'+str(page.server_port)
            def navigate(url):
                supervisor.evaluate_runtime('location.href='+json.dumps(url))
                deadline=time.monotonic()+10
                while supervisor.evaluate_runtime('location.origin')['result']!=url and time.monotonic()<deadline:time.sleep(.05)
                assert supervisor.evaluate_runtime('location.origin')['result']==url
            def changed_origin(task_id,expression):
                result=ordinary_eval(task_id,expression)
                if 'data-hermes-vault-slot' in expression:navigate(foreign)
                return result
            with _config_profile_scope(profile),patch.object(browser,'_ensure_supervisor',return_value=supervisor),patch.object(browser,'_eval_js',side_effect=changed_origin),patch.object(browser,'_bot_desktop_browser_session',return_value=True):
                handle=next(item['id'] for item in call().json()['items'] if item['origin']==origin)
                result=json.loads(browser.browser_vault_fill(handle,task_id='vault-proof'))
                assert result.get('error_type')=='origin_changed', 'Actual browser navigation escaped native origin guard'
                assert supervisor.evaluate_runtime('document.querySelector("input[type=password]").value')['result']=='', 'Secret reached newly navigated origin'
                navigate(origin)
            assert provider_log.exists() and canary.encode() not in provider_log.read_bytes(), 'Captured secret entered model request history'
        reader_thread.join(timeout=2)
        return dict(native_canonical_tool_secure_prompt_and_actual_cdp_fill=True,native_take_release_during_prompt_prevents_save_and_fill=True,native_model_wire_canonical_rows_and_frames_secret_free=True,native_actual_cdp_navigation_before_fill_refused=True)
    finally:
        if previous_log is None:os.environ.pop('HERMES_SPIKE_PROVIDER_LOG',None)
        else:os.environ['HERMES_SPIKE_PROVIDER_LOG']=previous_log
        if process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        log.close()
        import shutil
        shutil.rmtree(chrome_tmp)
        for service in (page,model):service.shutdown();service.server_close()
        for thread in threads:thread.join(timeout=2)
