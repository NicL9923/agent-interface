"""Supervise the household's native desktop and persistent, headed browser.

Run through the installed PM launcher as agent_interface_computer_host. This
process owns the browser, while dashboard and gateway independently coordinate
tool calls and human control. No provider credentials enter the browser process.

Hermes updates and app releases restart the gateway but not this supervisor. Once
the gateway runs a different Hermes revision or the app release changes, the
supervisor exits at the next idle moment so systemd restarts it on matching code.
"""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import signal
import socket
import subprocess
import time
from urllib.parse import urlsplit

RESTART_EXIT = 75
CODE_CHECK_SECONDS = 60


def installed_revision(source):
    return subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True, timeout=30).strip()


def loaded_code(source):
    """The app release and Hermes revision this process imported."""
    return Path(__file__).resolve(), installed_revision(source)


def restart_reason(loaded, source, hermes_home):
    """Why this supervisor should restart onto newer code, or None.

    Waits for the gateway to run again, so an update or release in progress
    never restarts the computer halfway through. Restarts for Hermes only when
    the installed source is what the gateway runs, so a restart reaches it.
    """
    try:
        state = json.loads((Path(hermes_home) / "gateway_state.json").read_text())
    except (OSError, ValueError):
        return None
    if state.get("gateway_state") != "running":
        return None
    if Path(__file__).resolve() != loaded[0]:
        return "The app release changed"
    running = state.get("code_sha")
    if running and running != loaded[1] and running == installed_revision(source):
        return "Hermes is running revision " + running[:12]
    return None


def claim_idle(computer, held, error):
    """Hold the computer's operation lock if nobody is using it; True when held."""
    def in_use():
        return (computer.state / "computer-recovery.json").exists() or computer._lease().holder == computer.lease.HUMAN
    if in_use():
        return False
    try:
        held.enter_context(computer.operation(timeout=0))
    except error:
        return False
    # A bot action can leave recovery pending, or a member take control, before the lock is free.
    if in_use():
        held.close()
        return False
    return True


def main():
    spec = importlib.util.spec_from_file_location("agent_interface_computer", Path(__file__).resolve().with_name("computer.py"))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    setting = module.configured()
    if setting is None:
        raise SystemExit("The household computer is not configured.")
    home, endpoint = setting
    from tools.bot_desktop import runtime, lease, browser
    source = Path(runtime.__file__).resolve().parents[2]
    loaded = loaded_code(source)
    hermes_home = os.environ["HERMES_HOME"]
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
    restart = None
    held = contextlib.ExitStack()
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
        next_check = time.monotonic() + CODE_CHECK_SECONDS
        while not stop:
            if child.poll() is not None:
                raise RuntimeError("The household browser exited; its supervisor will restart it.")
            with module.resource_scope(home):
                if not runtime.status().running:
                    raise RuntimeError("The household desktop exited; its supervisor will restart it.")
            if time.monotonic() >= next_check:
                next_check = time.monotonic() + CODE_CHECK_SECONDS
                try:
                    restart = restart_reason(loaded, source, hermes_home)
                except (OSError, subprocess.SubprocessError):
                    restart = None
                # Keep the lock through shutdown, so no bot action starts on the old browser.
                if restart and claim_idle(computer, held, module.ComputerError):
                    # Recheck under the lock; an update or release may have started meanwhile.
                    try:
                        restart = restart_reason(loaded, source, hermes_home)
                    except (OSError, subprocess.SubprocessError):
                        restart = None
                    if restart:
                        break
                    held.close()
                restart = None
            time.sleep(1)
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        with module.resource_scope(home):
            runtime.stop()
        held.close()
    if restart:
        print(restart + "; restarting the household computer on matching code.", flush=True)
        raise SystemExit(RESTART_EXIT)


if __name__ == "__main__":
    main()
