"""Supervise the household's native desktop and persistent, headed browser.

Run through the installed PM launcher as agent_interface_computer_host. This
process owns the browser, while dashboard and gateway independently coordinate
tool calls and human control. No provider credentials enter the browser process.
"""
import importlib.util
import os
from pathlib import Path
import pwd
import signal
import socket
import subprocess
import time
from urllib.parse import urlsplit


def main():
    spec = importlib.util.spec_from_file_location("agent_interface_computer", Path(__file__).resolve().with_name("computer.py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    setting = module.configured()
    if setting is None:
        raise SystemExit("The household computer is not configured.")
    home, endpoint = setting
    from tools.bot_desktop import runtime, lease, browser
    computer = module.Computer(home, endpoint, runtime, lease)
    computer._private_dir()
    url = urlsplit(endpoint)
    with socket.socket() as probe:
        if probe.connect_ex((url.hostname, url.port)) == 0:
            raise SystemExit("The household browser port is already occupied.")
    stop = False
    def interrupted(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    child = None
    try:
        with module.resource_scope(home):
            runtime.start()
            executable = browser.executable()
            if not executable:
                raise RuntimeError("Install a headed Chrome browser on the Hermes host.")
            profile = str(browser.profile_dir())
            display = runtime.desktop_env({})
        account = pwd.getpwuid(os.getuid())
        env = {"HOME": account.pw_dir, "USER": account.pw_name, "LOGNAME": account.pw_name,
               "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": os.environ.get("LANG", "C.UTF-8"), **display}
        # The distro browser supplies its sandbox. Never weaken it for this service.
        argv = [arg for arg in browser.dock_argv(executable, profile, sandbox_bypass=False)
                if not arg.startswith("--remote-debugging-port=")]
        argv += [f"--remote-debugging-port={url.port}", "--remote-debugging-address=127.0.0.1", "--restore-last-session"]
        child = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while not computer._browser_ready():
            if stop: return
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError("The household browser did not become ready.")
            time.sleep(.2)
        print("Household desktop and persistent browser are ready.", flush=True)
        while not stop:
            if child.poll() is not None:
                raise RuntimeError("The household browser exited; its supervisor will restart it.")
            with module.resource_scope(home):
                if not runtime.status().running:
                    raise RuntimeError("The household desktop exited; its supervisor will restart it.")
            time.sleep(1)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        with module.resource_scope(home):
            runtime.stop()


if __name__ == "__main__":
    main()
