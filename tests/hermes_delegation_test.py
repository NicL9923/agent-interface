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



CHECK_IN = {"id": "ci", "name": "Check-ins", "prompt": "[WildBots check-in for member mom on mom-main, abc123] Review Mom's email and calendar."}
JOBS = {"j": {"id": "j", "name": "Report", "prompt": "Report"}, "ci": CHECK_IN}


def find_job(ref):
    """Hermes's job store as cronjob_manage resolves it: ID, then name. Anything else is unexpected."""
    if ref in JOBS:
        return dict(JOBS[ref])
    if ref == "Check-ins":
        return dict(CHECK_IN)
    if ref == "Report":
        return dict(JOBS["j"])
    if ref == "Twice":
        raise delegation.AmbiguousRoutine(ref)
    if ref == "missing":
        return None
    raise OSError(f"jobs.json unreadable for {ref!r}")


class DeliveryAndHostTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.profile = "mom-main"
        self.gate = delegation.Delegation(sqlite3.connect(":memory:"), threading.RLock(), lambda agent: None,
                                          current_profile=lambda: self.profile, hermes_root=lambda: self.root, jobs=find_job)
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

    def test_other_assistants_routines_are_left_as_hermes_has_them(self):
        # Cross-profile routine delivery by any assistant is a known limit taken up separately
        # (branch t3/routine-delivery-privacy); this add-on narrows only main assistants.
        for profile in ("mom-notes", "ranch", "brand-new"):
            for args in ({"action": "create", "deliver": "bot-chat:dad-diary"}, {"action": "update", "job_id": "j", "deliver": "room:public"},
                         {"action": "run", "job_id": "j"}, {"action": "create", "deliver": "origin"}):
                self.assertFalse(self.refused("cronjob_manage", args, profile), (profile, args))

    def test_no_assistant_changes_resumes_or_runs_a_check_in_whatever_its_designation(self):
        # A former main assistant's check-in that cleanup couldn't delete stays as WildBots made it.
        for profile in ("mom-main", "mom-notes", "ranch", "brand-new"):
            for args in ({"action": "update", "job_id": "ci", "deliver": "bot-chat:ranch"}, {"action": "update", "job_id": "Check-ins", "prompt": "x"},
                         {"action": "resume", "job_id": "ci"}, {"action": "run", "job_id": "ci"}, {"action": "Run_Now", "job_id": "ci"},
                         {"action": "trigger", "job_id": "Check-ins"}):
                result = self.call("cronjob_manage", dict(args), profile)
                self.assertIn("WildBots check-in", json.loads(result).get("error", ""), (profile, args))
            for args in ({"action": "pause", "job_id": "ci"}, {"action": "remove", "job_id": "ci"}):
                self.assertFalse(self.refused("cronjob_manage", args, profile), (profile, args))
        # With no rosters at all, as before any WildBots server sent one, the lock still holds.
        self.gate.replace({}, 1)
        self.assertIsNone(self.gate.policy_for("mom-notes"))
        self.assertIn("WildBots check-in", json.loads(self.call("cronjob_manage", {"action": "resume", "job_id": "ci"}, "mom-notes"))["error"])

    def test_a_routine_that_cant_be_told_apart_from_a_check_in_is_left_alone(self):
        for ref, reason in (("Twice", "More than one routine"), ("broken", "can't be checked")):
            result = json.loads(self.call("cronjob_manage", {"action": "update", "job_id": ref, "deliver": "local"}, "ranch"))
            self.assertIn(reason, result["error"], ref)
        # A reference to nothing goes on, for Hermes to report; another routine is pinned to the job checked.
        self.assertFalse(self.refused("cronjob_manage", {"action": "run", "job_id": "missing"}, "ranch"))
        self.call("cronjob_manage", {"action": "update", "job_id": "Report", "deliver": "local"}, "ranch")
        self.assertEqual(self.ran[-1][1]["job_id"], "j")

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
        finally:
            sys.path.remove(SOURCE)


SCHEDULED_RUN = """
import datetime, json, threading, time
from cron.jobs import create_job, list_jobs, load_jobs, save_jobs
from cron.scheduler_tick import tick
job = create_job(prompt="", schedule="every 2h", name="[bot:mom-main] Check-ins", deliver="bot-chat", context_from=["self"], script="slow.sh", no_agent=True)
jobs = load_jobs()
for row in jobs:
    row["next_run_at"] = (datetime.datetime.now().astimezone() - datetime.timedelta(seconds=5)).isoformat()
save_jobs(jobs)
seen = {}
def watch():
    for _ in range(100):
        time.sleep(0.1)
        row = [j for j in list_jobs(True) if j["id"] == job["id"]][0]
        if row.get("live_execution"):
            seen["running"] = row
            return
threading.Thread(target=watch, daemon=True).start()
tick(verbose=False, sync=True)
time.sleep(1)
seen["completed"] = [j for j in list_jobs(True) if j["id"] == job["id"]][0]
print("RESULT " + json.dumps(seen, default=str))
"""


FAILURE_STATES = """
import json
from cron.jobs import create_job, mark_job_run, list_jobs
seen = {}
def snap(job_id, label):
    seen[label] = [j for j in list_jobs(True) if j["id"] == job_id][0]
for schedule in ("every 2h", "0 7 * * *"):
    j = create_job(prompt="hi", schedule=schedule, name="[bot:mom-main] Check-ins", deliver="bot-chat", context_from=["self"])["id"]
    mark_job_run(j, False, error="Connection error: provider unreachable", model_unreachable=True); snap(j, schedule + ": network failure")
    mark_job_run(j, False, error="Connection error: provider unreachable", model_unreachable=True, ladder_rung=True); snap(j, schedule + ": retry failed")
    mark_job_run(j, True); snap(j, schedule + ": recovered")
    mark_job_run(j, False, error="429 insufficient_quota", quota_hold_seconds=3 * 3600); snap(j, schedule + ": quota past the next run")
    mark_job_run(j, True); snap(j, schedule + ": recovered after hold")
    mark_job_run(j, False, error="429 insufficient_quota", quota_hold_seconds=3600, recover_consumed_fire=True); snap(j, schedule + ": quota recovery fire")
    mark_job_run(j, True); snap(j, schedule + ": recovered after quota")
    mark_job_run(j, False, error="Job timed out after 600s", status="timeout"); snap(j, schedule + ": timeout")
print("RESULT " + json.dumps(seen, default=str))
"""


CHECK_IN_LOCK = """
import json, sys, types
sys.path.insert(0, sys.argv[1])
from support import load_source
from cron.jobs import create_job
delegation = load_source("src/hermes/delegation.py", "delegation_real")
checkin = create_job(prompt="[WildBots check-in for member mom on mom-main, abc] Review email.", schedule="every 2h", name="Check-ins", deliver="bot-chat")
other = create_job(prompt="Report", schedule="every 2h", name="Report", deliver="bot-chat")
create_job(prompt="a", schedule="every 2h", name="Twice", deliver="bot-chat")
create_job(prompt="b", schedule="every 2h", name="twice", deliver="bot-chat")
import sqlite3, threading
gate = delegation.Delegation(sqlite3.connect(":memory:"), threading.RLock(), lambda agent: None, current_profile=lambda: "ranch")
ran = []
entry = types.SimpleNamespace(handler=lambda args, task_id=None: ran.append(dict(args)) or "{}")
gate.gate_registry(types.SimpleNamespace(get_entry=lambda name: entry if name == "cronjob_manage" else None))
out = {}
for label, args in (("update by id", {"action": "update", "job_id": checkin["id"], "deliver": "bot-chat:ranch"}),
                    ("resume by name", {"action": "resume", "job_id": "check-ins"}), ("run", {"action": "run_now", "job_id": checkin["id"]}),
                    ("pause", {"action": "pause", "job_id": checkin["id"]}), ("other by name", {"action": "update", "job_id": "REPORT", "deliver": "local"}),
                    ("ambiguous", {"action": "run", "job_id": "TWICE"})):
    before = len(ran)
    result = json.loads(entry.handler(dict(args), task_id="t"))
    out[label] = {"ran": len(ran) > before, "error": result.get("error", ""), "job_id": ran[-1]["job_id"] if len(ran) > before else None}
out["other_id"] = other["id"]
print("RESULT " + json.dumps(out))
"""


QUEUED_DELIVERIES = """
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from support import load_source
from hermes_constants import get_hermes_home
from cron import delivery_queue
from cron.bot_chat_legacy import defer
delegation = load_source("src/hermes/delegation.py", "delegation_real")
home = get_hermes_home()
out = {"empty": delegation.pending_deliveries(home)}
delivery_queue.enqueue("exec-1", {"id": "job-a", "name": "Weekly report", "deliver": "telegram:-100"}, "Results")
defer("key-1", {"id": "job-b", "name": "Ranch digest", "deliver": "bot-chat:ranch"}, "Digest", home / "profiles" / "ranch", for_failure=False)
out["queued"] = delegation.pending_deliveries(home)
claimed = delivery_queue.claim_next()
out["sending"] = delegation.pending_deliveries(home)
delivery_queue._finish(claimed["execution_id"], error=None)
out["sent"] = delegation.pending_deliveries(home)
print("RESULT " + json.dumps(out))
"""


def run_real(script, home):
    import subprocess
    env = {**os.environ, "HERMES_HOME": str(home), "PYTHONPATH": SOURCE}
    run = subprocess.run([sys.executable, "-c", script, str(Path(__file__).resolve().parent)], cwd=Path(__file__).resolve().parents[1],
                         env=env, capture_output=True, text=True, timeout=240, check=False)
    assert run.returncode == 0, run.stderr[-2000:]
    return json.loads(next(line for line in run.stdout.splitlines() if line.startswith("RESULT "))[len("RESULT "):])


class PendingDeliveriesTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        (self.home / "cron" / "bot_chat_pending").mkdir(parents=True)

    def queue(self, rows):
        connection = sqlite3.connect(self.home / "cron" / "deliveries.db")
        connection.execute("CREATE TABLE deliveries(execution_id TEXT, job_json TEXT, status TEXT)")
        connection.executemany("INSERT INTO deliveries VALUES(?,?,?)", rows)
        connection.commit()
        connection.close()

    def test_lists_unfinished_queue_rows_and_parked_bot_chat_outputs(self):
        self.queue([("1", json.dumps({"id": "a", "name": "A"}), "pending"), ("2", json.dumps({"id": "b", "name": "B"}), "delivering"),
                    ("3", json.dumps({"id": "c", "name": "C"}), "delivered"), ("4", "{}", "failed")])
        (self.home / "cron" / "bot_chat_pending" / "k1.json").write_text(json.dumps({"status": "queued", "job": {"id": "d", "name": "D"}}))
        (self.home / "cron" / "bot_chat_pending" / "k2.json").write_text(json.dumps({"status": "transferred", "job": {"id": "e"}}))
        self.assertEqual([row["id"] for row in delegation.pending_deliveries(self.home)], ["a", "b", "d"])

    def test_a_home_with_neither_has_nothing_pending(self):
        self.assertEqual(delegation.pending_deliveries(Path(tempfile.mkdtemp())), [])

    def test_an_unreadable_record_is_an_error_not_an_empty_list(self):
        (self.home / "cron" / "bot_chat_pending" / "bad.json").write_text("{not json")
        with self.assertRaises(ValueError):
            delegation.pending_deliveries(self.home)
        (self.home / "cron" / "bot_chat_pending" / "bad.json").write_text("[]")
        with self.assertRaises(ValueError):
            delegation.pending_deliveries(self.home)

    def test_the_rpc_reads_one_profile_and_refuses_a_bad_or_missing_one(self):
        root = Path(tempfile.mkdtemp())
        (root / "profiles" / "ranch" / "cron" / "bot_chat_pending").mkdir(parents=True)
        (root / "profiles" / "ranch" / "cron" / "bot_chat_pending" / "k.json").write_text(json.dumps({"status": "queued", "job": {"id": "r", "name": "Digest"}}))
        (root / "cron").mkdir()
        gate = delegation.Delegation(sqlite3.connect(":memory:"), threading.RLock(), lambda agent: None, hermes_root=lambda: root)
        server = types.SimpleNamespace(_ok=lambda rid, value: {"result": value}, _err=lambda rid, code, message: {"error": message})
        handle = gate.deliveries_rpc(server)
        self.assertEqual(handle(1, {"profile": "ranch"}), {"result": {"pending": [{"id": "r", "name": "Digest"}]}})
        self.assertEqual(handle(1, {"profile": "default"}), {"result": {"pending": []}})
        for params in ({}, {"profile": "../x"}, {"profile": 3}, None):
            self.assertEqual(handle(1, params)["error"], "Invalid routine deliveries request: profile", params)
        self.assertIn("no such profile", handle(1, {"profile": "gone"})["error"])
        (root / "profiles" / "ranch" / "cron" / "bot_chat_pending" / "k.json").write_text("{")
        self.assertIn("could not be read", handle(1, {"profile": "ranch"})["error"])

    @unittest.skipUnless(SOURCE, "needs HERMES_SOURCE")
    def test_real_hermes_queued_and_parked_deliveries_are_seen_until_sent(self):
        out = run_real(QUEUED_DELIVERIES, self.home)
        self.assertEqual(out["empty"], [])
        self.assertEqual(sorted(row["id"] for row in out["queued"]), ["job-a", "job-b"])
        self.assertEqual(sorted(row["id"] for row in out["sending"]), ["job-a", "job-b"])
        self.assertEqual([row["id"] for row in out["sent"]], ["job-b"], "A sent queue row is gone; the parked output still waits")


class RealCheckInLockTest(unittest.TestCase):
    @unittest.skipUnless(SOURCE, "needs HERMES_SOURCE")
    def test_hermes_own_resolver_finds_the_check_in_by_id_or_name(self):
        out = run_real(CHECK_IN_LOCK, tempfile.mkdtemp())
        for label in ("update by id", "resume by name", "run"):
            self.assertFalse(out[label]["ran"], label)
            self.assertIn("WildBots check-in", out[label]["error"], label)
        self.assertTrue(out["pause"]["ran"])
        self.assertEqual(out["other by name"]["job_id"], out["other_id"])
        self.assertIn("More than one routine", out["ambiguous"]["error"])


def unknown_fields(job, known):
    """Set fields of a native job that are neither routine settings nor bookkeeping."""
    found = {key for key, value in job.items() if value not in (None, "", [], {}, False) and not key.startswith("_")}
    if isinstance(job.get("repeat"), dict) and job["repeat"].get("times") is None:
        found.discard("repeat")
    return found - known


class RealSchedulerTest(unittest.TestCase):
    @unittest.skipUnless(SOURCE, "needs HERMES_SOURCE")
    def test_every_field_a_provider_failure_retry_or_quota_hold_leaves_is_known(self):
        """Hermes's real mark_job_run through outages, retries, quota holds, a timeout and recoveries."""
        import subprocess
        env = {**os.environ, "HERMES_HOME": tempfile.mkdtemp(), "PYTHONPATH": SOURCE}
        run = subprocess.run([sys.executable, "-c", FAILURE_STATES], cwd=SOURCE, env=env, capture_output=True, text=True, timeout=240, check=False)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        seen = json.loads(next(line for line in run.stdout.splitlines() if line.startswith("RESULT "))[len("RESULT "):])
        fields = json.loads((Path(__file__).resolve().parents[1] / "src" / "shared" / "hermes-job-fields.json").read_text())
        known = set(fields["routine"]) | set(fields["status"])
        written = set().union(*(job.keys() for job in seen.values()))
        self.assertTrue({"unreachable_retry", "quota_hold_until", "quota_hold_cron_expr"} <= written, "The states were really reached")
        for state, job in seen.items():
            self.assertEqual(unknown_fields(job, known), set(), state)

    @unittest.skipUnless(SOURCE, "needs HERMES_SOURCE")
    def test_every_field_a_real_scheduled_run_leaves_is_known(self):
        """A job Hermes's own scheduler dispatched and completed carries only fields the app reads or
        that are bookkeeping, so a healthy check-in is never mistaken for one with overrides."""
        import subprocess
        home = Path(tempfile.mkdtemp())
        (home / "scripts").mkdir()
        script = home / "scripts" / "slow.sh"
        script.write_text("#!/bin/sh\nsleep 2\necho '[SILENT]'\n")
        script.chmod(0o755)
        env = {**os.environ, "HERMES_HOME": str(home), "PYTHONPATH": SOURCE}
        run = subprocess.run([sys.executable, "-c", SCHEDULED_RUN], cwd=SOURCE, env=env, capture_output=True, text=True, timeout=240, check=False)
        self.assertEqual(run.returncode, 0, run.stderr[-2000:])
        line = next(line for line in run.stdout.splitlines() if line.startswith("RESULT "))
        seen = json.loads(line[len("RESULT "):])
        self.assertEqual(set(seen), {"running", "completed"}, run.stderr[-2000:])
        self.assertEqual(seen["completed"]["last_status"], "ok")
        self.assertTrue(seen["running"]["fire_claim"])
        self.assertTrue(seen["completed"]["last_dispatch"])
        fields = json.loads((Path(__file__).resolve().parents[1] / "src" / "shared" / "hermes-job-fields.json").read_text())
        known = set(fields["routine"]) | set(fields["status"])
        for state, job in seen.items():
            self.assertEqual(unknown_fields(job, known), set(), state)



if __name__ == "__main__":
    unittest.main()
