"""The one SSH option set the local release tools use to reach the Hermes host."""
import subprocess
import sys
import unittest
from unittest.mock import patch

from support import ROOT

sys.path.insert(0, str(ROOT / ".agents/tools"))
import host_access  # noqa: E402

UNATTENDED = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"]


class HostAccessTests(unittest.TestCase):
    def call(self, function, *args, **kwargs):
        with patch.object(host_access.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            function(*args, **kwargs)
        run.assert_called_once()
        return run.call_args

    def test_ssh_never_prompts_and_passes_the_command_words_input_and_timeout(self):
        call = self.call(host_access.ssh, "home-hermes-vps", ["python3", "-"], input="print(1)", timeout=900, check=False, capture=True)
        self.assertEqual(call.args[0], ["ssh", *UNATTENDED, "home-hermes-vps", "python3", "-"])
        self.assertEqual(call.kwargs, dict(input="print(1)", timeout=900, check=False, capture_output=True, text=True))

    def test_a_shell_string_stays_one_remote_argument_and_failures_raise_by_default(self):
        call = self.call(host_access.ssh, "deploy@host", "umask 077 && mkdir '/a b'", timeout=60)
        self.assertEqual(call.args[0][-2:], ["deploy@host", "umask 077 && mkdir '/a b'"])
        self.assertEqual((call.kwargs["check"], call.kwargs["capture_output"], call.kwargs["input"]), (True, False, None))

    def test_scp_uses_the_same_options_before_its_paths(self):
        call = self.call(host_access.scp, "host:/stage/evidence/.", "/local/raw", recursive=True, timeout=600)
        self.assertEqual(call.args[0], ["scp", "-q", *UNATTENDED, "-r", "host:/stage/evidence/.", "/local/raw"])
        self.assertEqual((call.kwargs["timeout"], call.kwargs["check"]), (600, True))
        self.assertNotIn("-r", self.call(host_access.scp, "/local/release.tar.gz", "host:/ops/release.tar.gz", timeout=900).args[0])

    def test_an_option_shaped_host_or_path_is_refused_before_running(self):
        with patch.object(host_access.subprocess, "run") as run:
            for call in (lambda: host_access.ssh("-oProxyCommand=evil", "true", timeout=5),
                         lambda: host_access.ssh("", "true", timeout=5),
                         lambda: host_access.scp("-r", "host:/x", timeout=5),
                         lambda: host_access.scp("/local", "-oProxyCommand=evil:/x", timeout=5)):
                with self.assertRaises(ValueError):
                    call()
        run.assert_not_called()

    def test_every_call_names_its_timeout(self):
        with self.assertRaises(TypeError):
            host_access.ssh("host", "true")
        with self.assertRaises(TypeError):
            host_access.scp("/a", "host:/b")


if __name__ == "__main__":
    unittest.main()
