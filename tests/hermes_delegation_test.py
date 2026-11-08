"""A main assistant's agent messages: its roster, the member's yes before a shared assistant, and refusals.

By default Hermes's clarify tool is a small stand-in with the native result shape. Set HERMES_SOURCE
to a Hermes checkout to run the same tests against its real tools/clarify_tool.py.
"""
import json
import os
import sqlite3
import sys
import threading
import types
import unittest

from support import load_source

SOURCE = os.environ.get("HERMES_SOURCE")
delegation = load_source("src/hermes/delegation.py", "agent_interface_delegation_test")

POLICY = {"mom-main": {"member": "Mom", "personal": [{"id": "mom-notes", "name": "Notes", "description": "Keeps lists"}],
                       "shared": [{"id": "ranch", "name": "Ranch Hand", "description": "Runs the ranch"}, {"id": "default", "name": "Hermes"}]}}


def stand_in_clarify():
    module = types.ModuleType("tools.clarify_tool")

    def clarify_tool(questions, callback=None):
        if callback is None:
            return json.dumps({"error": "Clarify tool is not available in this execution context."})
        shown = [{"qid": f"q{i}", "question": q["question"], "choices": q.get("choices"), "choices_offered": q.get("choices")} for i, q in enumerate(questions)]
        reply = callback(shown)
        answers = reply.get("answers") or {}
        responses = [{"question": q["question"], "status": "answered" if answers.get(q["qid"]) else "skipped" if q["qid"] in answers else "unanswered",
                      "user_response": answers.get(q["qid"]) or None} for q in shown]
        return json.dumps({"responses": responses, "outcome": reply["outcome"]})
    module.clarify_tool = clarify_tool
    return module


class Agent:
    def __init__(self, profile, answer=None):
        self.profile, self.asked = profile, []
        if answer is not None:
            def clarify(questions):
                self.asked.append(questions)
                return answer(questions)
            self.clarify_callback = clarify


class DelegationTest(unittest.TestCase):
    def setUp(self):
        if SOURCE:
            sys.path.insert(0, SOURCE)
        else:
            self.saved = {name: sys.modules.get(name) for name in ("tools", "tools.clarify_tool")}
            sys.modules["tools"] = types.ModuleType("tools")
            sys.modules["tools.clarify_tool"] = stand_in_clarify()
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.lock = threading.RLock()
        self.gate = delegation.Delegation(self.db, self.lock, lambda agent: getattr(agent, "profile", None))
        self.gate.replace(POLICY)
        self.sent = []
        self.tool = self.gate.gated(lambda **kwargs: self.sent.append(kwargs) or json.dumps({"status": "queued"}))

    def tearDown(self):
        if SOURCE:
            sys.path.remove(SOURCE)
        else:
            for name, module in self.saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

    def answer(self, value):
        return lambda questions: {"answers": {questions[0]["qid"]: value}, "outcome": "submitted"}

    def test_sends_to_the_members_own_assistant_without_asking(self):
        agent = Agent("mom-main", self.answer("Send it"))
        self.tool(target="Notes", message="Add milk", agent=agent)
        self.assertEqual([call["target"] for call in self.sent], ["Notes"])
        self.assertEqual(agent.asked, [])

    def test_asks_before_a_shared_assistant_and_shows_the_message(self):
        agent = Agent("mom-main", self.answer("Send it"))
        self.tool(target="@ranch", message="Fix the gate on Tuesday", expecting="A time", agent=agent)
        question = agent.asked[0][0]["question"]
        self.assertTrue(question.startswith("Send this to Ranch Hand? Everyone in the household can read its chat."))
        self.assertIn("Fix the gate on Tuesday", question)
        self.assertIn("Asking for: A time", question)
        self.assertEqual(self.sent[0]["message"], "Fix the gate on Tuesday")

    def test_a_declined_or_unanswered_hand_off_sends_nothing_and_says_why(self):
        for answer, words in ((self.answer("Don't send"), "did not approve"), (lambda q: {"answers": {}, "outcome": "cancelled"}, "did not approve"),
                              (self.answer("Ask Dad first"), "They answered: Ask Dad first")):
            agent = Agent("mom-main", answer)
            result = json.loads(self.tool(target="ranch", message="Private plans", agent=agent))
            self.assertIn(words, result["error"])
        self.assertEqual(self.sent, [])

    def test_without_anyone_to_ask_a_shared_hand_off_is_refused(self):
        result = json.loads(self.tool(target="ranch", message="x", agent=Agent("mom-main")))
        self.assertIn("did not approve", result["error"])
        self.assertEqual(self.sent, [])

    def test_refuses_assistants_outside_the_roster_and_any_fan_out_naming_one(self):
        agent = Agent("mom-main", self.answer("Send it"))
        for target in ("dads-diary", "Notes, dads-diary", "peer/someone"):
            result = json.loads(self.tool(target=target, message="x", agent=agent))
            self.assertIn("isn't one of the assistants you can hand work to", result["error"])
        self.assertEqual(self.sent, [])
        self.assertEqual(agent.asked, [])

    def test_a_fan_out_with_a_shared_assistant_asks_once_for_it(self):
        agent = Agent("mom-main", self.answer("Send it"))
        self.tool(target="Notes, hermes", message="Plan dinner", agent=agent)
        self.assertEqual(len(agent.asked), 1)
        self.assertIn("Send this to Hermes?", agent.asked[0][0]["question"])
        self.assertEqual(len(self.sent), 1)

    def test_other_assistants_and_withdrawals_are_untouched(self):
        self.tool(target="anyone", message="x", agent=Agent("dads-diary"))
        self.tool(target="ranch", cancel="d-1", agent=Agent("mom-main"))
        self.assertEqual([call["target"] for call in self.sent], ["anyone", "ranch"])

    def test_bad_policies_are_refused_and_the_last_good_one_kept(self):
        for bad in (None, [], {"bad id!": {"member": "x", "personal": [], "shared": []}},
                    {"mom-main": {"member": "x", "personal": [{"id": "../etc", "name": "Etc"}], "shared": []}},
                    {"mom-main": {"member": "x", "personal": "all", "shared": []}},
                    {"mom-main": {"member": 3, "personal": [], "shared": []}}):
            with self.assertRaises(delegation.PolicyError):
                self.gate.replace(bad)
        self.assertEqual(set(self.gate.policies), {"mom-main"})

    def test_the_roster_survives_a_restart_and_an_empty_replace_clears_it(self):
        again = delegation.Delegation(self.db, self.lock, lambda agent: agent.profile)
        self.assertEqual(again.policies, delegation.validate(POLICY))
        again.replace({})
        self.assertEqual(delegation.Delegation(self.db, self.lock, lambda agent: agent.profile).policies, {})

    def test_guidance_names_each_assistant_and_which_ones_need_a_yes(self):
        text = self.gate.guidance_for("mom-main")
        self.assertIn('- Notes (target "mom-notes"): Keeps lists', text)
        self.assertIn("WildBots asks Mom before anything is sent to one of these", text)
        self.assertIn('- Ranch Hand (target "ranch"): Runs the ranch', text)
        self.assertIsNone(self.gate.guidance_for("dads-diary"))
        self.gate.replace({"solo": {"member": "Kid", "personal": [], "shared": []}})
        self.assertIn("No other assistants are available", self.gate.guidance_for("solo"))

    def test_rpc_answers_invalid_params_with_an_error(self):
        server = types.SimpleNamespace(_ok=lambda rid, result: {"result": result}, _err=lambda rid, code, message: {"error": [code, message]})
        handle = self.gate.rpc(server)
        self.assertEqual(handle(1, {"policies": "nope"})["error"][0], -32602)
        self.assertEqual(handle(2, {"policies": POLICY}), {"result": {"ok": True}})


if __name__ == "__main__":
    unittest.main()
