#!/usr/bin/env python3
"""A bounded PTY attachment to an app-owned tmux server. Detach preserves the shell."""
import argparse
import codecs
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import selectors
import signal
import struct
import subprocess
import sys
import termios


def shell_environment():
    account = pwd.getpwuid(os.getuid())
    # Never let service/provider credentials enter a human shell or the tmux server.
    return {"HOME": account.pw_dir, "USER": account.pw_name, "LOGNAME": account.pw_name,
            "SHELL": account.pw_shell or "/bin/bash", "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"), "TERM": "xterm-256color", "COLORTERM": "truecolor"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--session")
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--end", action="store_true")
    parser.add_argument("--serve", action="store_true")
    args = parser.parse_args()
    if args.serve and (args.session or args.end):
        parser.error("The terminal supervisor does not attach a session")
    if not args.serve and not re.fullmatch(r"member-[a-f0-9]{32}", args.session or ""):
        parser.error("Invalid terminal identity")
    socket = Path(args.socket)
    if not socket.is_absolute() or not Path(args.cwd).is_absolute():
        parser.error("Terminal paths must be absolute")
    env = shell_environment()
    if args.serve:
        os.chdir(args.cwd)
        # Foreground server owns pane processes independently of app cgroups.
        # -D also disables exit-empty, so the first member may attach later.
        os.execvpe("tmux", ["tmux", "-f", "/dev/null", "-S", str(socket), "-D"], env)
    # A missing supervisor must fail rather than spawn a server in the app unit.
    command = ["tmux", "-N", "-f", "/dev/null", "-S", str(socket)]
    if args.end:
        exists = subprocess.run(command + ["has-session", "-t", "=" + args.session], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if exists.returncode == 0:
            subprocess.run(command + ["kill-session", "-t", "=" + args.session], env=env, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return

    def emit(value):
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    child, master = os.forkpty()
    if child == 0:
        os.chdir(args.cwd)
        os.execvpe("tmux", command + ["new-session", "-A", "-s", args.session, "-c", args.cwd,
                                    env["SHELL"], "-l"], env)
    os.set_blocking(master, False)
    os.set_blocking(sys.stdin.fileno(), False)
    selector = selectors.DefaultSelector()
    selector.register(master, selectors.EVENT_READ, "output")
    selector.register(sys.stdin, selectors.EVENT_READ, "input")
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    pending = bytearray()
    to_pty = bytearray()
    reading_input = True
    try:
        emit({"type": "ready"})
        while True:
            for key, events in selector.select():
                if key.data == "output":
                    if events & selectors.EVENT_READ:
                        try:
                            data = os.read(master, 16384)
                        except BlockingIOError:
                            data = None
                        except OSError:
                            return
                        if data == b"":
                            return
                        if data:
                            emit({"type": "output", "data": decoder.decode(data)})
                    if events & selectors.EVENT_WRITE and to_pty:
                        try:
                            count = os.write(master, to_pty)
                            del to_pty[:count]
                        except BlockingIOError:
                            pass
                        if not to_pty:
                            selector.modify(master, selectors.EVENT_READ, "output")
                        if len(to_pty) < 32768 and not reading_input:
                            selector.register(sys.stdin, selectors.EVENT_READ, "input")
                            reading_input = True
                else:
                    data = os.read(sys.stdin.fileno(), 16384)
                    if not data:
                        return
                    pending.extend(data)
                    if len(pending) > 131072:
                        raise ValueError("Terminal input exceeds limit")
                    while b"\n" in pending:
                        line, _, rest = pending.partition(b"\n")
                        pending = bytearray(rest)
                        message = json.loads(line)
                        if message.get("type") == "input":
                            text = message.get("data")
                            if not isinstance(text, str) or len(text.encode()) > 16384:
                                raise ValueError("Invalid terminal input")
                            # Keep draining output while a pasted command awaits PTY space.
                            to_pty.extend(text.encode())
                            if len(to_pty) > 131072:
                                raise ValueError("Terminal input exceeds limit")
                            selector.modify(master, selectors.EVENT_READ | selectors.EVENT_WRITE, "output")
                        elif message.get("type") == "resize":
                            cols, rows = message.get("columns"), message.get("rows")
                            if (type(cols) is not int or type(rows) is not int
                                    or not 2 <= cols <= 500 or not 2 <= rows <= 300):
                                raise ValueError("Invalid terminal size")
                            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                        else:
                            raise ValueError("Unknown terminal message")
                    if len(to_pty) > 65536:
                        # Apply backpressure to the pipe instead of losing a
                        # large paste while the terminal drains earlier bytes.
                        selector.unregister(sys.stdin)
                        reading_input = False
    finally:
        selector.close()
        os.close(master)  # SIGHUP detaches this tmux client, not its shell.
        try:
            os.kill(child, signal.SIGHUP)
            os.waitpid(child, 0)
        except ProcessLookupError:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Exceptions can carry host paths. Keep these out of browser output.
        print(json.dumps({"type": "error", "message": "The system terminal could not be attached."}), flush=True)
        raise SystemExit(1)
