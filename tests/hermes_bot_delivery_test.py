"""Bot Chat deliveries into add-on chats, with fake native mailbox and session stores.

The real native path is proven by scripts/spike/routine_probe.py in qualification.
"""
import contextlib
import importlib.util
import json
import re
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bot_delivery_test", ROOT / "src/hermes/bot_delivery.py")
delivery = importlib.util.module_from_spec(spec); spec.loader.exec_module(delivery)

KEY = "a" * 64
OTHER = "b" * 64


def mailbox(authority=True):
    """The native receipt helpers, plus authority-only (eb75627) or owner-mailbox (6ebd92d) delivery."""
    module = types.ModuleType("tools.bot_live_delivery")
    module.native = []
    module._root = lambda home: Path(home).resolve() / "runtime" / "bot_live_delivery"

    @contextlib.contextmanager
    def locked(home):
        root = module._root(home); root.mkdir(parents=True, exist_ok=True)
        yield root
    module._locked = locked
    module._read = lambda path: json.loads(path.read_text()) if path.exists() else None
    module._write = lambda path, record: path.write_text(json.dumps(record))
    module._scan_read = lambda path: json.loads(path.read_text())
    module._next_sequence = lambda root: len(list(root.glob("*.json"))) + 1
    def delivery_id(value):
        if not re.fullmatch(r"[0-9a-f]{32,64}", value): raise ValueError("bad id")
        return value
    module._delivery_id = delivery_id
    module.has_mailbox = lambda home: module._root(home).is_dir()
    def complete(home, key, *, status, reply="", error="", reason=""):
        path = module._root(home) / f"{key}.json"
        record = json.loads(path.read_text())
        if record["status"] != "claimed": raise ValueError("delivery must be claimed before completion")
        record.update(status=status, reply=reply, error=error, reason=reason)
        path.write_text(json.dumps(record))
        return record
    module.complete_delivery = complete
    def find(home):
        module.native.append(("find", str(home)))
        return {"profile_home": str(Path(home).resolve()), "session_id": "tip", "lease_id": "authority", "live_session_id": "tip"}
    def deliver(home, owner, message, *, delivery_id=None, author=None, notification_category="result"):
        module.native.append(("deliver", owner["lease_id"]))
        raise RuntimeError("runtime_coordination_required")
    module.find_canonical_live_owner, module.deliver_to_live_owner = find, deliver
    if authority:
        module.authority_delivery = lambda home, params: None
    else:
        module.claim_pending_delivery = lambda home, owner: None
    return module


class Store:
    """state.db reads: one titled Bot Chat, its compression chain and its routing columns."""
    def __init__(self, chat="stored", tips=None, routed=False):
        self.chat, self.tips, self.routed = chat, tips or {}, routed
    def __call__(self, home):
        return self
    def get_session_by_title(self, title):
        return {"id": self.chat} if title == "Bot Chat" and self.chat else None
    def get_compression_tip(self, sid):
        return self.tips.get(sid, sid)
    def get_session(self, sid):
        return {"id": sid, "session_key": "agent:route" if self.routed else "", "chat_id": "", "origin_json": None}
    def close(self):
        pass


class Server:
    """The dashboard's native turn seams the consumer drives."""
    def __init__(self, session, started=True, outcome=None):
        self._sessions = {"sid": session}
        self.turns, self.released = [], []
        self.started, self.outcome = started, outcome or {"status": "settled", "text": "Done with the routine."}
    @contextlib.contextmanager
    def _session_turn_admission(self, session):
        yield True
    def _run_prompt_submit(self, rid, sid, session, text, **kwargs):
        self.turns.append((rid, sid, text, kwargs))
        if self.started:
            kwargs["terminal_callback"](self.outcome)
        return self.started
    def _notif_release_turn(self, session):
        self.released.append(session); session["running"] = False


class BotDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve() / "profiles" / "penny"
        self.home.mkdir(parents=True)
        (self.home / "state.db").write_text("")
    def tearDown(self): self.temp.cleanup()

    def record(self, key=KEY):
        return json.loads((self.home / "runtime/bot_live_delivery" / f"{key}.json").read_text())

    def consumer(self, server, store, allowed=True):
        @contextlib.contextmanager
        def admission(sid):
            yield allowed
        return delivery.Consumer(server, self.box, lambda: [("penny", self.home)], lambda profile: "sid", admission,
                                 open_db=store, classify=lambda error: "provider")

    def test_native_owner_mailbox_hermes_keeps_native_delivery(self):
        box = mailbox(authority=False)
        native = box.deliver_to_live_owner
        self.assertFalse(delivery.bridge_required(box, types.SimpleNamespace(_poll_bot_live_delivery_once=lambda *a: None)))
        self.assertFalse(delivery.install_producer(box, Store()))
        self.assertIs(box.deliver_to_live_owner, native)

    def test_half_native_delivery_design_requires_qualification(self):
        with self.assertRaises(RuntimeError):
            delivery.bridge_required(mailbox(), types.SimpleNamespace(_poll_bot_live_delivery_once=lambda *a: None))
        with self.assertRaises(RuntimeError):
            delivery.bridge_required(mailbox(authority=False), types.SimpleNamespace())

    def test_routine_for_addon_chat_queues_for_dashboard_instead_of_authority(self):
        self.box = mailbox()
        self.assertTrue(delivery.install_producer(self.box, Store()))
        owner = self.box.find_canonical_live_owner(self.home)
        self.assertEqual((owner["consumer"], owner["session_id"]), ("agent-interface", "stored"))
        receipt = self.box.deliver_to_live_owner(self.home, owner, "[Cronjob] result", delivery_id=KEY)
        self.assertEqual(self.box.native, [])
        self.assertEqual((receipt["status"], receipt["message"], self.record()["consumer"]), ("queued", "[Cronjob] result", "agent-interface"))
        # A producer replay inspects the same receipt; a different payload never overwrites it.
        self.assertEqual(self.box.deliver_to_live_owner(self.home, owner, "[Cronjob] result", delivery_id=KEY), receipt)
        with self.assertRaises(ValueError):
            self.box.deliver_to_live_owner(self.home, owner, "different", delivery_id=KEY)

    def test_authority_owned_chat_and_storeless_profile_stay_native(self):
        self.box = mailbox()
        delivery.install_producer(self.box, Store(routed=True))
        self.assertEqual(self.box.find_canonical_live_owner(self.home)["lease_id"], "authority")
        (self.home / "state.db").unlink()
        self.assertEqual(self.box.find_canonical_live_owner(self.home)["lease_id"], "authority")
        self.assertEqual([call[0] for call in self.box.native], ["find", "find"])

    def test_consumer_runs_queued_delivery_once_and_records_reply(self):
        self.box = mailbox()
        store = Store(chat=None)
        delivery.install_producer(self.box, store)
        owner = self.box.find_canonical_live_owner(self.home)
        self.assertEqual(owner["session_id"], delivery.UNOPENED)
        self.box.deliver_to_live_owner(self.home, owner, "[Cronjob] diagnostic", delivery_id=KEY, notification_category="diagnostic")
        session = {"session_key": "stored", "agent": object()}
        server = Server(session)
        consumer = self.consumer(server, store)
        self.assertTrue(consumer.deliver_once("penny", self.home))
        rid, sid, text, kwargs = server.turns[0]
        self.assertEqual((rid, sid, text), (f"__bot_dm__{KEY}", "sid", "[Cronjob] diagnostic"))
        self.assertEqual(kwargs["display_metadata"], {"notification_category": "diagnostic"})
        self.assertEqual((self.record()["status"], self.record()["reply"]), ("settled", "Done with the routine."))
        session["running"] = False
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual(len(server.turns), 1)

    def test_consumer_waits_for_idle_chat_and_admission(self):
        self.box = mailbox()
        delivery.install_producer(self.box, Store())
        self.box.deliver_to_live_owner(self.home, self.box.find_canonical_live_owner(self.home), "result", delivery_id=KEY)
        for session, allowed in (({"session_key": "stored", "agent": object(), "running": True}, True),
                                 ({"session_key": "stored", "agent": None}, True),
                                 ({"session_key": "stored", "agent": object()}, False)):
            server = Server(session)
            self.assertFalse(self.consumer(server, Store(), allowed).deliver_once("penny", self.home))
            self.assertEqual((server.turns, self.record()["status"]), ([], "queued"))

    def test_turn_that_cannot_start_fails_without_replay(self):
        self.box = mailbox()
        delivery.install_producer(self.box, Store())
        self.box.deliver_to_live_owner(self.home, self.box.find_canonical_live_owner(self.home), "result", delivery_id=KEY)
        session = {"session_key": "stored", "agent": object()}
        server = Server(session, started=False)
        consumer = self.consumer(server, Store())
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual((self.record()["status"], self.record()["reason"], server.released), ("failed", "provider", [session]))
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual(len(server.turns), 1)

    def test_compressed_chat_receives_input_but_replaced_chat_does_not(self):
        self.box = mailbox()
        delivery.install_producer(self.box, Store(chat="old"))
        owner = self.box.find_canonical_live_owner(self.home)
        self.box.deliver_to_live_owner(self.home, owner, "for the compressed chat", delivery_id=KEY)
        server = Server({"session_key": "replacement", "agent": object()})
        self.assertFalse(self.consumer(server, Store(chat="replacement")).deliver_once("penny", self.home))
        self.assertEqual(self.record()["status"], "queued")
        server = Server({"session_key": "child", "agent": object()})
        self.assertTrue(self.consumer(server, Store(tips={"old": "child"})).deliver_once("penny", self.home))
        self.assertEqual(self.record()["status"], "settled")

    def test_profile_homes_lists_default_and_named_profiles(self):
        root = Path(self.temp.name).resolve()
        (root / "profiles" / "kimberly").mkdir()
        self.assertEqual(list(delivery.profile_homes(root)()), [("default", root), ("kimberly", root / "profiles/kimberly"), ("penny", self.home)])


if __name__ == "__main__":
    unittest.main()
