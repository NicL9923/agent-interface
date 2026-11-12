"""Opening a long chat parses each shell command once per process, not once per open.

Hermes labels every shell command in a history each time it projects one. The add-on keeps the answers of
the pure helpers under summarize_shell_command. Hermes's display module is a fake whose summary looks its
helpers up on the module at call time, as Hermes's module globals do, and counts what each helper parsed.
"""
import types
import unittest
from collections import Counter

from hermes_extension_journal_test import FakeHermes, extension


def fake_display():
    """Hermes's agent.display at its edges: four pure helpers and a summary that finds them on the module."""
    display = types.ModuleType("agent.display")
    display.parsed = Counter()

    def split(command):
        display.parsed["split", command] += 1
        return [part.strip() for part in command.split("&&") if part.strip()]

    def clean(segment):
        display.parsed["clean", segment] += 1
        return segment.replace(" 2>&1", "")

    def head(segment):
        display.parsed["head", segment] += 1
        return segment.split()[0]

    def echo(segment):
        display.parsed["echo", segment] += 1
        return segment.startswith("echo ---")

    display._split_shell_compound, display._clean_shell_segment = split, clean
    display._shell_head_word, display._is_shell_boundary_echo = head, echo

    def summarize(command):
        core = [display._clean_shell_segment(segment) for segment in display._split_shell_compound(command)]
        core = [segment for segment in core if display._shell_head_word(segment) != "cd" and not display._is_shell_boundary_echo(segment)]
        return core[0] + (f" +{len(core) - 1}" if len(core) > 1 else "")
    display.summarize_shell_command = summarize
    return display


class InstalledSummaryTest(unittest.TestCase):
    def test_a_repeated_command_is_parsed_once_with_the_same_summary(self):
        display = fake_display()
        hermes = FakeHermes([], bridge=True)
        hermes.modules["agent"].display = display
        command = "cd /srv && npm test 2>&1 && echo --- && git status"
        native = fake_display().summarize_shell_command(command)
        with hermes:
            first = display.summarize_shell_command(command)
            parsed = sum(display.parsed.values())
            second = display.summarize_shell_command(command)
        self.assertEqual((first, second), (native, native))
        self.assertEqual(native, "npm test +1")
        self.assertEqual(sum(display.parsed.values()), parsed)
        self.assertEqual(display.parsed["split", command], 1)

    def test_installing_again_keeps_one_memo(self):
        display = fake_display()
        extension.memoize_shell_summary(display)
        kept = display._clean_shell_segment
        extension.memoize_shell_summary(display)
        self.assertIs(display._clean_shell_segment, kept)
        self.assertIsInstance(kept.native, types.FunctionType)

    def test_a_missing_helper_is_named_and_the_rest_are_kept(self):
        display = fake_display()
        del display._shell_head_word
        with self.assertLogs(extension.__name__, "WARNING") as logs:
            extension.memoize_shell_summary(display)
        self.assertIn("_shell_head_word", logs.output[0])
        self.assertIsInstance(display._clean_shell_segment, extension.TextMemo)
        self.assertFalse(hasattr(display, "_shell_head_word"))


class TextMemoTest(unittest.TestCase):
    def counted(self, answer, budget=1_000):
        calls = Counter()
        def native(text):
            calls[text] += 1
            return answer(text)
        return extension.TextMemo(native, budget), calls

    def test_a_list_answer_is_a_new_list_each_time(self):
        memo, calls = self.counted(lambda text: text.split())
        first = memo("git status")
        first.append("--short")
        self.assertEqual(memo("git status"), ["git", "status"])
        self.assertEqual(calls["git status"], 1)

    def test_the_least_recently_used_answer_leaves_first_within_the_budget(self):
        # Each entry is 10 characters of key and 10 of answer, so eight fit in 160 and a ninth evicts one.
        memo, calls = self.counted(lambda text: text.upper(), budget=160)
        texts = [letter * 10 for letter in "abcdefghi"]
        for text in texts[:8]:
            memo(text)
        memo(texts[0])
        memo(texts[8])
        memo(texts[0])
        memo(texts[1])
        self.assertEqual((calls[texts[0]], calls[texts[1]]), (1, 2))
        self.assertLessEqual(memo.size, 160)

    def test_a_string_too_long_to_keep_and_anything_not_a_string_go_to_the_function_each_time(self):
        memo, calls = self.counted(lambda text: str(text), budget=160)
        for _ in range(2):
            memo("x" * 11)
            memo(None)
            memo("x" * 10)
        self.assertEqual((calls["x" * 11], calls[None], calls["x" * 10]), (2, 2, 1))


if __name__ == "__main__":
    unittest.main()
