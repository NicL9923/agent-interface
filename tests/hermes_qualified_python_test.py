"""The qualified Python helper reads native PM membership across Hermes revisions."""
import types
import unittest

from support import load_source

helper = load_source("scripts/hermes-qualified-python.py")


class MembershipTests(unittest.TestCase):
    def test_current_hermes_names_it_installs_packages(self):
        self.assertTrue(helper.installs_into_environment(types.SimpleNamespace(installs_packages=True)))
        # A pyproject that installs nothing stays out of the workspace on current Hermes.
        self.assertFalse(helper.installs_into_environment(types.SimpleNamespace(installs_packages=False, is_member=True)))

    def test_older_hermes_names_it_is_member(self):
        self.assertTrue(helper.installs_into_environment(types.SimpleNamespace(is_member=True)))
        self.assertFalse(helper.installs_into_environment(types.SimpleNamespace(is_member=False)))


if __name__ == "__main__":
    unittest.main()
