"""A member's photo is staged on the session Hermes shares with every client, so another client's turn can take it.

Hermes is the fake of ``tests/hermes_turn_binding_test.py``, modeled on upstream at ``ed1afb0``: ``image.attach``
appends to the session's ``attached_images`` without a lock (``methods_prompt.py:1011``), a turn takes and clears the
list when it is admitted (``prompt_turn.py:150-152``), and a prompt that finds the session running claims the list
for its queue entry (``session_auto_continue.py:418-439``). Nothing the add-on can hold spans the attach and the turn
that is meant to take it, so these tests are what it does about a photo it finds gone: refuse before sending when it
can, say so in the receipt when the turn runs or queues without it, and never leave a photo staged for a turn that
is not the send's. The bridge, the journal and every add-on wrapper are the real code.
"""
import json
import threading
import unittest

from hermes_extension_journal_test import FakeGateway, receipt as insert_receipt
from hermes_turn_binding_test import PHOTO, TurnHermes

SECOND = {**PHOTO, "path": "/uploads/shared/second.png", "name": "second.png"}


def lookup(hermes, request_id):
    return hermes.methods["agent-interface.receipt"]("lookup", {"request_id": request_id})["result"]["receipt"]


def calls(hermes, *methods):
    return [(method, params.get("text")) for method, _, params in hermes.calls if method in methods]


class PhotoTakenBeforeThePromptTests(unittest.TestCase):
    def send_while_the_desktop_takes_the_photo(self, hermes, photos):
        """Alice's send, whose first attach waits after it appended while the desktop's turn takes the session's images.

        Returns Alice's answer and the images the desktop's turn took.
        """
        appended, resume = hermes.pause_attach()
        self.addCleanup(resume.set)
        answers = []
        sender = threading.Thread(target=lambda: answers.append(hermes.send("alice-1", "Look", attachments=photos)))
        sender.start()
        self.assertTrue(appended.wait(5))
        hermes.other_client("Book the dentist")
        taken = hermes.snapshotted("Book the dentist")
        resume.set()
        sender.join(5)
        [answer] = answers
        return answer, taken

    def test_a_photo_another_turn_took_while_it_attached_stops_the_send_before_its_prompt_is_sent(self):
        with TurnHermes() as hermes:
            answer, taken = self.send_while_the_desktop_takes_the_photo(hermes, [PHOTO])
            self.assertEqual(taken, [PHOTO["path"]])
            self.assertEqual(answer["status"], "rejected")
            self.assertEqual(answer["message"], "Another task took your photo before this message was sent. Nothing was sent. Keep this draft and send it again.")
            # Hermes was never sent Alice's words (the desktop's prompt reached it directly), and her receipt is settled as refused.
            self.assertEqual(calls(hermes, "prompt.submit"), [])
            self.assertEqual(lookup(hermes, "alice-1")["status"], "rejected")
            self.assertEqual(hermes.journal.db.execute("SELECT terminal FROM receipts WHERE request_id='alice-1'").fetchone(), (1,))
            # No turn will start under the request ID it registered, so nothing waits to claim it.
            self.assertEqual(hermes.bridge.turn_requests, {})
            # Her draft sent again, once the desktop's turn ends, runs with the photo.
            hermes.finish("Book the dentist")
            self.assertEqual(hermes.send("alice-2", "Look", attachments=[PHOTO])["status"], "accepted")
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"]])

    def test_a_send_with_two_photos_takes_back_the_one_still_staged_when_the_other_was_taken(self):
        with TurnHermes() as hermes:
            answer, taken = self.send_while_the_desktop_takes_the_photo(hermes, [PHOTO, SECOND])
            self.assertEqual((answer["status"], taken), ("rejected", [PHOTO["path"]]))
            # The second photo was attached after the desktop's turn took the first, and would run in the turn after it.
            self.assertEqual(hermes.session["attached_images"], [])
            hermes.finish("Book the dentist")
            hermes.other_client("What time is it?")
            self.assertEqual(hermes.finish("What time is it?").images, [])

    def test_a_photo_attached_twice_is_counted_twice(self):
        with TurnHermes() as hermes:
            # The desktop's turn takes the first copy while the second is attached, so one of the two entries is gone.
            answer, taken = self.send_while_the_desktop_takes_the_photo(hermes, [PHOTO, PHOTO])
            self.assertEqual((answer["status"], taken), ("rejected", [PHOTO["path"]]))
            self.assertEqual(hermes.session["attached_images"], [])

    def test_a_send_whose_photos_are_all_staged_calls_hermes_right_after_its_last_attach(self):
        with TurnHermes() as hermes:
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO, SECOND])
            self.assertEqual((answer["status"], answer["turn"]), ("accepted", "started"))
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"], SECOND["path"]])
            # Nothing of the add-on's own is between the last attach and Hermes's admission call.
            natives = [method for method, _, _ in hermes.calls if method in ("image.attach", "prompt.submit")]
            self.assertEqual(natives, ["image.attach", "image.attach", "prompt.submit"])
            self.assertNotIn("imagesMissing", lookup(hermes, "alice-1"))

    def test_a_text_only_send_is_never_stopped_by_a_photo_it_does_not_have(self):
        with TurnHermes() as hermes:
            # Another client's staged photo is not this send's to check.
            hermes.session["attached_images"].append("/uploads/desktop/scan.png")
            self.assertEqual(hermes.send("alice-1", "What time is it?")["status"], "accepted")
            self.assertEqual(hermes.finish("What time is it?").images, ["/uploads/desktop/scan.png"])


class TurnStartedWithoutThePhotoTests(unittest.TestCase):
    def test_a_turn_that_starts_without_its_photo_says_so_in_the_receipt_and_in_every_replay(self):
        with TurnHermes(busy="queued") as hermes:
            # Hermes marked the session running and answered; the turn's thread has not taken the images yet.
            hermes.hold_admission = admission = threading.Event()
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual((answer["status"], answer["turn"]), ("accepted", "started"))
            self.assertNotIn("imagesMissing", answer)
            # A prompt that finds the session running claims the staged photos for its own queue entry.
            hermes.other_client("Book the dentist")
            self.assertEqual(hermes.session["queued_prompt"]["image_paths"], [PHOTO["path"]])
            admission.set()
            self.assertEqual(hermes.finish("Look").images, [])
            saved = lookup(hermes, "alice-1")
            self.assertEqual((saved["status"], saved["imagesMissing"]), ("accepted", 1))
            self.assertEqual(saved["message"], "Your photo was not sent with this message: another task took them first. Check the reply and send them again.")
            # The answer the add-on saved says the same to a caller who sends the request again.
            replay = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual((replay["imagesMissing"], replay["message"]), (1, saved["message"]))

    def test_a_turn_that_starts_with_its_photos_says_nothing(self):
        with TurnHermes() as hermes:
            hermes.hold_admission = admission = threading.Event()
            hermes.send("alice-1", "Look", attachments=[PHOTO, SECOND])
            # Another client's photo staged meanwhile does not hide that the send's own are there.
            hermes.other_attach("/uploads/desktop/scan.png")
            admission.set()
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"], SECOND["path"], "/uploads/desktop/scan.png"])
            self.assertNotIn("imagesMissing", lookup(hermes, "alice-1"))

    def test_every_photo_gone_is_counted_and_the_receipt_says_so_in_the_plural(self):
        with TurnHermes() as hermes:
            hermes.hold_admission = admission = threading.Event()
            hermes.send("alice-1", "Look", attachments=[PHOTO, SECOND])
            hermes.other_client("Book the dentist")
            admission.set()
            self.assertEqual(hermes.finish("Look").images, [])
            saved = lookup(hermes, "alice-1")
            self.assertEqual(saved["imagesMissing"], 2)
            self.assertEqual(saved["message"], "2 of your photos were not sent with this message: another task took them first. Check the reply and send them again.")

    def test_only_the_photos_gone_are_counted(self):
        with TurnHermes() as hermes:
            hermes.hold_admission = admission = threading.Event()
            hermes.send("alice-1", "Look", attachments=[PHOTO, SECOND])
            # Another client detaches one of them.
            hermes.session["attached_images"].remove(SECOND["path"])
            admission.set()
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"]])
            self.assertEqual(lookup(hermes, "alice-1")["imagesMissing"], 1)

    def test_checking_the_photos_never_stops_the_turn(self):
        class Fragile(list):
            """The session's list, which cannot be read the first time once ``broken`` is set."""
            broken = False

            def __iter__(self):
                if self.broken:
                    self.broken = False
                    raise RuntimeError("Synthetic failure reading the session's images")
                return super().__iter__()

        with TurnHermes() as hermes:
            hermes.hold_admission = admission = threading.Event()
            hermes.send("alice-1", "Look", attachments=[PHOTO])
            hermes.session["attached_images"] = fragile = Fragile(hermes.session["attached_images"])
            fragile.broken = True
            with self.assertLogs(level="ERROR") as logged:
                admission.set()
                # The check fails as the turn starts, and the turn runs with the photo anyway.
                self.assertEqual(hermes.finish("Look").images, [PHOTO["path"]])
            self.assertIn("Checking a send's photos at its turn's start failed", logged.output[0])
            self.assertNotIn("imagesMissing", lookup(hermes, "alice-1"))


class PromptAnsweredWhileATurnRunsTests(unittest.TestCase):
    def take_the_photo_during_submit(self, hermes):
        # After Alice's photo is attached, the desktop's prompt takes the session and its turn takes the session's images.
        hermes.submit_races.append(lambda: (hermes.other_client("Book the dentist"), hermes.snapshotted("Book the dentist")))

    def test_a_prompt_hermes_queued_without_its_photo_says_so(self):
        with TurnHermes(busy="queued") as hermes:
            self.take_the_photo_during_submit(hermes)
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual((answer["status"], answer["turn"], answer["imagesMissing"]), ("accepted", "queued", 1))
            self.assertEqual(lookup(hermes, "alice-1")["imagesMissing"], 1)
            hermes.finish("Book the dentist")
            self.assertEqual(hermes.finish("Look").images, [])

    def test_a_prompt_hermes_queued_with_its_photo_says_nothing(self):
        with TurnHermes(busy="queued") as hermes:
            # The desktop's turn took the session's images before Alice's photo was attached.
            hermes.races.append(lambda: (hermes.other_client("Book the dentist"), hermes.snapshotted("Book the dentist")))
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO, SECOND])
            self.assertEqual((answer["status"], answer["turn"]), ("accepted", "queued"))
            self.assertNotIn("imagesMissing", answer)
            hermes.finish("Book the dentist")
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"], SECOND["path"]])
            self.assertNotIn("imagesMissing", lookup(hermes, "alice-1"))

    def test_a_prompt_hermes_queued_with_one_of_two_photos_counts_the_other(self):
        with TurnHermes(busy="queued") as hermes:
            # The desktop's turn is admitted but has not taken the images when another client detaches the second photo.
            hermes.hold_admission = admission = threading.Event()
            hermes.submit_races.append(lambda: (hermes.other_client("Book the dentist"), hermes.session["attached_images"].remove(SECOND["path"])))
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO, SECOND])
            self.assertEqual((answer["turn"], answer["imagesMissing"]), ("queued", 1))
            self.assertEqual(hermes.session["queued_prompt"]["image_paths"], [PHOTO["path"]])
            admission.set()
            hermes.finish("Book the dentist")
            self.assertEqual(hermes.finish("Look").images, [PHOTO["path"]])

    def test_a_prompt_hermes_put_into_the_running_turn_leaves_its_photo_behind_and_takes_it_back(self):
        with TurnHermes(busy="redirected") as hermes:
            self.take_the_photo_during_submit(hermes)
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual((answer["status"], answer["turn"], answer["imagesMissing"]), ("accepted", "joined", 1))
            self.assertEqual(hermes.session["attached_images"], [])

    def test_a_photo_still_staged_when_hermes_says_its_prompt_joined_a_turn_is_taken_back(self):
        with TurnHermes() as hermes:
            # Hermes's answer says the prompt was redirected into a running turn, while a turn it started may still take
            # the images: they must not run in a turn that is not the send's.
            hermes.reply_as, hermes.hold_admission = {"status": "redirected"}, threading.Event()
            admission = hermes.hold_admission
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual((answer["turn"], answer["imagesMissing"]), ("joined", 1))
            self.assertEqual(hermes.session["attached_images"], [])
            admission.set()
            self.assertEqual(hermes.finish("Look").images, [])

    def test_a_queued_prompt_with_no_queue_entry_to_look_in_says_nothing(self):
        with TurnHermes() as hermes:
            # Hermes answers queued and the list no longer holds the photo, but no queue entry exists to say where it went.
            hermes.reply_as, hermes.hold_admission = {"status": "queued"}, threading.Event()
            admission = hermes.hold_admission
            hermes.submit_races.append(hermes.session["attached_images"].clear)
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual(answer["turn"], "queued")
            self.assertNotIn("imagesMissing", answer)
            admission.set()
            hermes.finish("Look")

    def test_a_queued_prompt_whose_photo_is_still_in_the_list_says_nothing(self):
        with TurnHermes() as hermes:
            hermes.reply_as, hermes.hold_admission = {"status": "queued"}, threading.Event()
            admission = hermes.hold_admission
            hermes.session["queued_prompt"] = {"text": "Earlier", "transport": None}
            answer = hermes.send("alice-1", "Look", attachments=[PHOTO])
            self.assertEqual(answer["turn"], "queued")
            self.assertNotIn("imagesMissing", answer)
            admission.set()
            hermes.finish("Look")


class ImagesMissingReceiptTests(unittest.TestCase):
    def journal_with_a_send(self, saved=False):
        hermes = FakeGateway([])
        hermes.__enter__()
        self.addCleanup(hermes.__exit__, None, None, None)
        self.bridge = hermes.bridge
        with hermes.journal.db:
            insert_receipt(hermes.journal.db, "alice-1", 10, 1, actor="alice")
            if saved:
                hermes.journal.db.execute("UPDATE receipts SET admission_response=? WHERE request_id='alice-1'", ('{"requestId": "alice-1", "turn": "started"}',))
        return hermes.journal

    def test_a_count_noted_before_the_answer_is_saved_is_in_the_answer(self):
        journal = self.journal_with_a_send()
        journal.note_images_missing("alice-1", 2)
        self.assertEqual(journal.receipt("alice-1")["imagesMissing"], 2)
        self.assertEqual(journal.images_missing, {"alice-1": 2})
        # Saving the answer carries it, and the add-on no longer keeps the count apart.
        with journal.lock, journal.db:
            answer = self.bridge.admitted(1, "alice-1")["result"]
        self.assertEqual(answer["imagesMissing"], 2)
        self.assertEqual(journal.images_missing, {})
        self.assertEqual(journal.admission_response("alice-1")["imagesMissing"], 2)
        self.assertEqual(journal.receipt("alice-1")["message"], "2 of your photos were not sent with this message: another task took them first. Check the reply and send them again.")

    def test_a_count_noted_after_the_answer_is_saved_amends_it_and_keeps_its_turn(self):
        journal = self.journal_with_a_send(saved=True)
        journal.note_images_missing("alice-1", 1)
        self.assertEqual(journal.admission_response("alice-1")["imagesMissing"], 1)
        value = journal.receipt("alice-1")
        self.assertEqual((value["turn"], value["imagesMissing"]), ("started", 1))
        self.assertEqual(journal.images_missing, {})

    def test_a_count_never_goes_down_and_a_bad_one_or_an_unknown_send_notes_nothing(self):
        journal = self.journal_with_a_send(saved=True)
        journal.note_images_missing("alice-1", 3)
        journal.note_images_missing("alice-1", 1)
        self.assertEqual(journal.receipt("alice-1")["imagesMissing"], 3)
        journal.note_images_missing("nobody", 1)
        self.assertEqual(journal.receipt("alice-1")["imagesMissing"], 3)
        self.assertIsNone(journal.receipt("nobody"))
        self.assertEqual(journal.images_missing, {})

    def test_a_count_of_nothing_notes_nothing(self):
        journal = self.journal_with_a_send()
        for count in (0, -1):
            journal.note_images_missing("alice-1", count)
        self.assertEqual(journal.images_missing, {})
        self.assertNotIn("imagesMissing", journal.receipt("alice-1"))

    def test_a_receipt_with_a_damaged_count_says_nothing_about_photos(self):
        journal = self.journal_with_a_send(saved=True)
        for bad in ("2", 0, -1, None, True):
            with journal.db:
                journal.db.execute("UPDATE receipts SET admission_response=? WHERE request_id='alice-1'", (json.dumps({"requestId": "alice-1", "imagesMissing": bad}),))
            self.assertNotIn("imagesMissing", journal.receipt("alice-1"), bad)


if __name__ == "__main__":
    unittest.main()
