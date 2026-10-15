"""Bot Chat deliveries into add-on chats, with fake native mailbox and session stores.

The real native path is proven by scripts/spike/routine_probe.py in qualification.
"""
import contextlib
import os
import sys
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
    def __init__(self, session, started=True, outcome=None, owners=()):
        self._sessions = {"sid": session}
        self.turns, self.released = [], []
        self.started, self.outcome = started, outcome or {"status": "settled", "text": "Done with the routine."}
        self.owners = list(owners)  # refusals while another CLI or Desktop process owns the chat
    def _ensure_active_session_slot(self, sid, session):
        return self.owners.pop(0) if self.owners else None
    @contextlib.contextmanager
    def _session_turn_admission(self, session):
        yield True
    def _run_prompt_submit(self, rid, sid, session, text, **kwargs):
        self.turns.append((rid, sid, text, kwargs))
        started = self.started.pop(0) if isinstance(self.started, list) else self.started
        if started:
            kwargs["terminal_callback"](self.outcome)
        return started
    def _notif_release_turn(self, session):
        self.released.append(session); session["running"] = False


class BotDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve() / "profiles" / "penny"
        self.home.mkdir(parents=True)
        (self.home / "state.db").write_text("written store")
    def tearDown(self): self.temp.cleanup()

    def record(self, key=KEY):
        return json.loads((self.home / "runtime/bot_live_delivery" / f"{key}.json").read_text())

    def consumer(self, server, store, allowed=True, native_records=True):
        @contextlib.contextmanager
        def admission(sid):
            yield allowed
        return delivery.Consumer(server, self.box, lambda: [("penny", self.home)], lambda profile: "sid", admission,
                                 open_db=store, classify=lambda error: "provider", native_records=native_records)

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

    def test_scheduled_delivery_carries_display_provenance_without_changing_the_prompt(self):
        self.box = mailbox()
        store = Store(chat=None)
        delivery.install_producer(self.box, store)
        owner = self.box.find_canonical_live_owner(self.home)
        message = '[Cronjob "Bunny care" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nHay and water.'
        self.box.deliver_to_live_owner(self.home, owner, message, delivery_id=KEY)
        server = Server({"session_key": "stored", "agent": object()})
        self.assertTrue(self.consumer(server, store).deliver_once("penny", self.home))
        self.assertEqual(server.turns[0][2], message)
        self.assertEqual(server.turns[0][3]["display_metadata"]["origin"], {"kind": "scheduled", "visibility": "activity", "title": "Bunny care"})

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

    def test_turn_native_refuses_before_starting_is_queued_again_and_runs_once(self):
        self.box = mailbox()
        delivery.install_producer(self.box, Store())
        self.box.deliver_to_live_owner(self.home, self.box.find_canonical_live_owner(self.home), "result", delivery_id=KEY)
        session = {"session_key": "stored", "agent": object()}
        server = Server(session, started=[False, True])
        consumer = self.consumer(server, Store())
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual((self.record()["status"], "claimed_at" in self.record(), server.released), ("queued", False, [session]))
        self.assertTrue(consumer.deliver_once("penny", self.home))
        session["running"] = False
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual((len(server.turns), self.record()["status"]), (2, "settled"))

    def test_owner_contention_keeps_delivery_queued_until_released_then_runs_once(self):
        self.box = mailbox()
        delivery.install_producer(self.box, Store())
        self.box.deliver_to_live_owner(self.home, self.box.find_canonical_live_owner(self.home), "result", delivery_id=KEY)
        session = {"session_key": "stored", "agent": object()}
        server = Server(session, owners=["Session already has a live owner", "Session already has a live owner"])
        consumer = self.consumer(server, Store())
        for _ in range(2):
            self.assertFalse(consumer.deliver_once("penny", self.home))
            self.assertEqual((self.record()["status"], server.turns), ("queued", []))
        self.assertTrue(consumer.deliver_once("penny", self.home))
        session["running"] = False
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual((len(server.turns), self.record()["status"]), (1, "settled"))

    def test_legacy_runtime_consumer_runs_only_addon_receipts(self):
        # After a rollback the native consumer owns its records; the add-on owes only its own.
        self.box = mailbox()
        delivery.install_producer(self.box, Store())
        self.box.deliver_to_live_owner(self.home, self.box.find_canonical_live_owner(self.home), "add-on", delivery_id=KEY)
        native = {"profile_home": str(self.home), "session_id": "stored", "lease_id": "lease", "live_session_id": "live"}
        (self.box._root(self.home) / f"{OTHER}.json").write_text(json.dumps(dict(
            id=OTHER, delivery_id=OTHER, owner=native, **native, message="native", status="queued", created_at=0, sequence=0)))
        session = {"session_key": "stored", "agent": object()}
        server = Server(session)
        consumer = self.consumer(server, Store(), native_records=False)
        self.assertTrue(consumer.deliver_once("penny", self.home))
        session["running"] = False
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual([turn[2] for turn in server.turns], ["add-on"])
        self.assertEqual((self.record()["status"], self.record(OTHER)["status"]), ("settled", "queued"))

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

    def test_new_profile_with_unwritten_store_queues_for_its_first_chat(self):
        self.box = mailbox()
        (self.home / "state.db").write_text("")
        def unopenable(home):
            raise AssertionError("an empty store has no schema to read")
        delivery.install_producer(self.box, unopenable)
        owner = self.box.find_canonical_live_owner(self.home)
        self.assertEqual((owner["consumer"], owner["session_id"]), ("agent-interface", delivery.UNOPENED))

    def test_update_runs_only_never_started_native_owner_receipts(self):
        # Hermes 6ebd92d pinned receipts to its dashboard lease, which an update ends.
        self.box = mailbox()
        root = self.box._root(self.home); root.mkdir(parents=True)
        native = {"profile_home": str(self.home), "session_id": "stored", "lease_id": "old-lease", "live_session_id": "old"}
        for key, status, extra in ((KEY, "queued", {}), (OTHER, "claimed", {}), ("c" * 64, "queued", {"admission_id": "authority"})):
            (root / f"{key}.json").write_text(json.dumps(dict(id=key, delivery_id=key, owner=native, **native, message="native " + status,
                                                              status=status, created_at=1, sequence=1, **extra)))
        session = {"session_key": "stored", "agent": object()}
        server = Server(session)
        consumer = self.consumer(server, Store())
        self.assertTrue(consumer.deliver_once("penny", self.home))
        session["running"] = False
        self.assertFalse(consumer.deliver_once("penny", self.home))
        self.assertEqual([turn[2] for turn in server.turns], ["native queued"])
        self.assertEqual((self.record()["status"], self.record(OTHER)["status"], self.record("c" * 64)["status"]), ("settled", "claimed", "queued"))

    def test_profile_homes_lists_default_and_named_profiles(self):
        root = Path(self.temp.name).resolve()
        (root / "profiles" / "kimberly").mkdir()
        self.assertEqual(list(delivery.profile_homes(root)()), [("default", root), ("kimberly", root / "profiles/kimberly"), ("penny", self.home)])


class LegacyRuntimeHandoffTests(unittest.TestCase):
    """A rollback to Hermes 6ebd92d, against its real live-owner mailbox and consumer claim."""

    def setUp(self):
        source = Path(os.environ.get("HERMES_NATIVE_DELIVERY_SOURCE", "/nonexistent"))
        if not (source / "tools/bot_live_delivery.py").is_file() or (source / "gateway/session_bot.py").exists():
            self.skipTest("Set HERMES_NATIVE_DELIVERY_SOURCE to a Hermes 6ebd92d source (ruamel.yaml importable)")
        saved = {name: module for name, module in sys.modules.items() if name.split(".")[0] in ("tools", "utils", "hermes_cli", "hermes_yaml")}
        for name in saved:
            del sys.modules[name]
        sys.path.insert(0, str(source))
        try:
            self.native = importlib.import_module("tools.bot_live_delivery")
        finally:
            sys.path.remove(str(source))
            for name in [name for name in sys.modules if name.split(".")[0] in ("tools", "utils", "hermes_cli", "hermes_yaml")]:
                del sys.modules[name]
            sys.modules.update(saved)
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        (self.home / "state.db").write_text("written store")

    def tearDown(self):
        self.temp.cleanup()

    def test_queued_bridge_receipt_is_delivered_once_after_rollback(self):
        native = self.native
        self.assertFalse(delivery.bridge_required(native) or delivery.install_producer(native, Store()))
        # The unified runtime's bridge queued this, then Hermes rolled back before it ran.
        owner = delivery.owned_owner(self.home, Store())
        delivery.admit(native, self.home, owner, "[Cronjob] queued before rollback", delivery_id=KEY)
        # The native consumer's claim, with its real lease, never matches an add-on pin.
        lease = {"profile_home": str(self.home), "session_id": "stored", "lease_id": "dashboard-lease", "live_session_id": "live"}
        self.assertIsNone(native.claim_pending_delivery(self.home, lease))
        native_record = native.deliver_to_live_owner(self.home, lease, "native delivery", delivery_id=OTHER)
        session = {"session_key": "stored", "agent": object()}
        server = Server(session)
        @contextlib.contextmanager
        def admission(sid):
            yield True
        consumer = delivery.Consumer(server, native, lambda: [("default", self.home)], lambda profile: "sid", admission,
                                     open_db=Store(), native_records=False)
        self.assertTrue(consumer.deliver_once("default", self.home))
        session["running"] = False
        self.assertFalse(consumer.deliver_once("default", self.home))
        self.assertEqual([turn[2] for turn in server.turns], ["[Cronjob] queued before rollback"])
        self.assertEqual(native.read_delivery_result(self.home, KEY)["status"], "settled")
        # The native record stays the native consumer's, and only it claims it.
        self.assertEqual(native.read_delivery_result(self.home, OTHER)["status"], "queued")
        self.assertEqual(native.claim_pending_delivery(self.home, lease)["delivery_id"], native_record["delivery_id"])
        self.assertIsNone(native.claim_pending_delivery(self.home, lease))


if __name__ == "__main__":
    unittest.main()
