"""Scoped settlement races with the native immutable request-ID contract."""
import importlib.util
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('vault_addon', Path(__file__).resolve().parents[1] / 'src/hermes/vault.py')
vault = importlib.util.module_from_spec(spec); spec.loader.exec_module(vault)

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

if __name__=='__main__': unittest.main()
