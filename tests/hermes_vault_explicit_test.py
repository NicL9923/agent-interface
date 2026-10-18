"""Logins requested by address: the agent tool, its request binding and owner-bound answers.

Native modules are stubbed at their seams. scripts/spike/vault_probe.py runs the same flow
against real Hermes.
"""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import threading
import types
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location('vault_explicit_addon', Path(__file__).resolve().parents[1] / 'src/hermes/vault.py')
vault = importlib.util.module_from_spec(spec); spec.loader.exec_module(vault)
CANARY = 'Canary-Explicit-Login-5f0c2b!'
ORIGIN = 'https://comet-pro-kvm.mesh.wildflowersranch.com'


def normalize_origin(value):
    parts = urlsplit(value)
    port = parts.port
    default = {'https': 443, 'http': 80}[parts.scheme]
    return f'{parts.scheme}://{parts.hostname}' + ('' if port in (None, default) else f':{port}')


class Native:
    """The native seams the tool uses: prompt callback, profile, redaction and the local vault."""
    def __init__(self):
        self.prompt, self.can_prompt, self.redacted, self.saved, self.fail = None, True, [], [], None
        store = types.SimpleNamespace(add_item=self.add_item)
        self.modules = {
            'agent': types.ModuleType('agent'),
            'agent.vault_backends': types.ModuleType('agent.vault_backends'),
            'agent.vault_backends.unlock': types.SimpleNamespace(get_save_login_prompt_callback=lambda: self.prompt,
                                                                  can_prompt_here=lambda: self.can_prompt),
            'agent.redact': types.SimpleNamespace(register_vault_redaction_value=self.redacted.append),
            'agent.vault_store': types.SimpleNamespace(normalize_origin=normalize_origin, get_vault_store=lambda: store),
            'hermes_constants': types.SimpleNamespace(get_hermes_home=lambda: '/profiles/patch',
                                                      profile_name_for_home=lambda home: 'patch'),
        }

    def add_item(self, kind, label, secret, origin=None):
        if self.fail:
            raise RuntimeError(self.fail)
        self.saved.append(dict(kind=kind, label=label, secret=dict(secret), origin=origin))
        return types.SimpleNamespace(id='vault_0123456789ab', label=label, origin=origin)


class ToolTests(unittest.TestCase):
    def setUp(self):
        self.native = Native()
        self.patch = patch.dict(sys.modules, self.native.modules); self.patch.start()
        self.args = dict(origin=ORIGIN, label='Comet KVM', purpose='Sign in to the KVM to check the server console.')
        self.seen = []
        def prompt(origin, site):
            self.seen.append((origin, site, dict(vault._context.value or {})))
            return {'identifier': 'kvm-admin', 'password': CANARY}
        self.native.prompt = prompt

    def tearDown(self):
        self.patch.stop()

    def call(self, **changes):
        return json.loads(vault.save_explicit_login({**self.args, **changes}))

    def test_saves_for_the_explicit_origin_without_returning_the_password(self):
        result = self.call()
        self.assertEqual(result['status'], 'saved')
        self.assertEqual((result['handle'], result['origin'], result['identifier'], result['used']), ('vault_0123456789ab', ORIGIN, 'kvm-admin', False))
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertEqual(self.native.saved, [dict(kind='login', label='Comet KVM', origin=ORIGIN,
                                                  secret=dict(identifier_type='username', identifier='kvm-admin', password=CANARY))])
        self.assertEqual(self.native.redacted, [CANARY])
        origin, site, context = self.seen[0]
        self.assertEqual((origin, site, context['label'], context['profile']), (ORIGIN, 'comet-pro-kvm.mesh.wildflowersranch.com', 'Comet KVM', 'patch'))
        self.assertIsNone(getattr(vault._context, 'value', None))

    def test_the_answer_is_cleared_after_saving(self):
        answer = {'identifier': 'kvm-admin', 'password': CANARY}
        self.native.prompt = lambda origin, site: answer
        self.call()
        self.assertEqual(answer, {})

    def test_cancel_timeout_failed_prompt_and_partial_answers_save_nothing(self):
        def raises(origin, site):
            raise RuntimeError('surface went away')
        for prompt in (lambda o, s: None, lambda o, s: {}, lambda o, s: {'identifier': 'kvm-admin'},
                       lambda o, s: {'identifier': ' ', 'password': CANARY}, lambda o, s: 'not a dict', raises):
            self.native.prompt = prompt
            result = self.call()
            self.assertEqual(result['error_type'], 'not_saved')
            self.assertNotIn(CANARY, json.dumps(result))
        self.assertEqual(self.native.saved, [])

    def test_a_surface_without_a_masked_prompt_refuses_without_asking(self):
        for prompt, can in ((None, True), (lambda o, s: self.fail('asked'), False)):
            self.native.prompt, self.native.can_prompt = prompt, can
            result = self.call()
            self.assertEqual(result['error_type'], 'prompt_unavailable')
            self.assertIn('Do not ask for the login in chat or with clarify', result['error'])
        self.assertEqual(self.native.saved, [])

    def test_invalid_origins_never_reach_the_prompt(self):
        self.native.prompt = lambda o, s: self.fail('asked for ' + o)
        for origin in ['comet.local', 'ftp://example.test', 'https://user:pw@example.test', 'https://example.test/login',
                       'https://example.test?next=1', 'https://example.test#x', 'https://exämple.test', 'https://[::1]',
                       'https://example.test:0', 'https://example.test:99999', 'https://-bad.example.test', ' https://example.test',
                       'https://example.test‮', 'javascript:alert(1)', 'https://999.1.1.1', 'https://', 'https://exa%6dple.test',
                       'https://example.test.', 'https:example.test', 'https://example.test\\@evil.test', None, 42, 'https://' + 'a' * 2048,
                       # Browsers read these as IPv4 addresses, so a login saved for them would never fill.
                       'https://0x7f000001', 'https://1.0x2', 'https://0177.0.0.1', 'https://kvm.example.0x1', 'https://10.1']:
            self.assertEqual(self.call(origin=origin)['error_type'], 'invalid_origin', origin)

    def test_valid_origins_are_normalized(self):
        for origin, expected in [(ORIGIN, ORIGIN), ('https://192.0.2.10:8443', 'https://192.0.2.10:8443'),
                                 ('http://10.0.0.5', 'http://10.0.0.5'), ('https://Example.TEST:443/', 'https://example.test'),
                                 ('https://0xdead.example.test', 'https://0xdead.example.test')]:
            self.assertEqual(self.call(origin=origin)['origin'], expected)

    def test_label_purpose_and_unexpected_arguments_are_refused(self):
        self.native.prompt = lambda o, s: self.fail('asked')
        self.assertEqual(self.call(label='')['error_type'], 'invalid_label')
        self.assertEqual(self.call(label='x' * 81)['error_type'], 'invalid_label')
        self.assertEqual(self.call(label='Comet‮KVM')['error_type'], 'invalid_label')
        self.assertEqual(self.call(purpose=' ')['error_type'], 'invalid_purpose')
        self.assertEqual(self.call(purpose='x' * 301)['error_type'], 'invalid_purpose')
        result = self.call(password=CANARY)
        self.assertEqual(result['error_type'], 'invalid_arguments')
        self.assertNotIn(CANARY, json.dumps(result))
        self.assertEqual(json.loads(vault.save_explicit_login('not an object'))['error_type'], 'invalid_arguments')

    def test_whitespace_in_display_text_collapses(self):
        self.call(label='  Comet\n KVM ', purpose='Check\tthe console')
        self.assertEqual(self.seen[0][2]['label'], 'Comet KVM')
        self.assertEqual(self.seen[0][2]['purpose'], 'Check the console')

    def test_storage_failure_reports_without_the_exception_text(self):
        self.native.fail = 'disk full while writing ' + CANARY
        result = self.call()
        self.assertEqual(result['error_type'], 'save_failed')
        self.assertNotIn(CANARY, json.dumps(result))

    def test_schema_is_finite_and_its_catalog_sentence_fits(self):
        parameters = vault.SCHEMA['parameters']
        self.assertEqual(set(parameters['properties']), {'origin', 'label', 'purpose'})
        self.assertEqual(parameters['required'], ['origin', 'label', 'purpose'])
        self.assertIs(parameters['additionalProperties'], False)
        self.assertLessEqual(len(vault.SCHEMA['description'].split('. ')[0]), 60)


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.server_requests = types.SimpleNamespace(_register=self.sent.append)
        db = sqlite3.connect(':memory:', check_same_thread=False)
        db.execute('CREATE TABLE receipts(session_id TEXT, actor TEXT, terminal INTEGER, steering INTEGER, created REAL)')
        db.executemany('INSERT INTO receipts VALUES(?,?,?,?,?)', [('live', 'member-old', 1, 0, 1), ('live', 'member-a', 0, 0, 2),
                                                                 ('live', 'member-b', 0, 1, 3)])
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=db)
        vault.bind_requests(self.server_requests, self.journal)
        self.context = dict(origin=ORIGIN, label='Comet KVM', purpose='Check the console.', profile='patch', requests=[])

    def tearDown(self):
        vault._context.value = None
        vault._explicit.clear()

    def request(self, method='vault.save_login', origin=ORIGIN, sid='live'):
        return types.SimpleNamespace(id='srq-' + str(len(self.sent)), method=method, sid=sid, params=dict(origin=origin, site='x'))

    def test_records_the_request_this_thread_sends_with_the_task_owner(self):
        vault._context.value = self.context
        request = self.request()
        self.server_requests._register(request)
        self.assertEqual(self.sent, [request])
        self.assertEqual(self.context['requests'], [request.id])
        self.assertEqual(vault.explicit_metadata(request.id), dict(label='Comet KVM', purpose='Check the console.', profile='patch', requesterId='member-a'))

    def test_other_requests_and_other_threads_are_untouched(self):
        self.server_requests._register(self.request())
        vault._context.value = self.context
        self.server_requests._register(self.request(method='vault.code'))
        self.server_requests._register(self.request(origin='https://other.example.test'))
        other = threading.Thread(target=lambda: self.server_requests._register(self.request()))
        other.start(); other.join()
        self.assertEqual(len(self.sent), 4)
        self.assertEqual(vault._explicit, {})

    def test_a_task_without_an_app_sender_has_no_owner(self):
        vault._context.value = self.context
        request = self.request(sid='desktop-session')
        self.server_requests._register(request)
        self.assertIsNone(vault.explicit_metadata(request.id)['requesterId'])

    def test_installs_once(self):
        wrapped = self.server_requests._register
        vault.bind_requests(self.server_requests, self.journal)
        self.assertIs(self.server_requests._register, wrapped)


class AnswerTests(unittest.TestCase):
    def setUp(self):
        self.request = types.SimpleNamespace(sid='canonical', method='vault.save_login', params={'origin': ORIGIN, 'site': 'comet'})
        self.frames, self.lock, self.open = [], threading.Lock(), {'srq-explicit': self.request}
        def resolve(frame):
            with self.lock:
                found = self.open.pop(frame['id'], None)
                if found:
                    self.frames.append(frame)
                return bool(found)
        native = types.SimpleNamespace(_lock=self.lock, _open=self.open, resolve_response=resolve)
        self.patch = patch.dict(sys.modules, {'tui_gateway': types.SimpleNamespace(server_requests=native),
                                              'agent.redact': types.SimpleNamespace(register_vault_redaction_value=lambda value: None)})
        self.patch.start()
        self.journal = types.SimpleNamespace(epoch='epoch', canonical_session=lambda p: 'canonical', live_profile_for_session=lambda s: 'patch')
        vault._explicit['srq-explicit'] = dict(origin=ORIGIN, label='Comet KVM', purpose='Check.', profile='patch', actor='member-a', sid='canonical')
        self.owner = dict(epoch='epoch', sessionId='canonical', method='vault.save_login')
        self.login = dict(self.owner, identifier='kvm-admin', password=CANARY, origin=ORIGIN)

    def tearDown(self):
        self.patch.stop()
        vault._explicit.clear()

    def answer(self, answer, actor='member-a'):
        data = dict(operation='answer', profile='patch', requestId='srq-explicit', answer=answer)
        if actor is not None:
            data['actor'] = actor
        return vault.operate(None, self.journal, data)

    def refused(self, answer, actor='member-a'):
        with self.assertRaises(vault.VaultError):
            self.answer(answer, actor)
        self.assertEqual(self.frames, [])
        self.assertIn('srq-explicit', self.open)

    def test_only_the_owner_settles_with_the_destination_it_saw(self):
        self.refused({k: v for k, v in self.login.items() if k != 'origin'})
        self.refused(dict(self.login, origin='https://comet-pro-kvm.mesh.wildflowersranch.com.evil.test'))
        self.refused(self.login, actor='member-b')
        self.refused(self.login, actor=None)
        self.refused(dict(self.owner, cancel=True), actor='member-b')
        self.refused(dict(self.login, epoch='old'))
        self.assertEqual(self.answer(self.login), {'status': 'ok'})
        self.assertEqual(json.loads(self.frames[0]['result']['value']), {'identifier': 'kvm-admin', 'password': CANARY})
        self.assertEqual(self.answer(self.login), {'status': 'expired'})

    def test_owner_cancel_settles_empty(self):
        self.assertEqual(self.answer(dict(self.owner, cancel=True)), {'status': 'ok'})
        self.assertEqual(self.frames[0]['result'], {'value': ''})

    def test_a_changed_native_destination_or_session_is_refused(self):
        self.request.params['origin'] = 'https://other.example.test'
        self.refused(self.login)
        self.request.params['origin'] = ORIGIN
        vault._explicit['srq-explicit']['sid'] = 'previous-session'
        self.refused(self.login)

    def test_without_an_app_owner_any_member_may_answer(self):
        vault._explicit['srq-explicit']['actor'] = None
        self.assertEqual(self.answer(self.login, actor='member-b'), {'status': 'ok'})

    def test_a_browser_page_request_keeps_its_contract(self):
        vault._explicit.clear()
        self.refused(self.login)
        self.assertEqual(self.answer({k: v for k, v in self.login.items() if k != 'origin'}, actor=None), {'status': 'ok'})

    def test_an_expired_request_is_reported_expired(self):
        self.open.clear()
        self.assertEqual(self.answer(self.login), {'status': 'expired'})


if __name__ == '__main__':
    unittest.main()
