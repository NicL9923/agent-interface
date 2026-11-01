"""A chat message closes the asks it answers, and the handoff ask settles from the computer lease.

By default the native request registry is a small stand-in with Hermes's settlement rules. Set
HERMES_SOURCE to a Hermes checkout to run the same tests against its real
tui_gateway/server_requests.py, for example the qualified revision's dev checkout.
"""
import contextlib
import importlib
import json
import os
import sqlite3
import sys
import threading
import time
import types
import unittest
import uuid
from unittest.mock import patch

from support import load_source

SOURCE = os.environ.get("HERMES_SOURCE")


def settle_batch(locked, reply=None, *, ended=None):
    return {"answers": dict(locked), "outcome": ended or "submitted"}


class Request:
    def __init__(self, sid, method, params, qids=None):
        self.id, self.sid, self.method, self.params = "srq-" + uuid.uuid4().hex[:12], sid, method, dict(params)
        self.event, self.result, self.answered, self.created_at = threading.Event(), None, False, time.time()
        self.qids, self.locked, self.on_result, self.writing, self.withdrawn = list(qids) if qids else None, {}, None, False, None


def stand_in():
    """The settlement rules of tui_gateway.server_requests that these tests rely on."""
    module = types.ModuleType("tui_gateway.server_requests")
    module._lock, module._open, module.cancels = threading.Lock(), {}, []
    module.settle_batch = settle_batch
    module._emit_cancel = lambda request, reason: module.cancels.append((request.id, request.method, reason))
    def register(request):
        with module._lock:
            module._open[request.id] = request
    module._register = register
    def send(method, sid, params, *, timeout, qids=None):
        request = Request(sid, method, params, qids)
        module._register(request)
        request.event.wait(timeout)
        with module._lock:
            timed_out = module._open.pop(request.id, None) is request
        return request.result if request.answered else settle_batch(request.locked, ended="timed_out") if timed_out and qids else None
    module.send = send
    def resolve_response(frame, transport=None):
        with module._lock:
            request = module._open.pop(frame["id"], None)
            if request is None:
                return False
            request.result, request.answered = frame.get("result") or {}, True
        request.event.set()
        return True
    module.resolve_response = resolve_response
    def lock_answer(request_id, question_id, answer):
        with module._lock:
            module._open[request_id].locked[question_id] = answer
    module.lock_answer = lock_answer
    return module


def real():
    """Hermes's own module, with its contract check stubbed: these tests send no wire frames."""
    sys.path.insert(0, SOURCE)
    try:
        contracts = types.ModuleType("tui_gateway.contracts")
        contracts.registry = types.SimpleNamespace(SERVER_REQUESTS=AnyContract(), validate_params=lambda contract, params: (params, None))
        with patch.dict(sys.modules, {"tui_gateway.contracts": contracts, "tui_gateway.contracts.registry": contracts.registry}):
            sys.modules.pop("tui_gateway.server_requests", None)
            module = importlib.import_module("tui_gateway.server_requests")
    finally:
        sys.path.remove(SOURCE)
    module.cancels = []
    module.bind_sinks(lambda frame: True, lambda event, sid, payload: module.cancels.append((payload["id"], payload["method"], payload["reason"])),
                      lambda sid: True)
    module.reset_for_tests()
    module._contracts = contracts
    return module


class AnyContract(dict):
    def get(self, key, default=None):
        return object()


class Native:
    """A fresh vault add-on bound to one request registry, with the native seams its tools use."""
    def __init__(self):
        self.requests = real() if SOURCE else stand_in()
        gateway = types.ModuleType("tui_gateway")
        gateway.server_requests = self.requests
        # The native agent's steer buffer: text while an admitted chat message has not reached the model.
        self.agent = types.SimpleNamespace(_pending_steer=None)
        gateway.server = types.SimpleNamespace(_sessions={"live": {"agent": self.agent}})
        self.prompt, self.saved = None, []
        store = types.SimpleNamespace(add_item=lambda kind, label, secret, origin=None: self.saved.append(label)
                                      or types.SimpleNamespace(id="vault_handle", label=label, origin=origin))
        self.modules = {
            "tui_gateway": gateway, "tui_gateway.server_requests": self.requests,
            "agent": types.ModuleType("agent"), "agent.vault_backends": types.ModuleType("agent.vault_backends"),
            "agent.vault_backends.unlock": types.SimpleNamespace(get_save_login_prompt_callback=lambda: self.prompt, can_prompt_here=lambda: True),
            "agent.redact": types.SimpleNamespace(register_vault_redaction_value=lambda value: None),
            "agent.vault_store": types.SimpleNamespace(normalize_origin=lambda value: value, get_vault_store=lambda: store),
            "hermes_constants": types.SimpleNamespace(get_hermes_home=lambda: "/profiles/one", profile_name_for_home=lambda home: "one"),
        }
        if SOURCE:
            self.modules["tui_gateway.contracts"] = self.requests._contracts
            self.modules["tui_gateway.contracts.registry"] = self.requests._contracts.registry
        self.patch = patch.dict(sys.modules, self.modules)
        self.patch.start()
        self.vault = load_source("src/hermes/vault.py", "chat_reply_vault_" + uuid.uuid4().hex)
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.execute("CREATE TABLE receipts(session_id TEXT, actor TEXT, terminal INTEGER, steering INTEGER, created REAL)")
        self.db.execute("INSERT INTO receipts VALUES('live','member-a',0,0,1)")
        self.journal = types.SimpleNamespace(lock=threading.RLock(), db=self.db, epoch="epoch",
                                             canonical_session=lambda profile: "live", live_profile_for_session=lambda sid: "one")
        self.vault.bind_requests(self.requests, self.journal)
        self.registry = types.SimpleNamespace(dispatch=lambda name, args, **kwargs: self.tools[name](args))
        self.tools = {}
        self.vault.bind_dispatch(self.registry)

    def close(self):
        self.db.close()
        self.patch.stop()

    def ask(self, method, sid="live", params=None, qids=None, timeout=5):
        """A native tool blocked on one ask, on its own thread, as a tool dispatch."""
        done = {}
        def tool(args):
            result = self.requests.send(method, sid, params or {}, timeout=timeout, qids=qids)
            if method == "clarify":
                return json.dumps({"responses": [{"question_id": key, "user_response": value} for key, value in result["answers"].items()],
                                   "outcome": result["outcome"]})
            return json.dumps({"success": False, "error_type": "save_declined", "error": "The user chose not to save a login "
                               "for this site. Do not ask again this turn."}) if result is None else json.dumps({"raw": result})
        name = "tool-" + uuid.uuid4().hex
        self.tools[name] = tool
        thread = threading.Thread(target=lambda: done.setdefault("result", self.registry.dispatch(name, {})))
        thread.start()
        request = self.wait_open(method, sid)
        return request, thread, done

    def wait_open(self, method, sid="live"):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.requests._lock:
                found = [request for request in self.requests._open.values() if request.method == method and request.sid == sid]
            if found:
                return found[-1]
            time.sleep(.005)
        raise AssertionError("ask never opened")


class ChatReplyTests(unittest.TestCase):
    def setUp(self):
        self.native = Native()
        self.vault = self.native.vault

    def tearDown(self):
        self.native.close()

    def answer(self, request, **values):
        answer = dict(epoch="epoch", sessionId="live", method=request.method, **values)
        return self.vault.answer_request(None, self.native.journal, dict(profile="one", requestId=request.id, answer=answer, actor="member-a"))

    def test_a_reply_closes_its_sessions_asks_and_the_tool_says_to_read_it(self):
        login, login_thread, login_done = self.native.ask("vault.save_login", params={"origin": "https://site.invalid", "site": "site.invalid"})
        other, other_thread, other_done = self.native.ask("vault.code", sid="elsewhere")
        approval, approval_thread, _ = self.native.ask("approval", timeout=.5)
        self.assertEqual(self.vault.close_for_chat("live", "member-b"), 1)
        login_thread.join(2)
        result = json.loads(login_done["result"])
        self.assertEqual(result["error_type"], "user_replied_in_chat")
        self.assertTrue(result["user_replied_in_chat"])
        self.assertIn("next user message", result["error"])
        self.assertNotIn("Do not ask again", result["error"])
        self.assertIn((login.id, "vault.save_login", "user_replied"), self.native.requests.cancels)
        # Another session's ask and an approval stay open.
        with self.native.requests._lock:
            self.assertIn(other.id, self.native.requests._open)
            self.assertIn(approval.id, self.native.requests._open)
        # A later answer for the closed ask learns only that it expired.
        self.assertEqual(self.answer(login, identifier="user", password="secret"), {"status": "expired"})
        self.native.requests.resolve_response({"id": other.id, "result": {"value": ""}})
        other_thread.join(2); approval_thread.join(2)
        self.assertNotIn("user_replied_in_chat", other_done["result"])

    def test_an_ask_opened_after_an_undelivered_reply_closes_at_once(self):
        # The message was admitted before the tool sent its prompt, so the prompt is out of date.
        self.assertEqual(self.vault.close_for_chat("live", "member-a"), 0)
        self.native.agent._pending_steer = "Use https://kvm.example.net instead."
        done = {}
        self.native.tools["late"] = lambda args: json.dumps({"raw": self.native.requests.send("vault.code", "live", {}, timeout=5)})
        thread = threading.Thread(target=lambda: done.setdefault("result", self.native.registry.dispatch("late", {})))
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(json.loads(done["result"])["user_replied_in_chat"])
        with self.native.requests._lock:
            self.assertFalse([request for request in self.native.requests._open.values() if request.sid == "live"])

    def test_an_ask_after_the_reply_reached_the_model_stays_open(self):
        self.vault.close_for_chat("live", "member-a")
        self.native.agent._pending_steer = None
        request, thread, done = self.native.ask("vault.code")
        time.sleep(.1)
        with self.native.requests._lock:
            self.assertIn(request.id, self.native.requests._open)
        self.native.requests.resolve_response({"id": request.id, "result": {"value": "123456"}})
        thread.join(2)
        self.assertNotIn("user_replied_in_chat", done["result"])

    def test_another_members_reply_leaves_an_explicit_login_with_its_requester(self):
        self.native.prompt = lambda origin, site: (lambda raw: json.loads(raw) if raw else None)(
            (self.native.requests.send("vault.save_login", "live", {"origin": origin, "site": site}, timeout=5) or {}).get("value"))
        self.native.tools["vault_save_login"] = lambda args: self.vault.save_explicit_login(args)
        done = {}
        args = dict(origin="https://kvm.example.net", label="KVM", purpose="Check the console.")
        thread = threading.Thread(target=lambda: done.setdefault("result", self.native.registry.dispatch("vault_save_login", args)))
        thread.start()
        request = self.native.wait_open("vault.save_login")
        self.assertEqual(self.vault.close_for_chat("live", "member-b"), 0)
        with self.native.requests._lock:
            self.assertIn(request.id, self.native.requests._open)
        self.assertEqual(self.vault.close_for_chat("live", "member-a"), 1)
        thread.join(2)
        result = json.loads(done["result"])
        self.assertEqual(result["error_type"], "user_replied_in_chat")
        self.assertEqual(self.native.saved, [])

    def test_a_requesters_waiting_reply_closes_their_late_login_even_after_another_members(self):
        # Both messages wait in Hermes's buffer; the requester's must still close the login that opens now.
        self.vault.close_for_chat("live", "member-a", "Use the other address.")
        self.vault.close_for_chat("live", "member-b", "Also check the barn.")
        self.native.agent._pending_steer = "Use the other address.\nAlso check the barn."
        self.native.prompt = lambda origin, site: (lambda raw: json.loads(raw) if raw else None)(
            (self.native.requests.send("vault.save_login", "live", {"origin": origin, "site": site}, timeout=5) or {}).get("value"))
        self.native.tools["vault_save_login"] = lambda args: self.vault.save_explicit_login(args)
        done = {}
        args = dict(origin="https://kvm.example.net", label="KVM", purpose="Check the console.")
        thread = threading.Thread(target=lambda: done.setdefault("result", self.native.registry.dispatch("vault_save_login", args)))
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(json.loads(done["result"])["error_type"], "user_replied_in_chat")

    def test_a_requesters_reply_that_already_reached_the_model_no_longer_closes_their_login(self):
        # A's message drained into the turn; only B's is waiting when A's login opens.
        self.vault.close_for_chat("live", "member-a", "Use the other address.")
        self.native.agent._pending_steer = "Use the other address."
        self.assertEqual(self.vault.steer_waiting("live"), {"member-a"})
        self.vault.close_for_chat("live", "member-b", "Also check the barn.")
        self.native.agent._pending_steer = "Also check the barn."
        self.native.prompt = lambda origin, site: (lambda raw: json.loads(raw) if raw else None)(
            (self.native.requests.send("vault.save_login", "live", {"origin": origin, "site": site}, timeout=5) or {}).get("value"))
        self.native.tools["vault_save_login"] = lambda args: self.vault.save_explicit_login(args)
        done = {}
        args = dict(origin="https://kvm.example.net", label="KVM", purpose="Check the console.")
        thread = threading.Thread(target=lambda: done.setdefault("result", self.native.registry.dispatch("vault_save_login", args)))
        thread.start()
        request = self.native.wait_open("vault.save_login")
        time.sleep(.1)
        with self.native.requests._lock:
            self.assertIn(request.id, self.native.requests._open)
        self.assertEqual(self.vault.steer_waiting("live"), {"member-b"})
        self.vault.close_for_chat("live", "member-a", "Cancel that.")
        thread.join(2)
        self.assertEqual(json.loads(done["result"])["error_type"], "user_replied_in_chat")

    def test_only_another_members_waiting_reply_leaves_a_late_login_open(self):
        self.vault.close_for_chat("live", "member-b")
        self.native.agent._pending_steer = "Check the barn."
        self.native.prompt = lambda origin, site: (lambda raw: json.loads(raw) if raw else None)(
            (self.native.requests.send("vault.save_login", "live", {"origin": origin, "site": site}, timeout=5) or {}).get("value"))
        self.native.tools["vault_save_login"] = lambda args: self.vault.save_explicit_login(args)
        done = {}
        args = dict(origin="https://kvm.example.net", label="KVM", purpose="Check the console.")
        thread = threading.Thread(target=lambda: done.setdefault("result", self.native.registry.dispatch("vault_save_login", args)))
        thread.start()
        request = self.native.wait_open("vault.save_login")
        time.sleep(.1)
        with self.native.requests._lock:
            self.assertIn(request.id, self.native.requests._open)
        self.assertEqual(self.vault.close_for_chat("live", "member-a"), 1)
        thread.join(2)
        self.assertEqual(json.loads(done["result"])["error_type"], "user_replied_in_chat")

    def test_a_submitted_value_wins_over_a_reply_that_arrives_while_it_settles(self):
        request, thread, done = self.native.ask("vault.code", params={"site": "site.invalid", "hint": ""})
        release, entered = threading.Event(), threading.Event()
        original = self.native.requests.resolve_response
        def slow(frame, transport=None):
            entered.set(); release.wait(2)
            return original(frame)
        with patch.object(self.native.requests, "resolve_response", slow):
            answering = threading.Thread(target=lambda: done.setdefault("answer", self.answer(request, value="123456")))
            answering.start()
            entered.wait(2)
            self.assertEqual(self.vault.close_for_chat("live", "member-a"), 0)
            release.set()
            answering.join(2)
        thread.join(2)
        self.assertEqual(done["answer"], {"status": "ok"})
        self.assertEqual(json.loads(done["result"]), {"raw": {"value": "123456"}})
        self.assertEqual(self.native.requests.cancels, [])

    def test_a_reply_closes_the_ask_after_an_answer_that_fails(self):
        request, thread, done = self.native.ask("vault.code", params={"site": "site.invalid", "hint": ""})
        entered, release = threading.Event(), threading.Event()
        original = self.vault.settle_answer
        def failing(*args):
            entered.set(); release.wait(2)
            raise self.vault.VaultError()
        with patch.object(self.vault, "settle_answer", failing):
            answering = threading.Thread(target=lambda: self.assertRaises(self.vault.VaultError, self.answer, request, value="1"))
            answering.start()
            entered.wait(2)
            self.assertEqual(self.vault.close_for_chat("live", "member-a"), 0)
            release.set()
            answering.join(2)
        self.assertIs(self.vault.settle_answer, original)
        thread.join(2)
        self.assertEqual(json.loads(done["result"])["error_type"], "user_replied_in_chat")

    def test_an_answer_racing_a_reply_has_exactly_one_outcome(self):
        for _ in range(40):
            request, thread, done = self.native.ask("vault.code", params={"site": "site.invalid", "hint": ""})
            outcome = {}
            racers = [threading.Thread(target=lambda outcome=outcome, request=request: outcome.setdefault("answer", self.answer(request, value="42"))),
                      threading.Thread(target=lambda outcome=outcome: outcome.setdefault("closed", self.vault.close_for_chat("live", "member-a")))]
            for racer in racers:
                racer.start()
            for racer in racers:
                racer.join(2)
            thread.join(2)
            answered = outcome["answer"] == {"status": "ok"}
            self.assertNotEqual(answered, outcome["closed"] == 1)
            self.assertEqual("user_replied_in_chat" in done["result"], not answered)

    def test_a_reply_keeps_chosen_clarify_answers_and_says_it_is_the_reply(self):
        request, thread, done = self.native.ask("clarify", params={"questions": []}, qids=["one", "two"])
        self.native.requests.lock_answer(request.id, "one", "Saturday")
        self.vault.close_for_chat("live", "member-a")
        thread.join(2)
        raw = json.loads(done["result"])
        self.assertEqual((raw["responses"], raw["outcome"]), ([{"question_id": "one", "user_response": "Saturday"}], "cancelled"))
        self.assertTrue(raw["user_replied_in_chat"])
        self.assertIn("treat it as their reply", raw["notice"])

    def test_non_json_results_and_already_explained_results(self):
        self.assertTrue(self.vault.chat_reply_result("plain").startswith("plain\n\n"))
        explained = json.dumps({"success": False, "error_type": "user_replied_in_chat", "error": "own words"})
        self.assertEqual(self.vault.chat_reply_result(explained), explained)
        skipped = json.loads(self.vault.chat_reply_result(json.dumps({"success": True, "skipped": True})))
        self.assertEqual((skipped["success"], skipped["notice"]), (True, self.vault.CHAT_REPLY))


class Lease:
    HUMAN, AGENT = "human", "agent"

    def __init__(self):
        self.holder, self.epoch = self.AGENT, 0


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.native = Native()
        session = types.SimpleNamespace(get_session_env=lambda name: self.sid)
        self.sid = "live"
        self.extra = patch.dict(sys.modules, {"gateway": types.ModuleType("gateway"), "gateway.session_context": session})
        self.extra.start()
        sys.modules["agent_interface_vault"] = self.native.vault
        self.computer_module = load_source("src/hermes/computer.py", "chat_reply_computer_" + uuid.uuid4().hex)
        self.computer_module.bind_journal(self.native.journal)
        self.lease = Lease()
        self.status = {"available": True, "running": True, "browserReady": True, "control": {"kind": "idle"}}
        self.computer = types.SimpleNamespace(_lease=lambda: self.lease, lease=Lease, status=lambda: dict(self.status),
                                              suspend_for_prompt=contextlib.nullcontext)
        self.native.tools["handoff"] = lambda args: self.computer_module.request_handoff(self.computer, args)

    def tearDown(self):
        sys.modules.pop("agent_interface_vault", None)
        self.extra.stop()
        self.native.close()

    def call(self, args=None):
        done = {}
        args = args or {"reason": "The bank wants a code from your phone.", "what_to_do": "Enter the code, then hand back."}
        thread = threading.Thread(target=lambda: done.setdefault("result", self.native.registry.dispatch("handoff", args)))
        thread.start()
        return thread, done

    def result(self, thread, done):
        thread.join(5)
        self.assertFalse(thread.is_alive())
        return json.loads(done["result"])

    def test_take_over_then_hand_back_tells_the_agent_to_look_again(self):
        thread, done = self.call()
        request = self.native.wait_open(self.computer_module.HANDOFF)
        self.assertEqual(request.params, {"reason": "The bank wants a code from your phone.", "what_to_do": "Enter the code, then hand back."})
        self.lease.holder = Lease.HUMAN
        time.sleep(1.2)
        with self.native.requests._lock:
            self.assertIn(request.id, self.native.requests._open)
        self.lease.holder = Lease.AGENT
        result = self.result(thread, done)
        self.assertEqual(result["status"], "handed_back")
        self.assertIn("new screenshot", result["next"])

    def test_a_takeover_longer_than_registration_still_answers_on_hand_back(self):
        # The watcher's registration placeholder expires first; the last handoff must still settle.
        with patch.object(self.computer_module, "HANDOFF_REGISTER", .2):
            thread, done = self.call()
            self.native.wait_open(self.computer_module.HANDOFF)
            self.lease.holder = Lease.HUMAN
            time.sleep(1.2)
            self.lease.holder = Lease.AGENT
            self.assertEqual(self.result(thread, done)["status"], "handed_back")

    def test_a_timeout_after_registration_still_answers(self):
        with patch.object(self.computer_module, "HANDOFF_REGISTER", .2), patch.object(self.computer_module, "HANDOFF_WAIT", 1.0):
            thread, done = self.call()
            self.assertEqual(self.result(thread, done)["error_type"], "timed_out")

    def test_someone_already_in_control_answers_when_they_hand_back(self):
        self.lease.holder = Lease.HUMAN
        thread, done = self.call()
        self.native.wait_open(self.computer_module.HANDOFF)
        time.sleep(.8)
        self.lease.holder = Lease.AGENT
        self.assertEqual(self.result(thread, done)["status"], "handed_back")

    def test_not_now_checks_the_conversation_then_declines(self):
        thread, done = self.call()
        request = self.native.wait_open(self.computer_module.HANDOFF)
        decline = self.computer_module.decline_handoff
        base = dict(decision="decline", requestId=request.id, sessionId="live", epoch="epoch", profile="one")
        for key, value in [("sessionId", "other"), ("epoch", "old"), ("decision", "take")]:
            with self.assertRaises(self.computer_module.ComputerError):
                decline({**base, key: value})
        self.assertEqual(decline({**base, "requestId": "srq-missing"}), {"status": "expired"})
        self.assertEqual(decline(base), {"status": "ok"})
        self.assertEqual(decline(base), {"status": "expired"})
        self.assertEqual(self.result(thread, done)["error_type"], "declined")

    def test_a_chat_reply_closes_the_handoff(self):
        thread, done = self.call()
        self.native.wait_open(self.computer_module.HANDOFF)
        self.assertEqual(self.native.vault.close_for_chat("live", "member-b"), 1)
        result = self.result(thread, done)
        self.assertEqual(result["error_type"], "user_replied_in_chat")
        self.assertIn("nobody used the computer", result["error"])

    def test_nobody_taking_over_times_out(self):
        with patch.object(self.computer_module, "HANDOFF_WAIT", .6):
            thread, done = self.call()
            self.assertEqual(self.result(thread, done)["error_type"], "timed_out")

    def test_refuses_without_a_person_or_a_working_computer_or_with_bad_arguments(self):
        self.sid = "routine"
        self.assertEqual(self.result(*self.call())["error_type"], "no_person")
        self.sid = "live"
        with self.native.journal.lock:
            self.native.db.execute("UPDATE receipts SET terminal=1")
        self.assertEqual(self.result(*self.call())["error_type"], "no_person")
        self.native.db.execute("UPDATE receipts SET terminal=0")
        self.status = {"available": True, "running": True, "reason": "An interrupted browser action needs recovery."}
        result = self.result(*self.call())
        self.assertEqual(result["error_type"], "computer_unavailable")
        self.assertIn("needs recovery", result["error"])
        self.status = {"available": True, "running": True}
        for args in ({"reason": "x"}, {"reason": "x", "what_to_do": "y", "password": "z"}, {"reason": "a‮b", "what_to_do": "y"},
                     {"reason": "x" * 201, "what_to_do": "y"}):
            self.assertEqual(self.result(*self.call(args))["error_type"], "invalid_arguments")
        with self.native.requests._lock:
            self.assertEqual([request for request in self.native.requests._open.values()], [])

    def test_the_catalog_sentence_fits_and_every_result_is_named(self):
        schema = self.computer_module.HANDOFF_SCHEMA
        self.assertLessEqual(len(schema["description"].split(". ")[0]), 60)
        for outcome in ("handed_back", "declined", "user_replied_in_chat", "timed_out", "computer_unavailable", "no_person",
                        "invalid_arguments", "cancelled"):
            self.assertIn(outcome, schema["description"])
        self.assertEqual(self.computer_module.HANDOFF, self.native.vault.HANDOFF)


if __name__ == "__main__":
    unittest.main()
