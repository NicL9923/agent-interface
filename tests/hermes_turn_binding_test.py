"""Which native turn ran a receipt's prompt, and the prompt row a receipt is bound to.

Hermes is a fake at its edges, modeled on upstream ``NousResearch/hermes-agent`` at ``ed1afb0``:
``prompt.submit`` stages the prompt's row and hands its own request ID to the turn it starts
(``tui_gateway/methods_prompt.py:954-973``, ``_run_after_agent_ready`` at ``:674-713``); over a running turn it
redirects or queues instead (``session_auto_continue.py:400-454``). The queue merges text-only arrivals into one
envelope (``:147-176``), writes the queued row at accept and again at drain (``:292-398``), and the drain runs
the queued prompt under the request ID of the turn that just finished (``prompt_turn.py:441-460``), as a goal
continuation does (``:424-439``). ``_run_prompt_submit`` runs the turn on a thread that copies the caller's
contextvars (``session_lifecycle.py:24-46``, ``agent/memory_provider.py:21-33``); the turn adopts the staged
row only when it holds the turn's text (``session_workdir.py:807-814``), writes a row of its own when it
could not rewrite the staged row after image or ``@`` expansion (``:815-835``), and reports its prompt row and every
committed row of the turn in ``message.complete`` (``prompt_turn.py:902-942``, ``agent/persisted_turn_receipt.py:20-65``).
The turn snapshots and clears the session's attached images when ``_run_prompt_submit`` admits it, on the
caller's thread (``_admit_prompt_turn``, ``prompt_turn.py:150``), and later runs the model through ``_invoke_agent``
on its own thread (``:1183``), where the add-on checks for an app prompt and adds its guidance; at the qualified
revisions ``b9cb268`` and ``d23cc6b`` the same lines are ``:141`` and ``:1108``.
``session.steer`` answers with no row (``methods_session_interrupt.py:114-130``). At each tool batch the turn
drains every waiting steer and writes them as one user row of their newline-joined words
(``agent/interrupt_control.py:90-102``, ``agent/agent_runtime_helpers.py:3668-3703``, ``agent/prompt_builder.py:586-592``),
so a turn can deliver earlier guidance and hand later guidance back as the next prompt (``agent/turn_finalizer.py:844-849``,
``tui_gateway/prompt_turn.py:441-451``). Any other native method raises. The bridge, the journal and every add-on
wrapper are the real code.
"""
import contextvars
import copy
import json
import os
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from hermes_extension_journal_test import FakeGateway, FakeHermes, extension, image_text, receipt, turns

NATIVE = ("profiles.list", "session.resume", "session.activate", "image.attach", "prompt.submit", "session.steer")


def source_git(args, **kwargs):
    """git as source_state runs it on a clean checkout of the qualified revision. Any other command raises."""
    if args[:2] == ["git", "-C"] and args[3:] == ["rev-parse", "HEAD"]:
        return extension.REVISION
    if args[:4] == ["git", "-c", "core.abbrev=10", "-C"] and args[5:] == ["diff", "HEAD"]:
        return b""
    raise AssertionError("Command not configured for this test: " + repr(args))


class Turn:
    """One native turn. It holds after it starts until the test releases it."""
    def __init__(self, rid, sid, text, display_kind, images, author=None):
        self.rid, self.sid, self.text, self.display_kind, self.images, self.author = rid, sid, text, display_kind, images, author
        self.started, self.release, self.done = threading.Event(), threading.Event(), threading.Event()
        # The session's agent as _invoke_agent receives it on the turn; guided: the guidance the model ran with.
        self.agent, self.guided = types.SimpleNamespace(ephemeral_system_prompt=None), None
        self.consume_steers, self.goal, self.row, self.report_row, self.report_rows = True, None, None, True, True
        # fails: the turn ends without message.complete. early: (session, persisted_turn or None) completions
        # this turn's thread writes before its own. adopt: False when the turn could not rewrite its staged row
        # and wrote its own. row_ids: what the completion reports as the turn's rows, in place of the real ones.
        # delivered: rows of steers its earlier tool batches drained.
        self.fails, self.early, self.adopt, self.row_ids, self.delivered = False, [], True, None, []


class TurnHermes(FakeHermes):
    """The canonical session "sid" with Hermes's turn lifecycle, admission, busy queue and drains.

    ``busy`` is what prompt.submit does over a running turn: "queued" or "redirected" (Hermes's default
    ``interrupt`` mode redirects text and queues anything else). ``races`` run inside the add-on's next
    image.attach or prompt.submit, before Hermes looks at the session: another client's prompt that reached
    Hermes after the add-on found the session idle. ``submit_races`` run only inside the add-on's next
    prompt.submit, so after its image.attach. ``start_as`` changes how the next turn prompt.submit starts
    is run: its session, text, display kind or author. ``snapshots`` lists each admitted turn's text and the
    images it took, in admission order; ``snapshotted`` waits for one. With ``voice`` on, a typed "stop" ends the
    voice chat and admits nothing. ``reply_as`` replaces the answer to the next prompt.submit that starts a turn, and
    ``hold_admission`` is an Event that turn's thread waits on before Hermes admits it and takes the images.

    image.attach appends the path, symlinks resolved, without a lock and answers it as ``path``, as native's does
    (``methods_prompt.py:1020-1023`` and ``:1352-1355`` at ``ed1afb0``, ``:749-752`` and ``:1094-1097`` at the others).
    ``pause_attach`` makes the next one wait after it appends, where native reads the image's header
    (``_image_meta``, ``server.py:754-763`` at ``ed1afb0``, ``:840-849`` at the others). With ``fail="after"`` it then
    answers 5027, as native does for an error after the append; with ``fail="before"`` it waits and answers 5027 without
    appending, as native does when resolving the path raises (``methods_prompt.py:1008-1019`` and ``:1024-1025``).
    """
    def __init__(self, busy="queued"):
        super().__init__([])
        self.busy, self.races, self.submit_races, self.turns, self.rows, self.calls, self.start_as = busy, [], [], [], [], [], {}
        self.snapshots, self.changed = [], threading.Condition()
        self.voice, self.reply_as, self.hold_admission, self.attach_pause = False, None, None, None
        server = self.server
        server.handle_request = self.handle
        server._run_prompt_submit = self.run_prompt_submit
        server._invoke_agent = self.invoke_agent
        server._run_post_turn_followups = self.post_turn_followups

    def start(self, path):
        # source_state reads the Hermes checkout with git; answer as a clean qualified checkout would.
        self.modules["hermes_cli"].__file__ = self.directory.name + "/hermes_cli/__init__.py"
        with patch.object(extension.subprocess, "check_output", source_git):
            journal = extension.install(path)
        self.methods = self.registered
        self.bridge = self.methods["agent-interface.open"].__self__
        return journal

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
        if method == "prompt.submit":
            while self.submit_races:
                self.submit_races.pop(0)()
        if method == "image.attach":
            images = self.session["attached_images"]
            pause, self.attach_pause = self.attach_pause, None
            fail = pause[2] if pause is not None else None
            # Native resolves the path first (hermes_cli/cli_terminal_input.py:86-137).
            path = os.path.realpath(params["path"])
            if fail != "before":
                images.append(path)
            if pause is not None:
                appended, resume, _ = pause
                appended.set()
                if not resume.wait(5):
                    raise AssertionError("The test never resumed image.attach")
                if fail:
                    return self.server._err(rid, 5027, "Synthetic image failure " + fail + " the append")
            return ok(rid, {"attached": True, "path": path, "count": len(images)})
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

    def rows_of(self, text):
        """The shown user rows holding exactly ``text``."""
        return [row["row_id"] for row in self.rows if row["role"] == "user" and row["text"] == text and not row.get("inactive")]

    def row_of(self, text):
        [row_id] = self.rows_of(text)
        return row_id

    def submit(self, rid, params):
        """prompt.submit, for the add-on and for another client alike."""
        text, session = params["text"], self.session
        # A stop phrase typed while the session's voice mode is on ends the voice chat before Hermes reads the
        # session, so nothing is admitted and its attached images stay staged (methods_prompt.py:835-836 at
        # ed1afb0, :580 at b9cb268 and d23cc6b).
        if self.voice and text.strip().lower() == "stop":
            self.voice = False
            return self.server._ok(rid, {"voice_stopped": True})
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
        started, self.start_as = {"sid": "sid", "text": text, **self.start_as}, {}
        sid, text = started.pop("sid"), started.pop("text")
        hold, self.hold_admission = self.hold_admission, None
        def admit():
            if hold is not None and not hold.wait(5):
                raise AssertionError("The test never let Hermes admit " + repr(text))
            self.server._run_prompt_submit(rid, sid, session, text, **started)
        threading.Thread(target=admit, daemon=True).start()
        reply, self.reply_as = self.reply_as, None
        return self.server._ok(rid, reply if reply is not None else {"status": "streaming", **({"user_row_id": staged["_row_id"]} if staged else {})})

    def pause_attach(self, fail=None):
        """The next image.attach waits after it appends until the test sets ``resume``: (appended, resume) Events."""
        appended, resume = threading.Event(), threading.Event()
        self.attach_pause = (appended, resume, fail)
        return appended, resume

    def other_attach(self, path):
        """Another client's native image.attach, which takes none of the add-on's locks."""
        return self.handle({"id": 8, "method": "image.attach", "params": {"session_id": "sid", "path": path}})["result"]

    def other_client(self, text, rid=7):
        """Another client's prompt.submit. Its turn starts on its own thread, as Hermes's does."""
        return self.submit(rid, {"session_id": "sid", "text": text})

    def snapshotted(self, text):
        """Wait until a turn running ``text`` took the session's attached images; the images it took."""
        with self.changed:
            if not self.changed.wait_for(lambda: any(each == text for each, _ in self.snapshots), 5):
                raise AssertionError("No turn admitted " + repr(text))
            return next(images for each, images in self.snapshots if each == text)

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
        # _admit_prompt_turn: the snapshot is taken here, on the caller's thread, before the turn's own starts.
        with session["history_lock"]:
            images = list(image_paths) if image_paths is not None else session["attached_images"]
            if image_paths is None:
                session["attached_images"] = []
        turn = Turn(rid, sid, text, display_kind, images, turn_author)
        with self.changed:
            self.snapshots.append((text, images))
            self.turns.append(turn)
            self.changed.notify_all()
        context = contextvars.copy_context()
        threading.Thread(target=context.run, args=(self.run_turn, session, turn), daemon=True).start()
        return True

    def complete(self, sid, persisted):
        self.server.write_json({"jsonrpc": "2.0", "method": "event", "params": {"session_id": sid, "type": "message.complete", "payload": {
            "text": "Answer", "status": "complete", **({"persisted_turn": persisted} if persisted else {})}}})

    def tool_batch(self, turn):
        """The running turn ends a tool batch: every waiting steer becomes one user row of their joined words."""
        session = self.session
        with session["history_lock"]:
            corrections, session["corrections"] = session.get("corrections", []), []
        if corrections:
            turn.delivered.append(self.write_row("\n".join(corrections))["row_id"])

    def invoke_agent(self, sid, session, turn, prompt, run_message, streamer, images, display_kind, display_metadata,
                     turn_author=None, text=None):
        """_invoke_agent: the model runs, on the turn's thread, and its rows are written. Returns the leftover steers."""
        turn.guided = turn.agent.ephemeral_system_prompt
        if not turn.release.wait(5):
            raise AssertionError("The test never released the turn for " + repr(text))
        leftover = []
        if turn.fails:
            return leftover
        staged = turn.staged if turn.adopt else None
        if staged:
            turn.row = staged["_row_id"]
            if images:
                self.row(turn.row)["text"] = image_text(text, images)
        else:
            turn.row = self.write_row(image_text(text, images), display_kind=display_kind)["row_id"]
        # Corrections steered or redirected into the running turn: a last tool batch delivers whatever
        # is waiting, or the turn ends with none and hands it back as the next prompt.
        if turn.consume_steers:
            self.tool_batch(turn)
        else:
            with session["history_lock"]:
                leftover, session["corrections"] = session.get("corrections", []), []
        return leftover

    def run_turn(self, session, turn):
        staged = session.pop("_submit_user_row", None)
        turn.staged = staged if isinstance(staged, dict) and staged["content"] == turn.text else None
        turn.started.set()
        # The add-on wraps _invoke_agent; the wrapper passes the turn record through as Hermes's _TurnRun.
        leftover = self.server._invoke_agent(turn.sid, session, turn, turn.text, None, None, turn.images, turn.display_kind, None,
                                             turn.author, turn.text)
        if not turn.fails:
            committed = [turn.row, *turn.delivered, self.write_row("Answer to " + turn.text, role="assistant")["row_id"]]
            for sid, persisted in turn.early:
                self.complete(sid, persisted)
            row_ids = committed if turn.row_ids is None else turn.row_ids
            # A runtime that returns no messages has no turn suffix to address (_persisted_turn_receipt).
            self.complete(turn.sid, {"user_row_id": turn.row, **({"row_ids": row_ids} if turn.report_rows else {})} if turn.report_row else None)
        with session["history_lock"]:
            session["running"] = False
        result = {"final_response": "Answer to " + turn.text, **({"pending_steer": "\n".join(leftover)} if leftover else {})}
        try:
            self.server._run_post_turn_followups(turn.rid, turn.sid, session, result, turn.goal)
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


class StoredRows(FakeGateway):
    """Hermes holding only stored rows. It answers profiles.list and session resume and activate,
    and raises on any other method."""
    def __init__(self, messages):
        super().__init__(messages)
        server = self.server
        def handle(request):
            method, params, rid = request["method"], request.get("params") or {}, request.get("id")
            self.native_calls.append((method, dict(params)))
            if method == "profiles.list":
                return server._ok(rid, {"profiles": [{"name": "default", "canonical_session": {"resolved_id": "stored"}}]})
            if method in ("session.resume", "session.activate"):
                server._sessions.setdefault("sid", {"session_key": "stored"})
                return server._ok(rid, {"session_id": "sid", "messages": [] if params.get("omit_messages") is True else copy.deepcopy(self.messages)})
            raise AssertionError("Hermes method not configured for this test: " + method)
        server.handle_request = handle

    def bound(self, request_id):
        return self.journal.db.execute("SELECT row_id FROM receipts WHERE request_id=?", (request_id,)).fetchone()[0]


class WatchedImages(list):
    """A session's attached images that call ``write()`` before any removal from them."""
    def __init__(self, images, write):
        super().__init__(images)
        self.write = write

    def __delitem__(self, index):
        self.write()
        super().__delitem__(index)

    def pop(self, *args):
        self.write()
        return super().pop(*args)

    def remove(self, value):
        self.write()
        super().remove(value)

    def clear(self):
        self.write()
        super().clear()


class WatchedSession(dict):
    """A Hermes session that calls ``write()`` before its attached images are replaced or removed from."""
    def __init__(self, session, write):
        super().__init__(session)
        self.write = write
        super().__setitem__("attached_images", WatchedImages(session["attached_images"], write))

    def __setitem__(self, key, value):
        if key == "attached_images":
            self.write()
        super().__setitem__(key, value)


PHOTO = {"path": "/uploads/shared/photo.png", "name": "photo.png", "mime": "image/png"}


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

    def test_a_row_hermes_named_at_admission_is_kept_when_its_turn_reports_another(self):
        with TurnHermes() as hermes:
            named = hermes.send("alice-1", "Summarize @notes.md")["userRowId"]
            turn = hermes.turn("Summarize @notes.md")
            # Hermes expanded @notes.md, could not rewrite the staged row, and wrote the turn's own row instead.
            turn.adopt = False
            hermes.finish("Summarize @notes.md")
            self.assertNotEqual(turn.row, named)
            self.assertEqual(hermes.bound("alice-1"), named)
            stored = hermes.journal.db.execute("SELECT turn_rows FROM receipts WHERE request_id='alice-1'").fetchone()[0]
            self.assertEqual(json.loads(stored)[0], turn.row)
            self.assertEqual(hermes.shown(), [(named, "Summarize @notes.md", "alice-1", "alice"), (turn.row, "Summarize @notes.md", None, None)])

    def test_a_completion_with_malformed_row_ids_saves_no_turn_and_later_opens_still_answer(self):
        # (case, the bad value placed in the reported rows, or "whole" for one row ID in place of the list). The first is well formed
        # and binds the steer, so each other case is unbound for its own reason alone.
        cases = [
            ("well formed", None),
            ("a dict element", {}),
            ("a string element", "12"),
            ("a boolean element", True),
            ("a zero element", 0),
            ("not a list", "whole"),
        ]
        for name, bad in cases:
            with self.subTest(name), TurnHermes() as hermes:
                named = hermes.send("alice-1", "Plan the trip")["userRowId"]
                turn = hermes.turn("Plan the trip")
                hermes.send("kim-1", "Avoid flights", sender="kim")
                hermes.tool_batch(turn)
                kim = hermes.row_of("Avoid flights")
                rows = [named, kim]
                turn.row_ids = rows if bad is None else kim if bad == "whole" else [*rows, bad]
                hermes.finish("Plan the trip")
                stored = hermes.journal.db.execute("SELECT row_id,turn_rows FROM receipts WHERE request_id='alice-1'").fetchone()
                self.assertEqual(stored, (named, json.dumps(rows) if bad is None else None))
                self.assertEqual(hermes.shown()[1], (kim, "Avoid flights", "kim-1", "kim") if bad is None else (kim, "Avoid flights", None, None))

    def test_an_image_send_is_bound_to_the_row_its_own_turn_reports_never_an_older_one(self):
        with TurnHermes() as hermes:
            # The desktop sent the same image alone a moment ago; file identifiers belong to the assistant.
            hermes.session["attached_images"].append(PHOTO["path"])
            hermes.other_client("")
            desktop = hermes.finish("")
            answer = hermes.send("alice-1", "", attachments=[PHOTO])
            self.assertIsNone(answer["userRowId"], "an image sent alone has no staged row")
            turn = hermes.turn("", nth=1)
            # An open while her turn runs finds the desktop's row with her words and file, and leaves it alone.
            self.assertEqual(hermes.shown(), [(desktop.row, image_text("", [PHOTO["path"]]), None, None)])
            self.assertIsNone(hermes.bound("alice-1"))
            hermes.finish("", nth=1)
            self.assertEqual(turn.images, [PHOTO["path"]])
            self.assertEqual(hermes.bound("alice-1"), turn.row)
            rows = [row for row in hermes.open()["messages"] if row["role"] == "user"]
            self.assertEqual([(row["row_id"], row.get("app_request_id")) for row in rows], [(desktop.row, None), (turn.row, "alice-1")])
            self.assertEqual((rows[1]["app_attachments"], rows[1]["app_display_text"]), ([PHOTO], ""))

    def test_a_queued_image_send_stays_unbound_beside_an_older_row_with_its_words_and_file(self):
        with TurnHermes(busy="queued") as hermes:
            # A native client's "Look" with the shared photo ran a moment ago.
            hermes.session["attached_images"].append(PHOTO["path"])
            hermes.other_client("Look")
            native = hermes.finish("Look")
            # Alice sends the same words and file; the desktop's next turn takes the session first, so Hermes
            # queues hers. That turn took the session's images before the add-on attached her photo.
            hermes.races.append(lambda: (hermes.other_client("Book the dentist"), hermes.snapshotted("Book the dentist")))
            self.assertEqual(hermes.send("alice-1", "Look", attachments=[PHOTO])["status"], "accepted")
            self.assertEqual(hermes.shown()[0], (native.row, image_text("Look", [PHOTO["path"]]), None, None))
            bob = hermes.finish("Book the dentist")
            alice = hermes.finish("Look", nth=1)
            self.assertEqual(alice.images, [PHOTO["path"]])
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(native.row, image_text("Look", [PHOTO["path"]]), None, None), (bob.row, "Book the dentist", None, None),
                                              (alice.row, image_text("Look", [PHOTO["path"]]), None, None)])

    def test_a_native_turn_admitted_between_a_members_photo_and_her_prompt_gets_neither_her_receipt_nor_her_name(self):
        # Known defect, upstream at every qualified revision and on main: nothing spans the add-on's image.attach and the
        # image snapshot of the turn it means to start, so a native client's turn admitted between them can run with
        # Alice's photo (docs/HermesCapabilityMatrix.md). Which turn ran the photo is not asserted; this is what the
        # add-on still guarantees.
        with TurnHermes(busy="queued") as hermes:
            # After her photo is attached, the desktop's prompt takes the session and its turn takes the session's images.
            hermes.submit_races.append(lambda: (hermes.other_client("Book the dentist"), hermes.snapshotted("Book the dentist")))
            self.assertEqual(hermes.send("alice-1", "Look", attachments=[PHOTO])["status"], "accepted")
            bob = hermes.finish("Book the dentist")
            alice = hermes.finish("Look")
            self.assertNotEqual(hermes.bound("alice-1"), bob.row)
            shown = {row_id: (request_id, sender) for row_id, _, request_id, sender in hermes.shown()}
            self.assertEqual(set(shown), {bob.row, alice.row})
            self.assertEqual(shown[bob.row], (None, None))
            self.assertIn(shown[alice.row], [(None, None), ("alice-1", "alice")])
            receipt_answer = hermes.methods["agent-interface.receipt"]("lookup", {"request_id": "alice-1"})["result"]["receipt"]
            self.assertNotEqual(receipt_answer["userRowId"], bob.row)

    def test_a_steer_consumed_in_place_is_bound_to_the_only_row_in_its_turn_with_its_words(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            turn = hermes.turn("Plan the trip")
            answer = hermes.send("kim-1", "Avoid flights", sender="kim")
            self.assertTrue(answer["steering"])
            # Before the turn reports its rows, nothing places the steer.
            self.assertIsNone(hermes.bound("kim-1"))
            hermes.finish("Plan the trip")
            self.assertEqual(hermes.shown(), [(turn.row, "Plan the trip", "alice-1", "alice"), (hermes.row_of("Avoid flights"), "Avoid flights", "kim-1", "kim")])

    def test_a_steer_stays_unbound_when_its_roots_turn_reports_no_rows(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            hermes.turn("Plan the trip").report_rows = False
            hermes.send("kim-1", "Avoid flights", sender="kim")
            hermes.finish("Plan the trip")
            self.assertIsNone(hermes.bound("kim-1"))
            self.assertEqual(hermes.shown()[-1], (hermes.row_of("Avoid flights"), "Avoid flights", None, None))

    def test_two_members_steers_hermes_joined_into_one_row_bind_to_neither(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            turn = hermes.turn("Plan the trip")
            self.assertTrue(hermes.send("kim-1", "Avoid flights", sender="kim")["steering"])
            self.assertTrue(hermes.send("bob-1", "Use trains", sender="bob")["steering"])
            hermes.finish("Plan the trip")
            joined = hermes.row_of("Avoid flights\nUse trains")
            self.assertEqual(hermes.shown(), [(turn.row, "Plan the trip", "alice-1", "alice"), (joined, "Avoid flights\nUse trains", None, None)])
            self.assertEqual((hermes.bound("kim-1"), hermes.bound("bob-1")), (None, None))

    def test_a_turn_binds_the_steer_it_delivered_alone_and_not_the_one_it_handed_to_the_next_turn(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            turn = hermes.turn("Plan the trip")
            hermes.send("kim-1", "Use trains", sender="kim")
            hermes.tool_batch(turn)
            # Bob's steer arrives after the turn's last tool batch; Hermes runs it as the next prompt.
            turn.consume_steers = False
            hermes.send("bob-1", "Avoid flights", sender="bob")
            hermes.finish("Plan the trip")
            followup = hermes.finish("Avoid flights")
            self.assertEqual(followup.rid, turn.rid)
            kim = hermes.row_of("Use trains")
            self.assertEqual(hermes.shown(), [(turn.row, "Plan the trip", "alice-1", "alice"), (kim, "Use trains", "kim-1", "kim"),
                                              (followup.row, "Avoid flights", None, None)])
            self.assertEqual((hermes.bound("kim-1"), hermes.bound("bob-1")), (kim, None))

    def test_a_steer_beside_another_clients_correction_with_the_same_words_stays_unbound(self):
        with TurnHermes(busy="redirected") as hermes:
            hermes.send("alice-1", "Plan the trip")
            turn = hermes.turn("Plan the trip")
            # A native client redirects "Same words" into Alice's turn and a tool batch delivers it; then Kim
            # steers the same words from the app, and the turn's last batch delivers hers as a row of its own.
            self.assertEqual(hermes.other_client("Same words")["result"]["status"], "redirected")
            hermes.tool_batch(turn)
            self.assertTrue(hermes.send("kim-1", "Same words", sender="kim")["steering"])
            hermes.finish("Plan the trip")
            native, kim = hermes.rows_of("Same words")
            self.assertIsNone(hermes.bound("kim-1"))
            self.assertEqual(hermes.shown(), [(turn.row, "Plan the trip", "alice-1", "alice"), (native, "Same words", None, None), (kim, "Same words", None, None)])

    def test_guidance_that_runs_as_its_own_turn_stays_unattributed(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "Plan the trip")
            first = hermes.turn("Plan the trip")
            first.consume_steers = False
            hermes.send("kim-1", "Avoid flights", sender="kim")
            hermes.finish("Plan the trip")
            guidance = hermes.finish("Avoid flights")
            self.assertEqual(guidance.rid, first.rid)
            # Leftover steering runs as a new prompt, outside the rows Alice's turn reported.
            self.assertEqual((hermes.bound("alice-1"), hermes.bound("kim-1")), (first.row, None))
            self.assertEqual(hermes.shown(), [(first.row, "Plan the trip", "alice-1", "alice"), (guidance.row, "Avoid flights", None, None)])

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
        with TurnHermes() as hermes:
            hermes.send("alice-1", "", attachments=[PHOTO])
            first = hermes.turn("")
            # Her turn reports no prompt row, so her receipt is still unbound when Hermes continues
            # toward the goal under her request ID, on her turn's thread.
            first.goal, first.report_row = "Continue toward the goal", False
            first.release.set()
            goal = hermes.finish("Continue toward the goal")
            self.assertEqual(goal.rid, first.rid)
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(first.row, image_text("", [PHOTO["path"]]), None, None), (goal.row, "Continue toward the goal", None, None)])

    def test_a_continuation_after_a_claimed_turn_failed_never_inherits_its_claim(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "", attachments=[PHOTO])
            first = hermes.turn("")
            # Her turn fails before any completion, so its claim is unused when the continuation
            # starts on the same thread, with a copy of its context.
            first.fails, first.goal = True, "Continue toward the goal"
            first.release.set()
            goal = hermes.finish("Continue toward the goal")
            self.assertEqual(goal.rid, first.rid)
            self.assertIsNone(hermes.bound("alice-1"))
            self.assertEqual(hermes.shown(), [(goal.row, "Continue toward the goal", None, None)])

    def test_a_claim_binds_at_most_once_even_when_its_first_completion_named_no_row(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "", attachments=[PHOTO])
            turn = hermes.turn("")
            # A completion with no committed prompt row, then another in the same context.
            turn.early = [("sid", None)]
            hermes.finish("")
            self.assertIsNone(hermes.bound("alice-1"))

    def test_a_completion_for_another_session_neither_binds_nor_spends_the_claim(self):
        with TurnHermes() as hermes:
            hermes.send("alice-1", "", attachments=[PHOTO])
            turn = hermes.turn("")
            # A child session's turn reports its own row from a thread that copied this turn's context.
            turn.early = [("child", {"user_row_id": 999, "row_ids": [999]})]
            hermes.finish("")
            self.assertEqual(hermes.bound("alice-1"), turn.row)

    def test_only_the_turn_hermes_started_for_the_send_claims_it(self):
        # Each case starts the send's turn under its own request ID with one thing changed. The first changes
        # nothing and binds, so each other case is unbound for its own reason alone.
        cases = [
            ("unchanged", {}, True),
            ("another session", {"sid": "other"}, False),
            ("other words", {"text": "Look"}, False),
            ("a display kind", {"display_kind": "auto_continue"}, False),
            ("a relayed author", {"turn_author": {"id": "bob"}}, False),
        ]
        for name, start_as, binds in cases:
            with self.subTest(name), TurnHermes() as hermes:
                hermes.start_as = start_as
                hermes.send("alice-1", "", attachments=[PHOTO])
                turn = hermes.finish(start_as.get("text", ""))
                self.assertEqual(hermes.bound("alice-1"), turn.row if binds else None)

    def test_a_send_drained_under_an_app_turns_request_id_never_takes_its_receipt(self):
        with TurnHermes(busy="queued") as hermes:
            hermes.send("alice-1", "", attachments=[PHOTO])
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
            self.assertEqual(hermes.shown(), [(first.row, image_text("", [PHOTO["path"]]), None, None), (desktop.row, image_text("", ["/desktop/scan.png"]), None, None)])

    def test_a_new_task_hermes_queued_or_joined_says_so_and_is_bound_to_no_row(self):
        # Hermes queues an image send whatever its busy mode, and binds it to no row either.
        for busy, turn, attachments in (("queued", "queued", []), ("redirected", "joined", []), ("redirected", "queued", [PHOTO])):
            with self.subTest(busy=busy, images=bool(attachments)), TurnHermes(busy=busy) as hermes:
                hermes.races.append(lambda hermes=hermes: hermes.other_client("Book the dentist"))
                answer = hermes.send("alice-1", "Make it Tuesday", attachments=attachments)
                self.assertEqual((answer["status"], answer["steering"], answer["turn"], answer["userRowId"]), ("accepted", False, turn, None))
                hermes.finish("Book the dentist")
                if turn == "queued":
                    hermes.finish("Make it Tuesday")
                self.assertIsNone(hermes.bound("alice-1"))
                self.assertEqual([request for _, _, request, _ in hermes.shown()], [None, None])

    def test_a_typed_stop_takes_back_its_photo_and_leaves_one_staged_before_it(self):
        # Hermes answers the stop before it reads the session, so the photo staged for it would wait for the next turn.
        for before in ([], ["/uploads/desktop/chart.png"]):
            with self.subTest(staged_before=before), TurnHermes() as hermes:
                hermes.session["attached_images"].extend(before)
                hermes.voice = True
                stop = hermes.send("alice-stop", "stop", attachments=[PHOTO])
                self.assertEqual((stop["status"], stop["turn"]), ("accepted", "none"))
                self.assertEqual(hermes.journal.db.execute("SELECT terminal FROM receipts WHERE request_id='alice-stop'").fetchone(), (1,))
                self.assertEqual(hermes.session["attached_images"], before)
                # Her next send is text only; its turn takes what was staged before the stop, never the stop's photo.
                self.assertEqual(hermes.send("alice-time", "What time is it?")["status"], "accepted")
                self.assertEqual(hermes.finish("What time is it?").images, before)

    def test_a_send_takes_back_only_its_own_photo_when_another_client_attaches_during_its_attach(self):
        # The desktop attaches an image while native reads Alice's photo's header, after appending it. Alice's send then
        # takes back what it staged: after a typed stop, or when her attach fails after its append. When it fails before
        # appending, it staged nothing, and the same photo the desktop staged earlier is the desktop's.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        os.mkdir(os.path.join(directory.name, "real"))
        os.symlink("real", os.path.join(directory.name, "linked"))
        scan, linked = "/uploads/desktop/scan.png", {**PHOTO, "path": os.path.join(directory.name, "linked", "photo.png")}
        # (case, how Alice's attach fails, staged before her send, what the desktop attaches meanwhile, her photo)
        cases = (("answered", None, [], scan, PHOTO),
                 ("fails after its append", "after", [], scan, PHOTO),
                 ("fails before its append, the same photo staged before", "before", [PHOTO["path"]], scan, PHOTO),
                 ("the desktop attaches the same photo", None, [], PHOTO["path"], PHOTO),
                 ("fails after appending a path native resolved", "after", [], scan, linked))
        for name, fail, before, other, photo in cases:
            with self.subTest(name), TurnHermes() as hermes:
                hermes.session["attached_images"].extend(before)
                hermes.voice = True
                appended, resume = hermes.pause_attach(fail)
                self.addCleanup(resume.set)
                answers = []
                sender = threading.Thread(target=lambda hermes=hermes, photo=photo, answers=answers:
                                          answers.append(hermes.send("alice-stop", "stop", attachments=[photo])))
                sender.start()
                self.assertTrue(appended.wait(5))
                self.assertEqual(hermes.other_attach(other)["path"], other)
                resume.set()
                sender.join(5)
                [answer] = answers
                self.assertEqual(answer["status"], "rejected" if fail else "accepted")
                self.assertEqual(hermes.session["attached_images"], [*before, other])
                # The desktop's next turn runs with what it staged, and Alice's photo is in no turn.
                hermes.voice = False
                hermes.other_client("What is on this?")
                self.assertEqual(hermes.finish("What is on this?").images, [*before, other])

    def test_a_typed_stop_taking_back_its_photo_keeps_one_another_client_attaches_meanwhile(self):
        # Native image.attach appends without history_lock, so the desktop's attach can land while Alice's cleanup runs.
        # The session pauses the cleanup's thread just before its first write to the session's images, whether the
        # cleanup replaces the list or removes from it.
        scan = "/uploads/desktop/scan.png"
        with TurnHermes() as hermes:
            hermes.voice = True
            writing, resume, answers = threading.Event(), threading.Event(), []
            sender = threading.Thread(target=lambda: answers.append(hermes.send("alice-stop", "stop", attachments=[PHOTO])))
            def write(sender=sender):
                if threading.current_thread() is sender and not writing.is_set():
                    writing.set()
                    if not resume.wait(5):
                        raise AssertionError("The test never resumed the cleanup")
            hermes.server._sessions["sid"] = WatchedSession(hermes.session, write)
            self.addCleanup(resume.set)
            sender.start()
            self.assertTrue(writing.wait(5))
            self.assertEqual(hermes.session["attached_images"], [PHOTO["path"]])
            # The cleanup holds history_lock, so no turn Hermes admits meanwhile can snapshot the photo it is removing.
            lock = hermes.session["history_lock"]
            held_elsewhere = not lock.acquire(blocking=False)
            if not held_elsewhere:
                lock.release()
            self.assertTrue(held_elsewhere)
            hermes.other_attach(scan)
            resume.set()
            sender.join(5)
            self.assertEqual([answer["turn"] for answer in answers], ["none"])
            self.assertEqual(hermes.session["attached_images"], [scan])
            hermes.voice = False
            hermes.other_client("What is on this?")
            self.assertEqual(hermes.finish("What is on this?").images, [scan])

    def test_an_answer_the_add_on_does_not_know_leaves_its_photo_for_the_turn_it_may_have_started(self):
        with TurnHermes() as hermes:
            # Hermes started the turn and answered in a shape this add-on does not know. Its turn's thread takes the
            # session's images after the answer, as native's does (methods_prompt.py:965-973 at ed1afb0, :695-702 at
            # b9cb268 and d23cc6b).
            hermes.reply_as, hermes.hold_admission = {"status": "started"}, threading.Event()
            admission = hermes.hold_admission
            self.assertEqual(hermes.send("alice-1", "Look", attachments=[PHOTO])["turn"], "unknown")
            admission.set()
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"]])

    def test_unbound_sends_and_steers_still_let_opens_reuse_decorated_history(self):
        with StoredRows(turns(2)) as hermes:
            hermes.open()
            session = hermes.server._sessions["sid"]
            session.update(history=hermes.messages, history_lock=threading.Lock(), profile_home=hermes.directory.name)
            # A read of the same rows and journal binds nothing new, whatever is still unbound.
            with hermes.journal.db:
                receipt(hermes.journal.db, "alice-1", 1, 1, text="prompt 0", actor="alice")
                hermes.journal.db.execute("UPDATE receipts SET turn_rows='[1, 2]' WHERE request_id='alice-1'")
                receipt(hermes.journal.db, "kim-1", None, 2, run_id="alice-1", text="Avoid flights", steering=1, actor="kim")
                receipt(hermes.journal.db, "bob-1", None, 3, text="", attachments=[PHOTO], actor="bob")
            hermes.open()
            hermes.open()
            self.assertIs(hermes.native_calls[-1][1].get("omit_messages"), True)


class SteeringRuleTests(unittest.TestCase):
    """A steer is bound only to the one row of its root's finished turn that can be its own."""

    MESSAGES = [{"row_id": 10, "role": "user", "text": "Plan the trip", "timestamp": 1},
                {"row_id": 11, "role": "assistant", "text": "Looking", "timestamp": 2},
                {"row_id": 12, "role": "user", "text": "Avoid flights", "timestamp": 3},
                {"row_id": 13, "role": "assistant", "text": "Planned", "timestamp": 4},
                {"row_id": 14, "role": "user", "text": "Avoid flights", "timestamp": 5}]

    def test_a_steer_binds_only_when_one_row_of_its_finished_turn_can_be_its_own(self):
        # (case, root's reported turn rows, other receipts, when the steer was sent, row the steer is bound to).
        # Row 14 is the next turn's first row, outside the root's turn. Row 12 was saved at time 3.
        cases = [
            ("one row in the turn", "[10, 11, 12, 13]", [], 2, 12),
            ("the turn has not finished", None, [], 2, None),
            ("two rows in the turn", "[10, 11, 12, 13, 14]", [], 2, None),
            ("only a row after the turn", "[10, 11, 13]", [], 2, None),
            ("another unbound steer with the words", "[10, 11, 12, 13]", [("bob-1", None, "Avoid flights", 1)], 2, None),
            ("another bound steer with the words", "[10, 11, 12, 13]", [("bob-1", 99, "Avoid flights", 1)], 2, None),
            ("the row held by another receipt", "[10, 11, 12, 13]", [("bob-2", 12, "Something else", 0)], 2, None),
            # A row saved before the steer was sent is someone else's words. One second covers the gap between
            # the add-on's clock at the receipt and Hermes's at the row.
            ("the row saved a second before the steer was sent", "[10, 11, 12, 13]", [], 4, 12),
            ("the row saved more than a second before the steer was sent", "[10, 11, 12, 13]", [], 4.5, None),
        ]
        for name, extent, others, sent, expected in cases:
            with self.subTest(name), StoredRows(copy.deepcopy(self.MESSAGES)) as hermes:
                db = hermes.journal.db
                with db:
                    receipt(db, "alice-1", 10, 1, text="Plan the trip", actor="alice")
                    db.execute("UPDATE receipts SET turn_rows=? WHERE request_id='alice-1'", (extent,))
                    receipt(db, "kim-1", None, sent, run_id="alice-1", text="Avoid flights", steering=1, actor="kim")
                    for request_id, row, text, steering in others:
                        receipt(db, request_id, row, 3, run_id="alice-1" if steering else None, text=text, steering=steering, actor="bob")
                shown = {row["row_id"]: row.get("app_request_id") for row in hermes.open()["messages"] if row["role"] == "user"}
                self.assertEqual(hermes.bound("kim-1"), expected)
                self.assertEqual(shown[12] == "kim-1", expected == 12)

    def test_a_rows_time_is_read_as_main_reads_it_and_one_it_cannot_read_binds_nothing(self):
        # main reads the row's time with float(), and a missing or zero one as now. The steer is sent at
        # time 103, so a row saved at 100 is refused and one saved now is not. A time that cannot be read
        # or compared leaves the steer unbound, and the open still answers.
        cases = [
            ("missing, read as now", None, 12),
            ("zero, read as now", 0, 12),
            ("a number as text, read as that number", "100", None),
            ("a number as text inside the second", "102.5", 12),
            ("words", "soon", None),
            ("not a number", float("nan"), None),
            ("infinite", float("inf"), None),
            ("too large for a float", 10**400, None),
            ("a list", [100], None),
        ]
        for name, stamp, expected in cases:
            messages = copy.deepcopy(self.MESSAGES)
            if stamp is None:
                del messages[2]["timestamp"]
            else:
                messages[2]["timestamp"] = stamp
            with self.subTest(name), StoredRows(messages) as hermes:
                db = hermes.journal.db
                with db:
                    receipt(db, "alice-1", 10, 1, text="Plan the trip", actor="alice")
                    db.execute("UPDATE receipts SET turn_rows='[10, 11, 12, 13]' WHERE request_id='alice-1'")
                    receipt(db, "kim-1", None, 103, run_id="alice-1", text="Avoid flights", steering=1, actor="kim")
                hermes.open()
                self.assertEqual(hermes.bound("kim-1"), expected)


class StoredTurnRowsTests(unittest.TestCase):
    def test_a_damaged_stored_turn_leaves_the_steer_unbound_and_the_open_answers(self):
        # The first value is well formed and binds the steer, so each other case is unbound for its own reason.
        cases = [
            ("well formed", "[10, 11, 12, 13]", 12),
            ("a dict element", "[10, 11, 12, {}]", None),
            ("a string element", '[10, 11, 12, "13"]', None),
            ("a boolean element", "[10, 11, 12, true]", None),
            ("a zero element", "[10, 11, 12, 0]", None),
            ("not a list", "12", None),
            ("not JSON", "[10, 11, 12", None),
        ]
        for name, extent, expected in cases:
            with self.subTest(name), StoredRows(copy.deepcopy(SteeringRuleTests.MESSAGES)) as hermes:
                db = hermes.journal.db
                with db:
                    receipt(db, "alice-1", 10, 1, text="Plan the trip", actor="alice")
                    db.execute("UPDATE receipts SET turn_rows=? WHERE request_id='alice-1'", (extent,))
                    receipt(db, "kim-1", None, 2, run_id="alice-1", text="Avoid flights", steering=1, actor="kim")
                shown = {row["row_id"]: row.get("app_request_id") for row in hermes.open()["messages"] if row["role"] == "user"}
                self.assertEqual((hermes.bound("kim-1"), shown[12]), (expected, "kim-1" if expected else None))


class StoredBindingTests(unittest.TestCase):
    def test_a_stored_binding_is_shown_however_hermes_changed_the_rows_words(self):
        # Hermes sanitized leaked bracketed-paste markers out of the row (hermes_cli/input_sanitize.py:50-54);
        # the old completion hook bound it with no row in the saved answer.
        messages = [{"row_id": 10, "role": "user", "text": "Plan the trip", "timestamp": 1}]
        with StoredRows(messages) as hermes:
            with hermes.journal.db:
                receipt(hermes.journal.db, "alice-1", 10, 1, text="\x1b[200~Plan the trip\x1b[201~", actor="alice")
            [row] = hermes.open()["messages"]
            self.assertEqual((row.get("app_request_id"), row.get("app_sender_id")), ("alice-1", "alice"))


if __name__ == "__main__":
    unittest.main()
