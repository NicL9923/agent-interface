"""Which native turn ran a receipt's prompt, and the prompt row a receipt is bound to.

Hermes is a fake at its edges, modeled on upstream ``NousResearch/hermes-agent`` at ``ed1afb0``:
``prompt.submit`` stages the prompt's row and hands its own request ID to the turn it starts
(``tui_gateway/methods_prompt.py:954-973``, ``_run_after_agent_ready`` at ``:674-713``); over a running turn it
redirects or queues instead (``session_auto_continue.py:400-454``). The queue merges text-only arrivals into one
envelope (``:147-176``), writes the queued row at accept and again at drain (``:292-398``), and the drain runs
the queued prompt under the request ID of the turn that just finished (``prompt_turn.py:441-460``), as a goal
continuation does (``:424-439``). ``_run_prompt_submit`` runs the turn on a thread that copies the caller's
contextvars (``session_lifecycle.py:24-46``, ``agent/memory_provider.py:21-33``); the turn adopts the staged
row only when it holds the turn's text (``session_workdir.py:807-814``) and reports its prompt row in
``message.complete`` (``prompt_turn.py:902-942``). Any other native method raises. The bridge, the journal and
every add-on wrapper are the real code.
"""
import contextvars
import copy
import json
import threading
import time
import unittest

from hermes_extension_journal_test import FakeGateway, FakeHermes, image_text, receipt, turns

NATIVE = ("profiles.list", "session.resume", "session.activate", "image.attach", "prompt.submit", "session.steer")


class Turn:
    """One native turn. It holds after it starts until the test releases it."""
    def __init__(self, rid, text, display_kind, images):
        self.rid, self.text, self.display_kind, self.images = rid, text, display_kind, images
        self.started, self.release, self.done = threading.Event(), threading.Event(), threading.Event()
        self.consume_steers, self.goal, self.row, self.report_row = True, None, None, True


class TurnHermes(FakeHermes):
    """The canonical session "sid" with Hermes's turn lifecycle, admission, busy queue and drains.

    ``busy`` is what prompt.submit does over a running turn: "queued" or "redirected" (Hermes's default
    ``interrupt`` mode redirects text and queues anything else). ``races`` run inside the add-on's next
    image.attach or prompt.submit, before Hermes looks at the session: another client's prompt that reached
    Hermes after the add-on found the session idle.
    """
    def __init__(self, busy="queued"):
        super().__init__([])
        self.busy, self.races, self.turns, self.rows, self.calls = busy, [], [], [], []
        self.changed = threading.Condition()
        server = self.server
        server.handle_request = self.handle
        server._run_prompt_submit = self.run_prompt_submit
        server._run_post_turn_followups = self.post_turn_followups

    def __enter__(self):
        super().__enter__()
        self.open()
        return self

    def __exit__(self, *exc):
        # Every turn ends before the journal closes, so a failed test reports its failure.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.changed:
                pending = [turn for turn in self.turns if not turn.done.is_set()]
            if not pending and not self.session.get("running"):
                break
            for turn in pending:
                turn.release.set()
            time.sleep(0.01)
        return super().__exit__(*exc)

    @property
    def session(self):
        return self.server._sessions["sid"]

    def handle(self, request):
        method, params, rid = request["method"], request.get("params") or {}, request.get("id")
        self.calls.append((method, rid, dict(params)))
        ok = self.server._ok
        if method not in NATIVE:
            raise AssertionError("Hermes method not configured for this test: " + method)
        if method == "profiles.list":
            return ok(rid, {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
        if method in ("session.resume", "session.activate"):
            self.server._sessions.setdefault("sid", {"session_key": "stored", "history_lock": threading.RLock(), "attached_images": [], "running": False})
            shown = [] if params.get("omit_messages") else [copy.deepcopy(row) for row in self.rows if not row.get("inactive")]
            return ok(rid, {"session_id": "sid", "messages": shown})
        if method in ("image.attach", "prompt.submit"):
            while self.races:
                self.races.pop(0)()
        if method == "image.attach":
            self.session["attached_images"].append(params["path"])
            return ok(rid, {"attached": True})
        if method == "session.steer":
            with self.session["history_lock"]:
                self.session.setdefault("corrections", []).append(params["text"])
            return ok(rid, {"status": "queued"})
        return self.submit(rid, params)

    def write_row(self, text, role="user", display_kind=None):
        with self.changed:
            row = {"row_id": 100 + len(self.rows), "role": role, "text": text, "timestamp": time.time(),
                   **({"display_kind": display_kind} if display_kind else {})}
            self.rows.append(row)
            return row

    def row(self, row_id):
        return next(row for row in self.rows if row["row_id"] == row_id)

    def row_of(self, text):
        """The shown user row holding exactly ``text``."""
        return next(row["row_id"] for row in self.rows if row["role"] == "user" and row["text"] == text and not row.get("inactive"))

    def submit(self, rid, params):
        """prompt.submit, for the add-on and for another client alike."""
        text, session = params["text"], self.session
        with session["history_lock"]:
            if session["running"]:
                images, session["attached_images"] = session["attached_images"], []
                if self.busy == "redirected" and text.strip() and not images:
                    session.setdefault("corrections", []).append(text)
                    return self.server._ok(rid, {"status": "redirected"})
                self.enqueue(text, images, accepted=True)
                return self.server._ok(rid, {"status": "queued"})
            session["running"] = True
            staged = {"content": text, "_row_id": self.write_row(text)["row_id"]} if text.strip() else None
            if staged:
                session["_submit_user_row"] = staged
        threading.Thread(target=lambda: self.server._run_prompt_submit(rid, "sid", session, text), daemon=True).start()
        return self.server._ok(rid, {"status": "streaming", **({"user_row_id": staged["_row_id"]} if staged else {})})

    def other_client(self, text, rid=7):
        """Another client's prompt.submit. Its turn starts on its own thread, as Hermes's does."""
        return self.submit(rid, {"session_id": "sid", "text": text})

    def enqueue(self, text, images, accepted=False):
        """_enqueue_prompt and, for an accepted prompt, _persist_queued_user_row."""
        session = self.session
        head, rest = session.get("queued_prompt"), session.setdefault("queued_prompts", [])
        if not images and head and not head["images"] and not rest:
            head["text"] = head["text"] + "\n\n" + text
            if head.get("row"):
                head["row"]["text"] = head["text"]
            return
        envelope = {"text": text, "images": images}
        if accepted and text.strip():
            envelope["row"] = self.write_row(text)
        if head:
            rest.append(envelope)
        else:
            session["queued_prompt"] = envelope

    def drain(self, rid):
        session = self.session
        with session["history_lock"]:
            envelope = session.get("queued_prompt")
            if not envelope or session["running"]:
                return False
            rest = session.get("queued_prompts") or []
            session["queued_prompt"], session["queued_prompts"] = (rest[0] if rest else None), rest[1:]
            session["running"] = True
            if envelope.get("row"):
                # The accept-time row moves to the end: a fresh row is staged, the early one deactivated.
                envelope["row"]["inactive"] = True
                session["_submit_user_row"] = {"content": envelope["text"], "_row_id": self.write_row(envelope["text"])["row_id"]}
        self.server._run_prompt_submit(rid, "sid", session, envelope["text"], **({"image_paths": envelope["images"]} if envelope["images"] else {}))
        return True

    def run_prompt_submit(self, rid, sid, session, text, *, display_kind=None, image_paths=None, turn_author=None):
        with session["history_lock"]:
            images = list(image_paths) if image_paths is not None else session["attached_images"]
            if image_paths is None:
                session["attached_images"] = []
        turn = Turn(rid, text, display_kind, images)
        with self.changed:
            self.turns.append(turn)
            self.changed.notify_all()
        context = contextvars.copy_context()
        threading.Thread(target=context.run, args=(self.run_turn, sid, session, turn), daemon=True).start()
        return True

    def run_turn(self, sid, session, turn):
        staged = session.pop("_submit_user_row", None)
        if not isinstance(staged, dict) or staged["content"] != turn.text:
            staged = None
        turn.started.set()
        if not turn.release.wait(5):
            raise AssertionError("The test never released the turn for " + repr(turn.text))
        if staged:
            turn.row = staged["_row_id"]
            if turn.images:
                self.row(turn.row)["text"] = image_text(turn.text, turn.images)
        else:
            turn.row = self.write_row(image_text(turn.text, turn.images), display_kind=turn.display_kind)["row_id"]
        with session["history_lock"]:
            # Corrections steered or redirected into the running turn; the turn persists those it took.
            corrections, session["corrections"] = session.get("corrections", []), []
        leftover = []
        for steer in corrections:
            if turn.consume_steers:
                self.write_row(steer)
            else:
                leftover.append(steer)
        self.write_row("Answer to " + turn.text, role="assistant")
        # A runtime that returns no messages has no turn suffix to address (_persisted_turn_receipt).
        persisted = {"persisted_turn": {"user_row_id": turn.row}} if turn.report_row else {}
        self.server.write_json({"jsonrpc": "2.0", "method": "event", "params": {"session_id": sid, "type": "message.complete", "payload": {
            "text": "Answer", "status": "complete", **persisted}}})
        with session["history_lock"]:
            session["running"] = False
        result = {"final_response": "Answer to " + turn.text, **({"pending_steer": "\n".join(leftover)} if leftover else {})}
        try:
            self.server._run_post_turn_followups(turn.rid, sid, session, result, turn.goal)
        finally:
            turn.done.set()

    def post_turn_followups(self, rid, sid, session, result, goal):
        if result.get("pending_steer"):
            with session["history_lock"]:
                self.enqueue(result["pending_steer"], [])
        if self.drain(rid):
            return
        if goal:
            with session["history_lock"]:
                if session["running"]:
                    return
                session["running"] = True
            self.server._run_prompt_submit(rid, sid, session, goal)

    def turn(self, text, nth=0):
        """The ``nth`` turn running ``text``, once it has started."""
        with self.changed:
            if not self.changed.wait_for(lambda: sum(turn.text == text for turn in self.turns) > nth, 5):
                raise AssertionError("No turn ran " + repr(text))
            turn = [turn for turn in self.turns if turn.text == text][nth]
        if not turn.started.wait(5):
            raise AssertionError("The turn for " + repr(text) + " never started")
        return turn

    def finish(self, text, nth=0):
        turn = self.turn(text, nth)
        turn.release.set()
        if not turn.done.wait(5):
            raise AssertionError("The turn for " + repr(text) + " never finished")
        return turn

    def send(self, request_id, text, sender="alice", **params):
        response = self.methods["agent-interface.submit"]("send", {"profile": "default", "request_id": request_id,
                                                                   "sender_id": sender, "text": text, **params})
        return response["result"]

    def bound(self, request_id):
        return self.journal.db.execute("SELECT row_id FROM receipts WHERE request_id=?", (request_id,)).fetchone()[0]

    def shown(self):
        """The open's user rows: text and the receipt and sender they are attributed to."""
        return [(row["row_id"], row.get("app_display_text", row["text"]), row.get("app_request_id"), row.get("app_sender_id"))
                for row in self.open()["messages"] if row["role"] == "user"]


class TurnBindingTests(unittest.TestCase):
    def test_a_send_hermes_queued_is_never_bound_to_the_turn_running_ahead_of_it(self):
        with TurnHermes(busy="queued") as hermes:
            hermes.races.append(lambda: hermes.other_client("Book the dentist"))
            self.assertEqual(hermes.send("alice-1", "What's for dinner?")["status"], "accepted")
            bob = hermes.finish("Book the dentist")
            alice = hermes.finish("What's for dinner?")
            self.assertEqual(alice.rid, bob.rid, "the drain runs under the finished turn's request ID")
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(bob.row, "Book the dentist", None, None), (alice.row, "What's for dinner?", None, None)])
            # The receipt the server reads says no row either.
            receipt_answer = hermes.methods["agent-interface.receipt"]("lookup", {"request_id": "alice-1"})["result"]["receipt"]
            self.assertIsNone(receipt_answer["userRowId"])

    def test_a_send_hermes_redirected_into_another_clients_turn_stays_unbound(self):
        with TurnHermes(busy="redirected") as hermes:
            hermes.races.append(lambda: hermes.other_client("Book the dentist"))
            self.assertEqual(hermes.send("alice-1", "Make it Tuesday")["status"], "accepted")
            bob = hermes.finish("Book the dentist")
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(bob.row, "Book the dentist", None, None), (hermes.row_of("Make it Tuesday"), "Make it Tuesday", None, None)])

    def test_a_new_task_that_starts_at_once_keeps_the_row_hermes_named(self):
        with TurnHermes() as hermes:
            answer = hermes.send("alice-1", "What's for dinner?")
            turn = hermes.turn("What's for dinner?")
            self.assertEqual(answer["userRowId"], hermes.bound("alice-1"))
            hermes.finish("What's for dinner?")
            self.assertEqual(hermes.bound("alice-1"), turn.row)
            self.assertEqual(hermes.shown(), [(turn.row, "What's for dinner?", "alice-1", "alice")])

    def test_an_image_send_is_bound_to_the_row_its_own_turn_reports(self):
        photo = {"path": "/uploads/alice/photo.png", "name": "photo.png", "mime": "image/png"}
        with TurnHermes() as hermes:
            answer = hermes.send("alice-1", "", attachments=[photo])
            self.assertIsNone(answer["userRowId"], "an image sent alone has no staged row")
            turn = hermes.finish("")
            self.assertEqual(turn.images, [photo["path"]])
            self.assertEqual(hermes.bound("alice-1"), turn.row)
            [row] = [row for row in hermes.open()["messages"] if row["role"] == "user"]
            self.assertEqual((row["app_request_id"], row["app_attachments"], row["app_display_text"]), ("alice-1", [photo], ""))

    def test_a_queued_image_send_is_recovered_only_by_its_own_words_and_uploads(self):
        photo = {"path": "/uploads/alice/photo.png", "name": "photo.png", "mime": "image/png"}
        with TurnHermes(busy="queued") as hermes:
            # The desktop's turn takes the session before Alice's image is staged, so Hermes queues
            # her message with its image, as its own envelope.
            hermes.races.append(lambda: hermes.other_client("Book the dentist"))
            self.assertEqual(hermes.send("alice-1", "Look at this", attachments=[photo])["status"], "accepted")
            bob = hermes.finish("Book the dentist")
            alice = hermes.finish("Look at this")
            self.assertEqual((bob.images, alice.images), ([], [photo["path"]]))
            # The completion bound nothing; the open's recovery matched the row holding Alice's own upload.
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(bob.row, "Book the dentist", None, None), (alice.row, "Look at this", "alice-1", "alice")])
            self.assertEqual(hermes.bound("alice-1"), alice.row)

    def test_image_recovery_never_takes_a_row_another_receipt_holds(self):
        photo = {"path": "/uploads/alice/photo.png", "name": "photo.png", "mime": "image/png"}
        rows = [{"row_id": 5, "role": "user", "text": image_text("Look", [photo["path"]]), "timestamp": 50}]
        with FakeGateway(rows) as hermes:
            with hermes.journal.db:
                receipt(hermes.journal.db, "kim-1", 5, 1, text="Look", attachments=[photo], actor="kim")
                receipt(hermes.journal.db, "alice-1", None, 2, text="Look", attachments=[photo], actor="alice")
            [row] = hermes.open()["messages"]
            self.assertEqual(row["app_request_id"], "kim-1")
            self.assertIsNone(hermes.journal.db.execute("SELECT row_id FROM receipts WHERE request_id='alice-1'").fetchone()[0])

    def test_a_steer_consumed_in_place_is_bound_to_its_own_row_by_its_words(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            turn = hermes.turn("Plan the trip")
            answer = hermes.send("kim-1", "Avoid flights", sender="kim")
            self.assertTrue(answer["steering"])
            hermes.finish("Plan the trip")
            self.assertEqual(hermes.shown(), [(turn.row, "Plan the trip", "alice-1", "alice"), (hermes.row_of("Avoid flights"), "Avoid flights", "kim-1", "kim")])

    def test_guidance_that_runs_as_its_own_turn_is_bound_only_by_its_words(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            first = hermes.turn("Plan the trip")
            first.consume_steers = False
            hermes.send("kim-1", "Avoid flights", sender="kim")
            hermes.finish("Plan the trip")
            guidance = hermes.finish("Avoid flights")
            self.assertEqual(guidance.rid, first.rid)
            self.assertEqual(hermes.bound("alice-1"), first.row)
            self.assertEqual(hermes.shown(), [(first.row, "Plan the trip", "alice-1", "alice"), (guidance.row, "Avoid flights", "kim-1", "kim")])

    def test_two_members_sends_behind_one_native_turn_each_get_their_own_row_or_none(self):
        with TurnHermes(busy="queued") as hermes:
            hermes.races.append(lambda: hermes.other_client("Book the dentist"))
            hermes.send("alice-1", "What's for dinner?")
            # Hermes is running now, so the next member's send steers into the turn Alice's receipt names.
            self.assertTrue(hermes.send("kim-1", "And dessert", sender="kim")["steering"])
            bob = hermes.finish("Book the dentist")
            alice = hermes.finish("What's for dinner?")
            self.assertEqual((hermes.bound("alice-1"), hermes.bound("kim-1")), (None, None))
            self.assertEqual(hermes.shown(), [(bob.row, "Book the dentist", None, None), (hermes.row_of("And dessert"), "And dessert", None, None),
                                              (alice.row, "What's for dinner?", None, None)])

    def test_two_queued_texts_merged_by_hermes_bind_to_neither_sender(self):
        with TurnHermes(busy="queued") as hermes:
            hermes.other_client("Book the dentist")
            bob = hermes.turn("Book the dentist")
            # Two sends Hermes queues behind the running turn merge into one envelope and one turn.
            hermes.enqueue("What's for dinner?", [], accepted=True)
            with hermes.journal.db:
                receipt(hermes.journal.db, "alice-1", None, time.time(), text="What's for dinner?", actor="alice")
                receipt(hermes.journal.db, "kim-1", None, time.time(), text="And dessert", actor="kim")
                hermes.journal.db.execute("UPDATE receipts SET terminal=0,session_id='sid'")
            hermes.enqueue("And dessert", [], accepted=True)
            hermes.finish("Book the dentist")
            merged = hermes.finish("What's for dinner?\n\nAnd dessert")
            self.assertEqual((hermes.bound("alice-1"), hermes.bound("kim-1")), (None, None))
            self.assertEqual(hermes.shown(), [(bob.row, "Book the dentist", None, None), (merged.row, "What's for dinner?\n\nAnd dessert", None, None)])

    def test_a_turn_resumed_after_a_restart_binds_no_waiting_send(self):
        with TurnHermes(busy="queued") as hermes:
            # Hermes resumes an interrupted turn on its own; an app send races it to the session.
            hermes.races.append(lambda: (hermes.session.update(running=True),
                                         hermes.server._run_prompt_submit("__auto_continue__1", "sid", hermes.session, "[Resume] Plan the trip", display_kind="auto_continue")))
            hermes.send("alice-1", "Status?")
            resumed = hermes.finish("[Resume] Plan the trip")
            alice = hermes.finish("Status?")
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.row(resumed.row)["display_kind"], "auto_continue")
            self.assertEqual(hermes.shown()[-1], (alice.row, "Status?", None, None))

    def test_a_goal_continuation_never_takes_the_receipt_of_the_turn_before_it(self):
        photo = {"path": "/uploads/alice/photo.png", "name": "photo.png", "mime": "image/png"}
        with TurnHermes() as hermes:
            hermes.send("alice-1", "", attachments=[photo])
            first = hermes.turn("")
            # Her turn reports no prompt row, so her receipt is still unbound when Hermes continues
            # toward the goal under her request ID, on her turn's thread.
            first.goal, first.report_row = "Continue toward the goal", False
            first.release.set()
            goal = hermes.finish("Continue toward the goal")
            self.assertEqual(goal.rid, first.rid)
            self.assertIsNone(hermes.bound("alice-1"))
            # The open's image recovery finds her own row; the continuation's row stays Hermes's.
            self.assertEqual(hermes.shown(), [(first.row, "", "alice-1", "alice"), (goal.row, "Continue toward the goal", None, None)])


    def test_a_send_drained_under_an_app_turns_request_id_never_takes_its_receipt(self):
        photo = {"path": "/uploads/alice/photo.png", "name": "photo.png", "mime": "image/png"}
        with TurnHermes(busy="queued") as hermes:
            hermes.send("alice-1", "", attachments=[photo])
            first = hermes.turn("")
            first.report_row = False
            # The desktop sends an image alone while Alice's turn runs; Hermes queues it, then runs
            # it under her turn's request ID, with the same empty text.
            with hermes.session["history_lock"]:
                hermes.session["attached_images"].append("/desktop/scan.png")
            self.assertEqual(hermes.other_client("")["result"]["status"], "queued")
            first.release.set()
            first.done.wait(5)
            desktop = hermes.finish("", nth=1)
            self.assertEqual((desktop.rid, desktop.images), (first.rid, ["/desktop/scan.png"]))
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(first.row, "", "alice-1", "alice"), (desktop.row, image_text("", ["/desktop/scan.png"]), None, None)])

    def test_a_send_left_unbound_still_lets_opens_reuse_decorated_history(self):
        photo = {"path": "/uploads/alice/photo.png", "name": "photo.png", "mime": "image/png"}
        with FakeGateway(turns(2)) as hermes:
            hermes.open()
            session = hermes.server._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            with hermes.journal.db:
                receipt(hermes.journal.db, "alice-1", None, 1, text="What's for dinner?")
            hermes.open()
            hermes.open()
            self.assertIs(hermes.native_calls[-1][1].get("omit_messages"), True)
            # An unbound image send can still be recovered from these rows, so every open reads them.
            with hermes.journal.db:
                receipt(hermes.journal.db, "kim-1", None, 2, text="", attachments=[photo], actor="kim")
            hermes.open()
            hermes.open()
            self.assertNotIn("omit_messages", hermes.native_calls[-1][1])


class OldBindingTests(unittest.TestCase):
    """A journal that earlier add-ons wrote: a queued send bound to the turn completed ahead of it."""

    def journal(self, hermes, rows):
        """Receipts as origin/main's add-on left them, with the admission answer it saved."""
        def saved(request_id, row, text, named, actor):
            receipt(hermes.journal.db, request_id, row, len(saved.order), text=text, actor=actor)
            saved.order.append(request_id)
            answer = {"requestId": request_id, "status": "accepted", "runId": request_id, "userRowId": named,
                      "senderId": actor, "steering": False, "app_run_id": request_id, "admission": "canonical"}
            hermes.journal.db.execute("UPDATE receipts SET admission_response=? WHERE request_id=?", (json.dumps(answer), request_id))
        saved.order = []
        with hermes.journal.db:
            for args in rows:
                saved(*args)

    def test_a_binding_the_rows_own_words_contradict_is_not_shown_and_is_kept(self):
        messages = [{"row_id": 10, "role": "user", "text": "Book the dentist", "timestamp": 1},
                    {"row_id": 11, "role": "assistant", "text": "Booked", "timestamp": 2},
                    {"row_id": 12, "role": "user", "text": "What's for dinner?", "timestamp": 3},
                    {"row_id": 20, "role": "user", "text": "/plan", "timestamp": 4},
                    {"row_id": 30, "role": "user", "text": "Same words", "timestamp": 5}]
        with FakeGateway(messages) as hermes:
            self.journal(hermes, [
                # Queued behind the desktop's turn; the old completion hook bound it to that turn's row.
                ("alice-1", 10, "What's for dinner?", None, "alice"),
                # Hermes's own admission answer named the row; its projection shows other words.
                ("kim-1", 20, "/plan the week", 20, "kim"),
                # Bound at completion to a row with exactly its words, as an image-less store failure leaves.
                ("kim-2", 30, "Same words", None, "kim"),
            ])
            shown = {row["row_id"]: (row.get("app_request_id"), row.get("app_display_text")) for row in hermes.open()["messages"] if row["role"] == "user"}
            self.assertEqual(shown, {10: (None, None), 12: (None, None), 20: ("kim-1", "/plan the week"), 30: ("kim-2", "Same words")})
            self.assertEqual(hermes.journal.db.execute("SELECT row_id FROM receipts WHERE request_id='alice-1'").fetchone()[0], 10)

    def test_a_contradicted_binding_without_a_saved_answer_is_not_shown(self):
        messages = [{"row_id": 10, "role": "user", "text": "Book the dentist", "timestamp": 1}]
        with FakeGateway(messages) as hermes:
            with hermes.journal.db:
                receipt(hermes.journal.db, "alice-1", 10, 1, text="What's for dinner?", actor="alice")
            [row] = hermes.open()["messages"]
            self.assertNotIn("app_request_id", row)

    def test_file_and_image_sends_and_steering_are_not_judged_by_their_words(self):
        report = {"path": "/srv/report.pdf", "name": "report.pdf", "mime": "application/pdf"}
        messages = [{"row_id": 10, "role": "user", "text": "Summarize <expanded file>", "timestamp": 1},
                    {"row_id": 11, "role": "user", "text": "<steer marker> shorter", "timestamp": 2}]
        with FakeGateway(messages) as hermes:
            with hermes.journal.db:
                receipt(hermes.journal.db, "alice-1", 10, 1, text='Summarize\n@file:"/srv/report.pdf"', attachments=[report], actor="alice")
                receipt(hermes.journal.db, "kim-1", 11, 2, run_id="alice-1", text="shorter", steering=1, actor="kim")
            shown = [row.get("app_request_id") for row in hermes.open()["messages"]]
            self.assertEqual(shown, ["alice-1", "kim-1"])


if __name__ == "__main__":
    unittest.main()
