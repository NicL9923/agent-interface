"""Real PTY/tmux acceptance; requires tmux on the test host."""
import json
import hashlib
import os
from pathlib import Path
import selectors
import shutil
import shlex
import subprocess
import tempfile
import time
import unittest

HOST = Path(__file__).resolve().parents[1] / "src/server/terminal-host.py"


@unittest.skipUnless(shutil.which("tmux"), "Real terminal acceptance requires tmux")
class SystemTerminalTests(unittest.TestCase):
    def test_shell_reconnect_resize_interrupt_and_private_environment(self):
        with tempfile.TemporaryDirectory(prefix="computer-terminal-") as directory:
            socket = str(Path(directory) / "tmux.sock")
            session = "member-" + "a" * 32
            command = ["python3", str(HOST), "--socket", socket, "--session", session, "--cwd", directory]
            server = subprocess.Popen(["python3", str(HOST), "--serve", "--socket", socket, "--cwd", directory],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            deadline = time.monotonic() + 5
            while subprocess.run(["tmux", "-N", "-S", socket, "show-options", "-s"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
                if time.monotonic() >= deadline: self.fail("The independent tmux supervisor did not start")
                time.sleep(.05)
            clients = []
            def attach():
                proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        env={**os.environ, "HERMES_TOKEN": "PRIVATE_SERVICE_FIXTURE", "OPENAI_API_KEY": "PRIVATE_PROVIDER_FIXTURE"})
                clients.append(proc)
                return proc
            def send(proc, value):
                proc.stdin.write((json.dumps(value) + "\n").encode()); proc.stdin.flush()
            def wait_output(proc, expected):
                selector = selectors.DefaultSelector(); selector.register(proc.stdout, selectors.EVENT_READ)
                pending, output = b"", ""
                deadline = time.monotonic() + 8
                try:
                    while time.monotonic() < deadline:
                        if not selector.select(.1):
                            continue
                        data = os.read(proc.stdout.fileno(), 65536)
                        if not data:
                            self.fail("Terminal exited before expected output: " + output[-500:])
                        pending += data
                        while b"\n" in pending:
                            line, _, pending = pending.partition(b"\n")
                            value = json.loads(line)
                            self.assertNotEqual(value.get("type"), "error")
                            output += value.get("data", "")
                        if expected in output:
                            return output
                    self.fail("Timed out waiting for terminal output: " + output[-500:])
                finally:
                    selector.close()
            try:
                first = attach()
                send(first, {"type": "resize", "columns": 100, "rows": 32})
                send(first, {"type": "input", "data": "export COMPUTER_PERSISTED='shared-🌵'; printf '\\nENV=%s:%s SIZE=' \"${HERMES_TOKEN-unset}\" \"${OPENAI_API_KEY-unset}\"; stty size\n"})
                # tmux's status line occupies one of the attached terminal rows.
                output = wait_output(first, "ENV=unset:unset SIZE=31 100")
                self.assertNotIn("PRIVATE_SERVICE_FIXTURE", output)
                self.assertNotIn("PRIVATE_PROVIDER_FIXTURE", output)
                # Even abrupt death of the app's attachment must preserve the
                # supervisor-owned shell. App shutdown kills this process group.
                first.kill(); first.wait(timeout=5)
                second = attach()
                send(second, {"type": "input", "data": "printf '\\nPERSIST=%s\\n' \"$COMPUTER_PERSISTED\"\n"})
                wait_output(second, "PERSIST=shared-🌵")
                send(second, {"type": "input", "data": "sleep 30\n"})
                time.sleep(.2)
                send(second, {"type": "input", "data": "\u0003printf '\\nINTERRUPT=%s\\n' survived\n"})
                wait_output(second, "INTERRUPT=survived")
                # A raw reader briefly stalls the PTY. More than the input
                # queue's capacity must still arrive without loss or deadlock.
                payload = ("bounded-paste-🌵" * 24000).encode()
                reader = ("import os,termios,tty,time,hashlib; old=termios.tcgetattr(0); tty.setraw(0); "
                          "print('RAW_READY',flush=True); time.sleep(.2); data=b''; "
                          f"exec('while len(data)<{len(payload)}:\\n data+=os.read(0,min(16384,{len(payload)}-len(data)))'); "
                          "termios.tcsetattr(0,termios.TCSANOW,old); print('PASTE_HASH='+hashlib.sha256(data).hexdigest(),flush=True)")
                send(second, {"type": "input", "data": "python3 -u -c " + shlex.quote(reader) + "\n"})
                # Match the execution output rather than the echoed code.
                wait_output(second, "RAW_READY\r\n")
                text = payload.decode()
                # Keep each input message below the same UTF-8 wire limit.
                for start in range(0, len(text), 3000):
                    send(second, {"type": "input", "data": text[start:start + 3000]})
                wait_output(second, "PASTE_HASH=" + hashlib.sha256(payload).hexdigest())
                subprocess.run(command + ["--end"], check=True, timeout=5)
                second.wait(timeout=5)
                self.assertNotEqual(subprocess.run(["tmux", "-S", socket, "has-session", "-t", "=" + session],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode, 0)
            finally:
                for proc in clients:
                    if proc.poll() is None:
                        proc.kill(); proc.wait()
                    for stream in (proc.stdin, proc.stdout, proc.stderr):
                        if stream and not stream.closed: stream.close()
                subprocess.run(["tmux", "-S", socket, "kill-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                server.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
