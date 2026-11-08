"""Scoped settlement races with the native immutable request-ID contract."""
import sqlite3
import sys
import threading
import types
import unittest
from unittest.mock import patch

from support import load_source
vault = load_source('src/hermes/vault.py', 'vault_addon')

class VaultTests(unittest.TestCase):
    def setUp(self):
        self.req=types.SimpleNamespace(sid='canonical',method='vault.save_login',params={'origin':'https://site.invalid'})
        self.frames=[]; self.lock=threading.Lock(); self.open={'srq-proof':self.req}
        def resolve(frame):
            with self.lock:
                found=self.open.pop(frame['id'],None)
                if found: self.frames.append(frame)
                return bool(found)
        self.native=types.SimpleNamespace(_lock=self.lock,_open=self.open,resolve_response=resolve)
        self.patch=patch.dict(sys.modules,{'tui_gateway':types.SimpleNamespace(server_requests=self.native),'agent.redact':types.SimpleNamespace(register_vault_redaction_value=lambda value:None)}); self.patch.start()
        self.journal=types.SimpleNamespace(epoch='epoch',canonical_session=lambda p:'canonical' if p=='one' else 'other',live_profile_for_session=lambda s:'one')
        self.data=dict(operation='answer',profile='one',requestId='srq-proof',answer=dict(epoch='epoch',sessionId='canonical',method='vault.save_login',identifier='user',password='Canary-Secret'))
    def tearDown(self): self.patch.stop()
    def test_wrong_profile_sid_epoch_method_and_extra_values_never_settle(self):
        for key,value in [('profile','two'),('epoch','old'),('sessionId','other'),('method','vault.code'),('origin','https://foreign.invalid')]:
            data={**self.data,'answer':dict(self.data['answer'])}
            if key=='profile': data[key]=value
            else: data['answer'][key]=value
            with self.assertRaises(vault.VaultError): vault.answer_request(None,self.journal,data)
            self.assertEqual(self.frames,[]); self.assertIn('srq-proof',self.open)
    def test_settlement_is_once_and_racing_native_cancel_is_expired(self):
        self.assertEqual(vault.answer_request(None,self.journal,self.data),{'status':'ok'})
        self.assertEqual(vault.answer_request(None,self.journal,self.data),{'status':'expired'})
        self.assertEqual(len(self.frames),1)
        self.open['srq-proof']=self.req
        original=self.native.resolve_response
        def cancel(frame):
            with self.lock: self.open.pop('srq-proof')
            return original(frame)
        self.native.resolve_response=cancel
        self.assertEqual(vault.answer_request(None,self.journal,self.data),{'status':'expired'})
        self.assertEqual(len(self.frames),1)
    def test_native_origin_and_backend_are_authoritative_and_cancel_is_empty(self):
        self.req.params['origin']='https://user:password@site.invalid'
        with self.assertRaises(vault.VaultError): vault.answer_request(None,self.journal,self.data)
        self.req.params['origin']='https://site.invalid'
        self.data['answer']={k:self.data['answer'][k] for k in ('epoch','sessionId','method')};self.data['answer']['cancel']=True
        self.assertEqual(vault.answer_request(None,self.journal,self.data),{'status':'ok'})
        self.assertEqual(self.frames[0]['result'],{'value':''})

class PromptWaitTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.db = sqlite3.connect(':memory:')
        self.addCleanup(self.db.close)
        self.db.execute('CREATE TABLE receipts(session_id TEXT, terminal INTEGER, steering INTEGER)')
        self.db.executemany('INSERT INTO receipts VALUES (?,0,0)', [('canonical',), ('default-chat',)])
        def ask(method, sid, params, timeout=300):
            self.calls.append((method, sid, params, timeout))
            return 'native result'
        self.server = types.SimpleNamespace(_ask=ask)
        self.journal = types.SimpleNamespace(
            db=self.db, lock=threading.Lock(),
            live_profile_for_session=lambda sid: {'canonical': 'one', 'other-chat': 'one', 'default-chat': 'default'}.get(sid),
            canonical_session=lambda profile: {'one': 'canonical', 'default': 'default-chat'}.get(profile),
        )

    def test_canonical_login_waits_for_the_person_instead_of_the_native_deadline(self):
        vault.bind_prompt_waits(self.server, self.journal)
        params = {'origin': 'https://site.invalid', 'site': 'site.invalid'}
        self.assertEqual(self.server._ask('vault.save_login', 'canonical', params, timeout=180), 'native result')
        self.assertEqual(self.calls, [('vault.save_login', 'canonical', params, None)])
        self.server._ask('vault.save_login', 'default-chat', params, timeout=180)
        self.assertIsNone(self.calls[-1][3])

    def test_other_chats_and_prompt_kinds_keep_their_native_deadlines(self):
        vault.bind_prompt_waits(self.server, self.journal)
        for method, sid in [('vault.save_login', 'other-chat'), ('vault.save_login', 'closed-chat'),
                            ('vault.code', 'canonical'), ('vault.unlock_prompt', 'canonical'),
                            ('secret', 'canonical'), ('sudo', 'canonical')]:
            with self.subTest(method=method, sid=sid):
                self.server._ask(method, sid, {}, timeout=120)
                self.assertEqual(self.calls[-1], (method, sid, {}, 120))

    def test_checks_current_session_ownership_on_each_prompt_and_installs_once(self):
        vault.bind_prompt_waits(self.server, self.journal)
        wrapped = self.server._ask
        vault.bind_prompt_waits(self.server, self.journal)
        self.assertIs(self.server._ask, wrapped)
        self.journal.canonical_session = lambda profile: 'replacement'
        self.server._ask('vault.save_login', 'canonical', {}, timeout=180)
        self.assertEqual(self.calls[-1][3], 180)

    def test_unattended_or_settled_turns_keep_the_native_deadline(self):
        vault.bind_prompt_waits(self.server, self.journal)
        for terminal, steering in [(None, None), (1, 0), (0, 1)]:
            with self.subTest(terminal=terminal, steering=steering):
                self.db.execute('DELETE FROM receipts')
                if terminal is not None:
                    self.db.execute('INSERT INTO receipts VALUES (?,?,?)', ('canonical', terminal, steering))
                self.server._ask('vault.save_login', 'canonical', {}, timeout=180)
                self.assertEqual(self.calls[-1][3], 180)


if __name__=='__main__': unittest.main()
