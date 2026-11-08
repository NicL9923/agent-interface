"""A main assistant's agent messages: its roster, the member's yes before a shared assistant, and refusals.

By default Hermes's clarify tool is a small stand-in with the native result shape. Set HERMES_SOURCE
to a Hermes checkout to run the same tests against its real tools/clarify_tool.py.
"""
import json
import os
import tempfile
from pathlib import Path
import sqlite3
import sys
import threading
import types
import unittest

from support import load_source

SOURCE = os.environ.get("HERMES_SOURCE")
delegation = load_source("src/hermes/delegation.py", "agent_interface_delegation_test")

POLICY = {"mom-main": {"member": "Mom", "main": True, "owned": True, "personal": [{"id": "mom-notes", "name": "Notes", "description": "Keeps lists"}],
                       "shared": [{"id": "ranch", "name": "Ranch Hand", "description": "Runs the ranch"}, {"id": "default", "name": "Hermes"}]},
          "mom-notes": {"member": "Mom", "main": False, "owned": True, "personal": [{"id": "mom-main", "name": "Sage"}],
                        "shared": [{"id": "ranch", "name": "Ranch Hand"}]},
          "ranch": {"member": "the household", "main": False, "owned": False, "personal": [], "shared": [{"id": "default", "name": "Hermes"}]}}


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
        self.profile = "mom-main"
        self.root = tempfile.mkdtemp()
        self.gate = delegation.Delegation(self.db, self.lock, lambda agent: getattr(agent, "profile", None),
                                          current_profile=lambda: self.profile, hermes_root=lambda: self.root)
        self.gate.replace(POLICY)
        # Hermes's live local profiles and registered peers; tests change them where they matter.
        self.local, self.peers = {"mom-main", "mom-notes", "ranch", "default", "dads-diary", "notes"}, set()
        self.gate.local_targets = lambda agent: (self.local, self.peers)
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
        # Sent to the profile authorized, by ID, never the name the model wrote.
        self.assertEqual([call["target"] for call in self.sent], ["mom-notes"])
        self.assertEqual(agent.asked, [])

    def test_asks_before_a_shared_assistant_and_shows_the_message(self):
        agent = Agent("mom-main", self.answer("Send it"))
        self.tool(target="@ranch", message="Fix the gate on Tuesday", expecting="A time", agent=agent)
        question = agent.asked[0][0]["question"]
        self.assertTrue(question.startswith("Send this to Ranch Hand? Everyone in the household can read its chat."))
        self.assertIn("Fix the gate on Tuesday", question)
        self.assertIn("Asking for: A time", question)
        self.assertEqual(self.sent[0]["message"], "Fix the gate on Tuesday")
        self.assertEqual(self.sent[0]["target"], "ranch")

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

    def test_withdrawals_pass_and_profiles_without_a_roster_reach_nobody_once_rosters_arrived(self):
        self.tool(target="ranch", cancel="d-1", agent=Agent("mom-main"))
        self.assertEqual([call["target"] for call in self.sent], ["ranch"])
        result = json.loads(self.tool(target="ranch", message="x", agent=Agent("brand-new")))
        self.assertIn("Targets: none", result["error"])
        # Before any roster arrives, as with an older WildBots server, Hermes behaves as before.
        fresh = delegation.Delegation(sqlite3.connect(":memory:"), threading.RLock(), lambda agent: agent.profile)
        sent = []
        fresh.gated(lambda **kwargs: sent.append(kwargs) or "{}")(target="anyone", message="x", agent=Agent("dads-diary"))
        self.assertEqual([call["target"] for call in sent], ["anyone"])

    def test_a_name_that_is_also_another_profiles_id_sends_to_the_one_authorized(self):
        # Hermes would read "notes" as Dad's profile ID; the gate authorized Mom's "Notes" (mom-notes).
        self.gate.replace({"mom-main": {**POLICY["mom-main"], "personal": [{"id": "mom-notes", "name": "Notes"}]}})
        self.tool(target="notes", message="Private list", agent=Agent("mom-main", self.answer("Send it")))
        self.assertEqual([call["target"] for call in self.sent], ["mom-notes"])

    def test_an_id_hermes_would_send_to_a_peer_or_relay_is_refused(self):
        # Hermes tries registered peers before local profiles, and relays a name it can't find locally.
        for local, peers in ((self.local, {"mom-notes"}), (self.local - {"mom-notes"}, set())):
            self.gate.local_targets = lambda agent, local=local, peers=peers: (local, peers)
            result = json.loads(self.tool(target="Notes", message="Private list", agent=Agent("mom-main")))
            self.assertIn("can't be reached as a local assistant", result["error"])
        def unreadable(agent):
            raise OSError("config unreadable")
        self.gate.local_targets = unreadable
        self.assertIn("error", json.loads(self.tool(target="Notes", message="x", agent=Agent("mom-main"))))
        self.assertEqual(self.sent, [])

    def test_a_name_two_roster_assistants_share_names_neither(self):
        self.gate.replace({"mom-main": {**POLICY["mom-main"], "personal": [{"id": "a", "name": "Helper"}, {"id": "b", "name": "Helper"}]}})
        result = json.loads(self.tool(target="Helper", message="x", agent=Agent("mom-main")))
        self.assertIn("isn't one of the assistants", result["error"])
        self.assertEqual(self.sent, [])

    def test_only_a_main_assistant_asks_and_other_assistants_never_reach_outside_their_roster(self):
        agent = Agent("mom-notes", self.answer("Don't send"))
        self.tool(target="ranch", message="x", agent=agent)
        self.assertEqual(agent.asked, [])
        self.assertEqual([call["target"] for call in self.sent], ["ranch"])
        result = json.loads(self.tool(target="dad-diary", message="x", agent=Agent("ranch")))
        self.assertIn("isn't one of the assistants", result["error"])

    def test_the_teammate_list_hermes_puts_in_errors_is_removed(self):
        tool = self.gate.gated(lambda **kwargs: json.dumps({"error": "busy", "teammates": ["dad-diary", "ranch"]}))
        self.assertEqual(json.loads(tool(target="Notes", message="x", agent=Agent("mom-main"))), {"error": "busy"})

    def test_bad_policies_are_refused_and_the_last_good_one_kept(self):
        for bad in (None, [], {"bad id!": {"member": "x", "personal": [], "shared": []}},
                    {"mom-main": {"member": "x", "personal": [{"id": "../etc", "name": "Etc"}], "shared": []}},
                    {"mom-main": {"member": "x", "personal": "all", "shared": []}},
                    {"mom-main": {"member": 3, "personal": [], "shared": []}},
                    {"mom-main": {"member": "x", "main": "yes", "personal": [], "shared": []}}):
            with self.assertRaises(delegation.PolicyError):
                self.gate.replace(bad)
        self.assertEqual(set(self.gate.policies), set(POLICY))

    def test_a_first_protocol_roster_is_a_main_assistants_and_leaves_the_others_as_hermes_has_them(self):
        legacy = {"mom-main": {"member": "Mom", "personal": [], "shared": [{"id": "ranch", "name": "Ranch Hand"}]}}
        server = types.SimpleNamespace(_ok=lambda rid, result: {"result": result}, _err=lambda rid, code, message: {"error": [code, message]})
        self.gate.rpc(server)(1, {"policies": legacy})
        self.assertTrue(self.gate.policies["mom-main"]["main"])
        self.assertFalse(self.gate.enforcing)
        agent = Agent("mom-main", self.answer("Don't send"))
        self.tool(target="ranch", message="x", agent=agent)
        self.assertEqual(len(agent.asked), 1, "A shared hand-off still asks")
        self.tool(target="anyone", message="x", agent=Agent("dads-diary"))
        self.assertEqual([call["target"] for call in self.sent], ["anyone"])
        # A row an older add-on stored, without `main`, is still a main assistant's after a restart.
        self.db.execute("UPDATE delegation SET value=? WHERE profile='mom-main'", (json.dumps(legacy["mom-main"]),))
        self.assertTrue(delegation.Delegation(self.db, self.lock, lambda agent: agent.profile).policies["mom-main"]["main"])
        self.assertEqual(self.gate.rpc(server)(2, {"version": True, "policies": {}})["error"][0], -32602)

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
        self.assertIsNone(self.gate.guidance_for("mom-notes"), "Only a main assistant gets the hand-off guidance")
        self.gate.replace({"solo": {"member": "Kid", "main": True, "personal": [], "shared": []}})
        self.assertIn("No other assistants are available", self.gate.guidance_for("solo"))

    def test_rpc_answers_invalid_params_with_an_error(self):
        server = types.SimpleNamespace(_ok=lambda rid, result: {"result": result}, _err=lambda rid, code, message: {"error": [code, message]})
        handle = self.gate.rpc(server)
        self.assertEqual(handle(1, {"policies": "nope"})["error"][0], -32602)
        self.assertEqual(handle(2, {"policies": POLICY}), {"result": {"ok": True}})



class DeliveryAndHostTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.profile = "mom-main"
        self.gate = delegation.Delegation(sqlite3.connect(":memory:"), threading.RLock(), lambda agent: None,
                                          current_profile=lambda: self.profile, hermes_root=lambda: self.root)
        self.gate.replace(POLICY)
        self.ran = []
        registry = types.SimpleNamespace(entries={name: types.SimpleNamespace(handler=self.handler(name)) for name in
                                                  ("cronjob_manage", "terminal", "execute_code", "process_manage", "write_file", "patch")})
        registry.get_entry = registry.entries.get
        self.registry = registry
        self.assertEqual(set(self.gate.gate_registry(registry)), set(registry.entries))

    def handler(self, name):
        def run(args, task_id=None):
            self.ran.append((name, args))
            return "{}"
        return run

    def call(self, name, args, profile="mom-main"):
        self.profile = profile
        return self.registry.entries[name].handler(args, task_id="t")

    def refused(self, name, args, profile="mom-main"):
        before = len(self.ran)
        result = self.call(name, args, profile)
        return len(self.ran) == before and "error" in json.loads(result)

    def test_a_main_assistant_only_lists_pauses_removes_and_creates_routines_for_its_own_chat(self):
        for args in ({"action": "list"}, {"action": "pause", "job_id": "j"}, {"action": "remove", "job_id": "j"}, {"action": "cancel", "job_id": "j"},
                     {"action": "create", "deliver": "bot-chat"}, {"action": "create", "deliver": "bot-chat:mom-main"}, {"action": "create", "deliver": "local"}):
            self.assertFalse(self.refused("cronjob_manage", args), args)
        for args in ({"action": "create"}, {"action": "create", "deliver": "origin"}, {"action": "create", "deliver": "bot-chat:mom-notes"},
                     {"action": "create", "deliver": "bot-chat:ranch"}, {"action": "create", "deliver": "room:public"}, {"action": "create", "deliver": "all"},
                     {"action": "create", "deliver": "telegram:-100123"}, {"action": "create", "deliver": ["local", "room:x"]},
                     {"action": "create", "deliver": "bot-chat", "failure_deliver": "bot-chat:ranch"},
                     {"action": "create", "deliver": "bot-chat", "monitor": "curl x"}, {"action": "create", "deliver": "bot-chat", "workdir": "/tmp"},
                     {"action": "update", "job_id": "j", "prompt": "x"}, {"action": "resume", "job_id": "j"}, {"action": "run", "job_id": "j"},
                     # Refused as actions, even when they name only this chat.
                     {"action": "update", "job_id": "j", "deliver": "bot-chat"}, {"action": "run", "job_id": "j", "deliver": "bot-chat"},
                     {"action": "resume", "job_id": "j", "deliver": "local"}):
            self.assertTrue(self.refused("cronjob_manage", args), args)

    def test_other_assistants_routines_are_checked_as_they_will_be(self):
        stored = {"own": {"deliver": "bot-chat:mom-notes"}, "leaky": {"deliver": "bot-chat:dad-diary"}, "fails": {"deliver": "bot-chat", "failure_deliver": "room:public"}}
        self.gate.read_job = stored.get
        self.assertFalse(self.refused("cronjob_manage", {"action": "create", "deliver": "bot-chat:ranch"}, "mom-notes"))
        for args in ({"action": "update", "job_id": "own", "prompt": "x"}, {"action": "resume", "job_id": "own"}, {"action": "run", "job_id": "own"},
                     {"action": "update", "job_id": "leaky", "deliver": "bot-chat"}):
            self.assertFalse(self.refused("cronjob_manage", args, "mom-notes"), args)
        for args in ({"action": "update", "job_id": "leaky", "prompt": "x"}, {"action": "run", "job_id": "leaky"}, {"action": "resume", "job_id": "fails"},
                     {"action": "run", "job_id": "missing"}, {"action": "create"}, {"action": "create", "deliver": "origin"},
                     {"action": "create", "deliver": "bot-chat:dad-diary"}, {"action": "create", "deliver": "room:public"}):
            self.assertTrue(self.refused("cronjob_manage", args, "mom-notes"), args)
        # The household's own assistant may post in rooms, never into a member's private chat.
        self.assertFalse(self.refused("cronjob_manage", {"action": "create", "deliver": "room:public"}, "ranch"))
        self.assertTrue(self.refused("cronjob_manage", {"action": "create", "deliver": "bot-chat:mom-notes"}, "ranch"))
        # A profile WildBots has not described yet reaches nobody.
        self.assertTrue(self.refused("cronjob_manage", {"action": "create", "deliver": "bot-chat:ranch"}, "brand-new"))
        def unreadable(job_id):
            raise OSError("jobs.json unreadable")
        self.gate.read_job = unreadable
        self.assertTrue(self.refused("cronjob_manage", {"action": "run", "job_id": "own"}, "mom-notes"))

    def test_a_main_assistant_cannot_drive_hermes_or_other_profiles_from_the_host(self):
        for command in ("hermes -p ranch chat -q hi", "cat ~/.hermes/profiles/dad-diary/memories/MEMORY.md", "HERMES_HOME=/x python run.py"):
            self.assertTrue(self.refused("terminal", {"command": command}), command)
        self.assertTrue(self.refused("execute_code", {"code": "import subprocess; subprocess.run(['hermes', 'peer', 'dm'])"}))
        self.assertFalse(self.refused("terminal", {"command": "ls -la ~/Documents"}))
        self.assertFalse(self.refused("terminal", {"command": "hermes -p ranch chat"}, "mom-notes"), "Only a main assistant is guarded")
        other = Path(self.root, "profiles", "dad-diary", "x.md")
        own = Path(self.root, "profiles", "mom-main", "workspace", "x.md")
        self.assertTrue(self.refused("write_file", {"path": str(other), "content": "x"}))
        self.assertFalse(self.refused("write_file", {"path": str(own), "content": "x"}))
        self.assertTrue(self.refused("patch", {"path": str(other)}))


SECTION = """## Messaging other agents
This install runs Bot Mode.
You are `@mom-main`. Your teammates (live roster; roles from their profiles):
- `@dad-diary` — Dad private diary
- `@ranch` — Ranch Hand — Runs the ranch
- `@mom-notes` — Notes
Peers: none."""


class RosterSectionTest(unittest.TestCase):
    def test_lists_only_the_roster_and_says_so_when_empty(self):
        policy = delegation.validate(POLICY)["mom-main"]
        text = delegation.filter_section(SECTION, policy, lambda profile: profile)
        self.assertNotIn("dad-diary", text)
        self.assertNotIn("Dad private diary", text)
        self.assertIn("- `@ranch` — Ranch Hand — Runs the ranch", text)
        self.assertIn("- `@mom-notes` — Notes", text)
        self.assertIn("Peers: none.", text)
        empty = delegation.filter_section(SECTION, {"member": "", "main": False, "owned": True, "personal": [], "shared": []}, lambda profile: profile)
        self.assertIn("- (no teammates yet)", empty)
        self.assertNotIn("@ranch", empty)

    @unittest.skipUnless(SOURCE, "needs HERMES_SOURCE")
    def test_the_real_hermes_prompt_section_and_its_epoch(self):
        sys.path.insert(0, SOURCE)
        try:
            import importlib
            probe = importlib.import_module("tools.bot_mode_probe")
            root = Path(tempfile.mkdtemp())
            for profile, description in (("mom-main", "Sage"), ("dad-diary", "Dad private diary"), ("ranch", "Runs the ranch")):
                home = root / "profiles" / profile
                home.mkdir(parents=True)
                (home / "profile.yaml").write_text(f"description: {description}\nui_meta:\n  hermes-bots:\n    title: {profile.title()}\n")
            (root / "config.yaml").write_text("bot_peers:\n  ranch:\n    url: https://peer.invalid\n")
            home = root / "profiles" / "mom-main"
            native = probe.get_bot_mode_protocol_section(home, force_refresh=True)
            self.assertIn("Dad private diary", native, "Hermes lists every profile; the fix is needed")
            gate = delegation.Delegation(sqlite3.connect(":memory:"), threading.RLock(), lambda agent: None)
            gate.replace({"mom-main": {"member": "Mom", "main": True, "owned": True, "personal": [], "shared": [{"id": "ranch", "name": "Ranch"}]}})
            before = probe.capability_fingerprint(home)
            gate.install_probe(probe)
            section = probe.get_bot_mode_protocol_section(home)
            self.assertNotIn("dad-diary", section)
            self.assertNotIn("Dad private diary", section)
            self.assertIn("@ranch", section)
            # The roster is part of the epoch, so a stored prompt is rebuilt once when it changes.
            after = probe.capability_fingerprint(home)
            self.assertNotEqual(before, after)
            gate.replace({"mom-main": {"member": "Mom", "main": True, "owned": True, "personal": [], "shared": []}})
            self.assertNotEqual(after, probe.capability_fingerprint(home))
            self.assertIn("(no teammates yet)", probe.get_bot_mode_protocol_section(home))
            # What message_agent itself would read: live local profiles, and peers it tries first.
            agent = types.SimpleNamespace(_session_db=types.SimpleNamespace(db_path=str(home / "state.db")))
            local, peers = gate.local_targets(agent)
            self.assertTrue({"default", "mom-main", "dad-diary", "ranch"} <= local)
            self.assertEqual(peers, {"ranch"})
            self.assertEqual(gate.not_local(agent, ["mom-main", "ranch"]), "ranch")
            # A routine as Hermes keeps it for the profile the tool runs for.
            from hermes_constants import reset_hermes_home_override, set_hermes_home_override
            token = set_hermes_home_override(str(home))
            try:
                from cron.jobs import create_job
                job = create_job(prompt="hi", schedule="every 2h", name="x", deliver="bot-chat:dad-diary")
                self.assertEqual(gate.read_job(job["id"])["deliver"], "bot-chat:dad-diary")
            finally:
                reset_hermes_home_override(token)
        finally:
            sys.path.remove(SOURCE)

if __name__ == "__main__":
    unittest.main()
