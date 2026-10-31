"""One explicitly configured computer, independent of conversational profile identity.

The native desktop's runtime files and lease share one owner home. Tool calls retain
their actual Hermes profile, secret scope and model settings. An on-disk operation
lock brackets the complete browser/desktop call in every executor process.
"""
import contextlib
import functools
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import time
import threading
from urllib.parse import urlsplit
import urllib.request


def sibling_module(name):
    """Load src/hermes/NAME.py once per process, under its one canonical module name.

    A second load under another name would be a separate instance with its own state.
    Keep every copy of this function identical; tests/hermes_private_fs_test.py checks.
    """
    canonical, path = "agent_interface_" + name, Path(__file__).resolve().with_name(name + ".py")
    if canonical not in sys.modules:
        spec = importlib.util.spec_from_file_location(canonical, path)
        sys.modules[canonical] = module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except BaseException:
            del sys.modules[canonical]
            raise
    module = sys.modules[canonical]
    if Path(module.__file__).resolve() != path:
        raise ImportError(canonical + " is already loaded from " + module.__file__)
    return module



private_fs = sibling_module("private_fs")


class ComputerError(RuntimeError):
    pass


HARNESS_RECOVERY = r"""
import json, os, sys, time, urllib.request
from browser_harness import _ipc as ipc, admin
record = json.load(sys.stdin)
name = os.environ['BU_NAME']
pid = ipc.identify(name, timeout=1.0)
generation = (pid, admin._process_start_time(pid)) if pid else admin._fingerprinted_pending_generation(ipc.pid_path(name))
if generation is None and ipc.pid_path(name).exists():
    raise RuntimeError('The named browser daemon has no verifiable process identity')
if generation is not None and not generation[1]:
    raise RuntimeError('The named browser daemon has no process-start fingerprint')
if generation is not None:
    # A confirmed native shutdown first drains stale-session recovery. Killing
    # the daemon alone cannot cancel work already executing in a renderer.
    admin.restart_daemon(name, require_clean=True)
if generation is not None:
    pid, started = generation
    import psutil
    def alive():
        try:
            return admin._process_start_time(pid) == started and psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
    deadline = time.monotonic() + 3
    while alive() and time.monotonic() < deadline:
        time.sleep(.05)
    if alive():
        raise RuntimeError('The interrupted browser daemon is still running')
if ipc.ping(name, timeout=.2):
    raise RuntimeError('The named browser daemon is still accepting work')
# The native daemon closes its original dedicated tab. User code can switch or
# create another tab, so independently close every target used by this call.
targets = set(record.get('targets', []))
if targets:
    from websockets.sync.client import connect
    from urllib.parse import urlsplit
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(record['endpoint'] + '/json/version', timeout=2) as response:
        endpoint = json.load(response)['webSocketDebuggerUrl']
    parsed, fixed = urlsplit(endpoint), urlsplit(record['endpoint'])
    if parsed.scheme != 'ws' or parsed.hostname != fixed.hostname or parsed.port != fixed.port:
        raise RuntimeError('The browser recovery endpoint changed')
    with connect(endpoint, open_timeout=2, proxy=None) as ws:
        sequence = 0
        def cdp(method, params=None):
            global sequence
            sequence += 1
            ws.send(json.dumps({'id': sequence, 'method': method, 'params': params or {}}))
            while True:
                result = json.loads(ws.recv(timeout=2))
                if result.get('id') == sequence:
                    if result.get('error'):
                        raise RuntimeError('Browser recovery CDP request failed')
                    return result.get('result', {})
        present = {item['targetId'] for item in cdp('Target.getTargets')['targetInfos']}
        for target in targets & present:
            try:
                cdp('Target.closeTarget', {'targetId': target})
            except RuntimeError:
                pass  # It may have disappeared already; the poll below proves closure.
        # Chrome acknowledges close before removing the target from discovery.
        deadline = time.monotonic() + 3
        while True:
            present = {item['targetId'] for item in cdp('Target.getTargets')['targetInfos']}
            if not targets & present:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('An interrupted browser target is still running')
            time.sleep(.05)
"""


HARNESS_PROLOGUE = r"""
# Qualified native named daemons already own one tab. Record actual target use
# and IPC timeouts before model code can catch or wrap their Python exception.
import json as _computer_json, os as _computer_os, secrets as _computer_secrets, threading as _computer_threading
from browser_harness import helpers as _computer_helpers
_computer_record_path = __RECORD_PATH__
_computer_record_lock = _computer_threading.Lock()
def _computer_record(target=None, interrupted=False):
    with _computer_record_lock:
        with open(_computer_record_path) as handle:
            record = _computer_json.load(handle)
        if target:
            record['targets'] = list(set(record.get('targets', [])) | {target})
        if interrupted:
            record['interrupted'] = True
        temporary = _computer_record_path + '.' + _computer_secrets.token_hex(8)
        fd = _computer_os.open(temporary, _computer_os.O_CREAT | _computer_os.O_EXCL | _computer_os.O_WRONLY, 0o600)
        with _computer_os.fdopen(fd, 'w') as handle:
            _computer_json.dump(record, handle)
            handle.flush()
            _computer_os.fsync(handle.fileno())
        _computer_os.replace(temporary, _computer_record_path)
_computer_native_send = _computer_helpers._send
def _computer_send(req, *args, **kwargs):
    if req.get('method') == 'Browser.close':
        raise RuntimeError('The household browser is persistent. Close a tab instead.')
    if req.get('method', '').startswith('Target.'):
        _computer_record(req.get('params', {}).get('targetId'))
    if req.get('meta') == 'set_session':
        _computer_record(req.get('target_id'))
    try:
        result = _computer_native_send(req, *args, **kwargs)
    except _computer_helpers._IPCResponseTimeout:
        _computer_record(interrupted=True)
        raise
    if req.get('method') == 'Target.createTarget':
        _computer_record(result.get('result', {}).get('targetId'))
    elif req.get('meta') in ('current_tab', 'connection_status'):
        _computer_record(result.get('targetId') or result.get('target_id'))
    return result
_computer_helpers._send = _computer_send
_computer_current = _computer_send({'meta': 'current_tab'}, response_timeout=2)
if not _computer_current.get('targetId'):
    raise RuntimeError('The household browser has no verified task tab')
"""


def configured():
    raw = os.environ.get("HERMES_AGENT_INTERFACE_COMPUTER_HOME", "")
    if not raw:
        return None
    home = Path(raw)
    if not home.is_absolute() or home.is_symlink() or str(home.resolve()) != str(home):
        raise ComputerError("The household computer requires a fixed absolute owner directory.")
    endpoint = os.environ.get("HERMES_AGENT_INTERFACE_COMPUTER_CDP_URL", "")
    url = urlsplit(endpoint)
    if (url.scheme != "http" or url.hostname not in ("127.0.0.1", "[::1]", "::1", "localhost")
            or not url.port or url.username or url.password or url.query or url.fragment
            or url.path not in ("", "/")):
        raise ComputerError("The household browser requires a fixed HTTP loopback CDP origin.")
    return home, endpoint.rstrip("/")


@contextlib.contextmanager
def resource_scope(home):
    """Only desktop lifecycle helpers enter this scope, never the agent/tool body."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    token = set_hermes_home_override(str(home))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


class Computer:
    def __init__(self, home, endpoint, runtime, lease):
        self.home = Path(home)
        self.endpoint = endpoint
        self.runtime = runtime
        self.lease = lease
        self.state = self.home / "bot-desktop"
        self._operation = threading.local()
        self._local_policy = None

    def _private_dir(self):
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state.mkdir(exist_ok=True, mode=0o700)
        for path in (self.home, self.state):
            if not private_fs.owner_private(path, "dir"):
                raise ComputerError("The household computer directory must be owner-only.")

    @contextlib.contextmanager
    def operation(self, timeout=5.0):
        import fcntl
        self._private_dir()
        fd = os.open(self.state / "computer-operation.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ComputerError("The household computer is busy. Try again after the current action finishes.") from None
                    time.sleep(.025)
            try:
                yield fd
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def _read(self, name, default):
        try:
            path = self.state / name
            if path.is_symlink():
                raise ComputerError("The household computer ownership record is invalid.")
            return json.loads(path.read_text())
        except FileNotFoundError:
            return default
        except (ValueError, OSError) as exc:
            raise ComputerError("The household computer ownership record cannot be read.") from exc

    def _write(self, name, value):
        private_fs.atomic_json(self.state / name, value)

    def _actor(self, params):
        actor, name = params.get("actorId"), params.get("actorName")
        if not isinstance(actor, str) or not 1 <= len(actor) <= 200 or not isinstance(name, str) or not 1 <= len(name) <= 200:
            raise ComputerError("An authenticated household member is required.")
        return hashlib.sha256(actor.encode()).hexdigest(), name

    def _viewer(self, params, *, create=False):
        actor, name = self._actor(params)
        viewers = self._read("computer-viewers.json", {})
        entry = viewers.get(actor)
        if create and entry is None:
            if len(viewers) >= 100:
                raise ComputerError("The household computer has too many viewer identities.")
            entry = {"viewerId": secrets.token_urlsafe(16), "name": name}
            viewers[actor] = entry
            self._write("computer-viewers.json", viewers)
        if entry is None or not create and not hmac.compare_digest(str(params.get("viewerId") or ""), entry["viewerId"]):
            raise ComputerError("This viewer does not belong to the signed-in household member. Open the computer again.")
        return actor, name, entry["viewerId"]

    def _lease(self):
        return self.lease.get(profile_key=str(self.home))

    def _recovery_required(self):
        if (self.state / "computer-recovery.json").exists():
            raise ComputerError("An interrupted browser action needs recovery before anyone can control the computer.")

    def recover_harness(self, record):
        # Persist only library/IPC routing, never the tool process's secret environment.
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "LC_ALL")}
        env.update(record["environment"])
        try:
            result = subprocess.run([record["python"], "-c", HARNESS_RECOVERY], env=env,
                input=json.dumps(record).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
            if result.returncode:
                return False
        except (OSError, subprocess.TimeoutExpired):
            return False
        (self.state / "computer-recovery.json").unlink(missing_ok=True)
        return True

    def _browser_endpoint(self):
        """Discover only this fixed origin, without proxies or redirects."""
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(self.endpoint + "/json/version", timeout=1) as response:
            payload = json.load(response)
        value = payload.get("webSocketDebuggerUrl", "") if isinstance(payload, dict) else ""
        if not isinstance(value, str):
            raise ComputerError("The household browser discovery identity is invalid.")
        parsed, fixed = urlsplit(value), urlsplit(self.endpoint)
        if (parsed.scheme != "ws" or parsed.hostname != fixed.hostname or parsed.port != fixed.port
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or not re.fullmatch(r"/devtools/browser/[a-zA-Z0-9-]{20,}", parsed.path)):
            raise ComputerError("The household browser discovery identity is invalid.")
        return value

    def _browser_ready(self):
        try:
            return bool(self._browser_endpoint())
        except (OSError, ValueError, ComputerError):
            return False

    @staticmethod
    def _process_identity(pid):
        import psutil
        process = psutil.Process(pid)
        if process.uids().real != os.getuid() or process.status() == psutil.STATUS_ZOMBIE:
            raise ComputerError("The household browser process is not owned by this runtime.")
        # Linux epoch create_time depends on each process's cached boot time.
        # Raw kernel start ticks are stable across the supervisor and gateway.
        started = (int(Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[19])
                   if sys.platform == "linux" else process.create_time())
        return {"pid": process.pid, "started": started}

    def register_browser(self, child):
        """Supervisor-only publication after launching its own browser child.

        The unpredictable Chrome browser websocket identity binds discovery to
        this generation, rather than trusting any server on a loopback port.
        Process birth times prevent stale registrations from trusting reused PIDs.
        """
        import psutil
        if child.poll() is not None or psutil.Process(child.pid).ppid() != os.getpid():
            raise ComputerError("The household browser must be a live supervisor child.")
        self._write("computer-browser.json", {"endpoint": self.endpoint, "websocket": self._browser_endpoint(),
            "supervisor": self._process_identity(os.getpid()), "browser": self._process_identity(child.pid)})

    def verified_local_browser(self):
        import psutil
        try:
            self._private_dir()
            fd = os.open(self.state / "computer-browser.json", os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd) as handle:
                if not private_fs.owner_private(handle.fileno(), max_bytes=4096):
                    return False
                record = json.load(handle)
            if not isinstance(record, dict) or record.get("endpoint") != self.endpoint:
                return False
            for name in ("supervisor", "browser"):
                if self._process_identity(record[name]["pid"]) != record[name]:
                    return False
            browser = psutil.Process(record["browser"]["pid"])
            if (browser.ppid() != record["supervisor"]["pid"]
                    or f"--remote-debugging-port={urlsplit(self.endpoint).port}" not in browser.cmdline()):
                return False
            fixed = urlsplit(self.endpoint)
            # argv alone cannot prove bind succeeded: another listener could
            # have won the port between the supervisor's probe and Chrome start.
            # Require a literal origin so discovery and listener cannot choose
            # different addresses from a hostname such as localhost.
            if not any(connection.status == psutil.CONN_LISTEN and connection.laddr
                       and connection.laddr.ip == fixed.hostname and connection.laddr.port == fixed.port
                       for connection in browser.net_connections(kind="tcp")):
                return False
            return hmac.compare_digest(self._browser_endpoint(), record["websocket"])
        except (OSError, ValueError, IndexError, KeyError, TypeError, ComputerError, psutil.Error):
            return False

    def profile_local_browser(self):
        """Extra local classification, never a private-URL permission override."""
        policy = self._local_policy
        if policy is None:
            return False
        try:
            browser = policy.config.read_raw_config().get("browser", {})
            config = browser.get("agent_interface", {})
            if config.get("allow_local_network") is not True:
                return False
            # Routed profiles must have their own complete policy. Falling back
            # to the launch profile's environment would widen their authority.
            if policy.scope.get_terminal_scope() is None and policy.constants.get_hermes_home_override() is not None:
                return False
            policy.terminal._ensure_terminal_env_bridged()
            if policy.scope.terminal_env("TERMINAL_ENV", "local") != "local":
                return False
            return self.verified_local_browser()
        except (OSError, ValueError, AttributeError, policy.scope.TerminalPolicyUnavailable):
            return False

    def status(self, params=None):
        params = params or {}
        with resource_scope(self.home):
            native = self.runtime.status()
        lease = self._lease()
        control = {"kind": "idle"}
        if lease.holder == self.lease.HUMAN:
            owner = self._read("computer-human.json", {})
            matched = owner.get("viewerId") == lease.viewer_id
            control = {"kind": "human", "name": owner.get("name", "Another viewer") if matched else "Another viewer",
                       "mine": matched and owner.get("actor") == hashlib.sha256(str(params.get("actorId", "")).encode()).hexdigest()}
        busy = False
        if lease.holder != self.lease.HUMAN:
            active = self._read("computer-active.json", {})
            # A crash leaves the activity record, but kernel locks die with their owner.
            try:
                with self.operation(timeout=0):
                    pass
            except ComputerError:
                busy = True
                if active.get("name"):
                    control = {"kind": "bot", "name": active["name"]}
        available = bool(native.supported and native.installed)
        reason = None if available else "Install the household desktop packages on the Hermes host."
        recovering = not busy and (self.state / "computer-recovery.json").exists()
        if recovering:
            reason = "An interrupted browser action needs recovery before anyone can control the computer."
        return {"available": available, "running": bool(native.running), "browserReady": self._browser_ready() if native.running and not recovering else False,
                "label": "Household computer", **({"reason": reason} if reason else {}), "control": control,
                "terminal": {"available": False, "target": "Hermes host", "reason": "A system terminal is not configured."}}

    def request(self, params):
        action = params.get("action", "status")
        if action == "status":
            return self.status(params)
        secret = os.environ.get("HERMES_AGENT_INTERFACE_TOKEN", "")
        supplied = params.get("service_key", "")
        if not secret or not isinstance(supplied, str) or not hmac.compare_digest(supplied, secret):
            raise ComputerError("Private application authentication is required.")
        if action not in ("observe", "take", "release"):
            raise ComputerError("Unknown household computer action.")
        with self.operation():
            actor, name, viewer = self._viewer(params, create=action == "observe")
            if action == "observe":
                with resource_scope(self.home):
                    self.runtime.start()
                from hermes_cli.dashboard_auth.ws_tickets import mint_ticket
                ticket = mint_ticket(user_id="display:" + viewer, provider="bot-desktop",
                                     extra={"hermes_home": str(self.home), "viewer_id": viewer})
                return {"ticket": ticket, "path": "/api/display/ws", "viewerId": viewer}
            lease = self._lease()
            if lease.holder == self.lease.HUMAN and lease.viewer_id != viewer:
                raise ComputerError("Another person controls the household computer. They must hand it back first.")
            if action == "take":
                pending = self._read("computer-recovery.json", None)
                if pending is not None:
                    self.recover_harness(pending)
                self._recovery_required()
                self._write("computer-human.json", {"actor": actor, "name": name, "viewerId": viewer})
                self.lease.acquire(viewer, profile_key=str(self.home), reason=name + " is using the household computer")
            else:
                self.lease.release(viewer, profile_key=str(self.home))
                (self.state / "computer-human.json").unlink(missing_ok=True)
        return self.status(params)

    def _check_bot_admission(self):
        self._recovery_required()
        self.lease.assert_agent_may_act(profile_key=str(self.home))
        maintenance = os.environ.get("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE", "")
        if maintenance and Path(maintenance).exists():
            raise ComputerError("Hermes is being upgraded. The household computer is paused.")

    def _clear_activity(self, owner):
        if self._read("computer-active.json", {}).get("operationId") == owner["operationId"]:
            (self.state / "computer-active.json").unlink(missing_ok=True)

    @contextlib.contextmanager
    def suspend_for_prompt(self):
        """Yield only an admitted tool's lock during a native human prompt wait."""
        import fcntl
        active = getattr(self._operation, "active", None)
        if active is None:
            yield
            return
        fd, owner = active
        lease_epoch = self._lease().epoch
        self._operation.active = None
        self._clear_activity(owner)
        fcntl.flock(fd, fcntl.LOCK_UN)
        try:
            yield
        finally:
            # Always reacquire before the surrounding tool can unwind or act.
            deadline = time.monotonic() + 5
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise ComputerError("The household computer is busy. Retry after its current action finishes.") from None
                    time.sleep(.025)
            self._check_bot_admission()
            if self._lease().epoch != lease_epoch:
                raise ComputerError("Control changed while Hermes waited for secure input. Review the page before retrying.")
            self._write("computer-active.json", owner)
            self._operation.active = active

    @contextlib.contextmanager
    def bot_operation(self, name):
        with self.operation() as fd:
            pending = self._read("computer-recovery.json", None)
            if pending is not None:
                self.recover_harness(pending)
            self._check_bot_admission()
            with resource_scope(self.home):
                self.runtime.start()
            owner = {"name": name, "operationId": secrets.token_hex(16)}
            self._write("computer-active.json", owner)
            self._operation.active = (fd, owner)
            try:
                yield
            finally:
                self._operation.active = None
                self._clear_activity(owner)


def install_tools():
    setting = configured()
    if setting is None:
        return None
    home, endpoint = setting
    from tools.registry import registry
    existing = getattr(registry, "_agent_interface_computer", None)
    if existing is not None:
        if existing.home != home or existing.endpoint != endpoint:
            raise ComputerError("The shared computer was already configured with another identity.")
        return existing
    from tools.bot_desktop import runtime, lease, placement
    from tools import browser_use_cli
    # Support the installed revision during staging and rollback, and the current API after update.
    try:
        session = importlib.import_module("tools.browser_session")
    except ModuleNotFoundError as exc:
        if exc.name != "tools.browser_session":
            raise
        from tools import browser_tool as bt, browser_tool_cdp as cdp, browser_tool_session as session
        from tools import browser_tool_lifecycle as lifecycle, browser_tool_cloud as cloud
        from tools import browser_extension_router as router, browser_tool_eval_policy as browser_policy, browser_cdp_tool
        modern = False
    else:
        from tools import browser_session_cdp as cdp, browser_session_cloud as cloud, browser_url_policy as browser_policy
        modern = True
    cdp_name = "get_cdp_override_raw" if modern else "_get_cdp_override_raw"
    local_name = "is_local_backend" if modern else "_is_local_backend"
    shared_name = "shares_bot_desktop_browser" if modern else "_shares_bot_desktop_browser"
    dialog_name = "get_dialog_policy_config" if modern else "_get_dialog_policy_config"
    try:
        from hermes_cli import config
        import hermes_constants
        from tools import terminal_scope, terminal_tool, url_safety
        from tools.browser_supervisor_dialogs import DialogSupervisionMixin
    except ImportError as exc:
        raise ComputerError("Shared computer native tool seams require qualification.") from exc
    required = ((registry, "dispatch"), (runtime, "start"), (runtime, "desktop_env"), (runtime, "stop_if_idle"),
                (lease, "get"), (lease, "acquire"), (lease, "release"), (lease, "assert_agent_may_act"),
                (cdp, cdp_name), (session, shared_name),
                (DialogSupervisionMixin, "_dialog_timeout_expired"),
                (config, "read_raw_config"), (hermes_constants, "get_hermes_home_override"),
                (terminal_scope, "get_terminal_scope"), (terminal_scope, "terminal_env"),
                (terminal_scope, "TerminalPolicyUnavailable"), (terminal_tool, "_ensure_terminal_env_bridged"),
                (url_safety, "is_always_blocked_url"),
                (browser_use_cli, "_route_backend"), (browser_use_cli, "_set_cdp_env"),
                (browser_use_cli, "_run_cli_killing_process_group"), (cloud, local_name))
    if modern:
        required += ((cdp, dialog_name), (browser_policy, "url_literals"))
    else:
        required += ((session, "_run_browser_command"), (lifecycle, "_cleanup_single_browser_session"),
                     (router, "routed_browser_handler"))
    literals = getattr(browser_policy, "url_literals", None) if modern else getattr(getattr(browser_policy, "_JS_URL_LITERAL_RE", None), "findall", None)
    if (any(not callable(getattr(module, name, None)) for module, name in required)
            or not callable(literals)
            or not isinstance(getattr(browser_use_cli, "_OWN_TAB_PREAMBLE", None), str)
            or not isinstance(getattr(browser_use_cli, "_BOT_DESKTOP_BROWSER_SENTINEL", None), str)):
        raise ComputerError("Shared computer native tool seams require qualification.")
    computer = Computer(home, endpoint, runtime, lease)
    from types import SimpleNamespace
    computer._local_policy = SimpleNamespace(config=config, constants=hermes_constants,
        scope=terminal_scope, terminal=terminal_tool)
    computer._private_dir()
    # Module-specific resource mapping. Conversational get_hermes_home remains unchanged.
    runtime.get_hermes_home = lambda: home
    placement.resolve = lambda: placement.Placement(placement.GATEWAY, "local", "Explicitly configured household computer")
    runtime.stop_if_idle = lambda *a, **k: False  # supervisor owns the shared computer's lifetime
    for name in ("get", "acquire", "release", "human_holds", "viewer_may_send_input", "assert_agent_may_act"):
        original = getattr(lease, name)
        @functools.wraps(original)
        def mapped(*args, _native=original, **kwargs):
            if _native.__name__ in ("get", "human_holds", "assert_agent_may_act") and args:
                return _native(*args, **kwargs)
            kwargs.setdefault("profile_key", str(home))
            return _native(*args, **kwargs)
        setattr(lease, name, mapped)
    setattr(cdp, cdp_name, lambda: endpoint)
    # Revision-qualified private seam: retain native navigation/site checks and
    # every other backend's classification. Only our registered browser can
    # acquire the active profile's explicit local-network authorization.
    native_local_backend = getattr(cloud, local_name)
    @functools.wraps(native_local_backend)
    def local_backend():
        if getattr(cdp, cdp_name)() != endpoint:
            return native_local_backend()
        return computer.profile_local_browser()
    setattr(cloud, local_name, local_backend)
    if not modern:
        bt._is_camofox_mode = lambda: False
    # Preserve Hermes's default browser_exec interface. Its named sessions get
    # distinct tabs in the SAME externally owned browser and cookie jar.
    # Native routing flags select a local sidecar or personal browser. This
    # installation always uses the explicitly configured household browser.
    def route_harness(env, session_name, task_id, local, force_local_sidecar=False, real_profile=True):
        browser_use_cli._set_cdp_env(env, endpoint)
        env[browser_use_cli._BOT_DESKTOP_BROWSER_SENTINEL] = "1"
        env["BU_AUTOSPAWN"] = "0"
        # Profile executors may set a long, profile-specific TMPDIR. Native
        # Unix sockets need one fixed short namespace for this shared resource.
        shared_ipc = Path("/tmp") / ("agentui-computer-" + str(os.getuid()) + "-" + hashlib.sha256(str(home).encode()).hexdigest()[:12])
        shared_ipc.mkdir(mode=0o700, exist_ok=True)
        if not private_fs.owner_private(shared_ipc, "dir"):
            raise ComputerError("The household browser IPC directory must be private.")
        env.update(BH_HOME=str(computer.state / "harness"), BH_RUNTIME_DIR=str(shared_ipc), BH_RUNTIME_DIR_SHARED="1",
                   BH_TMP_DIR=str(computer.state / "harness" / "tmp"), BH_TMP_DIR_SHARED="1")
        return None
    browser_use_cli._route_backend = route_harness
    # Qualified harness named daemons create and own their own distinct tab.
    # Hermes's older preamble would create a second tab outside that lifecycle.
    browser_use_cli._OWN_TAB_PREAMBLE = ""
    native_cli = browser_use_cli._run_cli_killing_process_group
    computer._run_harness_cli = native_cli
    @functools.wraps(native_cli)
    def harness_cli(command, code, env, timeout):
        if "--reload" in command:
            return computer._run_harness_cli(command, code, env, timeout)
        routing_keys = ("HOME", "PYTHONPATH", "BU_NAME", "BH_HOME", "BH_CONFIG_DIR", "BH_RUNTIME_DIR", "BH_RUNTIME_DIR_SHARED", "BH_TMP_DIR", "BH_TMP_DIR_SHARED")
        record = {"python": command[0], "endpoint": endpoint, "targets": [],
                  "environment": {key: env[key] for key in routing_keys if key in env}}
        computer._write("computer-recovery.json", record)
        prologue = HARNESS_PROLOGUE.replace("__RECORD_PATH__", repr(str(computer.state / "computer-recovery.json")))
        try:
            result = computer._run_harness_cli(command, prologue + "\n" + code, env, timeout)
        except subprocess.TimeoutExpired:
            computer.recover_harness(computer._read("computer-recovery.json", record))
            raise
        except BaseException:
            # Interpreter interruption can leave the named daemon behind. The
            # next controller recovers it under the same resource lock.
            raise
        output = str(result.stdout or "") + "\n" + str(result.stderr or "")
        record = computer._read("computer-recovery.json", record)
        if record.get("interrupted") or re.search(r"timed out after [0-9.]+s waiting for the daemon", output, re.IGNORECASE):
            computer.recover_harness(record)
        else:
            (computer.state / "computer-recovery.json").unlink(missing_ok=True)
        return result
    browser_use_cli._run_cli_killing_process_group = harness_cli
    # An attached browser belongs to the supervisor, never a bot task's teardown.
    if not modern:
        native_command = session._run_browser_command
        @functools.wraps(native_command)
        def browser_command(task_id, command, *args, **kwargs):
            if command == "close":
                return {"success": True, "data": {}}
            return native_command(task_id, command, *args, **kwargs)
        session._run_browser_command = browser_command
    native_shared_browser = getattr(session, shared_name)
    setattr(session, shared_name, lambda info: bool((info.get("features") or {}).get("cdp_override")) or native_shared_browser(info))
    # Native dialog watchdogs run outside the tool-dispatch thread. They must not
    # dismiss a human's prompt or overlap an admitted browser operation.
    import asyncio
    native_watchdog = DialogSupervisionMixin._dialog_timeout_expired
    setattr(cdp, dialog_name, lambda: ("must_respond", 300.0))
    async def guarded_watchdog(self, dialog_id):
        try:
            with computer.operation(timeout=0):
                computer._recovery_required()
                computer.lease.assert_agent_may_act(profile_key=str(home))
                await native_watchdog(self, dialog_id)
                return
        except (ComputerError, lease.HumanHasControl):
            self._dialog_watchdogs[dialog_id] = asyncio.get_running_loop().call_later(
                1.0, lambda: asyncio.create_task(self._dialog_timeout_expired(dialog_id)))
    DialogSupervisionMixin._dialog_timeout_expired = guarded_watchdog
    # Force the fixed resource rather than an optional profile's browser-extension controller.
    if not modern:
        router.routed_browser_handler = lambda action, args, *, fallback, **kwargs: fallback()
        bt.routed_browser_handler = router.routed_browser_handler
        browser_cdp_tool.routed_browser_handler = router.routed_browser_handler
    native_dispatch = registry.dispatch
    @functools.wraps(native_dispatch)
    def dispatch(name, args, **kwargs):
        if not (name == "computer_use" or name.startswith("browser_")):
            return native_dispatch(name, args, **kwargs)
        # Persistent external browser ownership is not delegated through raw CDP.
        if name == "browser_cdp" and str(args.get("method", "")) == "Browser.close":
            return json.dumps({"success": False, "error": "The household browser is persistent. Close a tab instead."})
        from hermes_constants import get_hermes_home, profile_name_for_home
        profile_home = get_hermes_home()
        profile = profile_name_for_home(profile_home) or "Assistant"
        if name == "browser_exec":
            args = dict(args)
            identity = str(profile_home) + "\0" + str(kwargs.get("task_id") or "default") + "\0" + str(args.get("session") or "default")
            args["session"] = "household-" + hashlib.sha256(identity.encode()).hexdigest()[:32]
        try:
            with computer.bot_operation(profile):
                # Native eval guards skip all checks for local backends. Keep
                # the metadata floor for explicit literals using native parsing.
                expression, target = "", ""
                if name == "browser_console":
                    expression = args.get("expression", "")
                elif name == "browser_cdp":
                    params = args.get("params") or {}
                    if args.get("method") == "Page.navigate":
                        target = str(params.get("url") or "").strip()
                    elif args.get("method") == "Runtime.evaluate":
                        expression = params.get("expression", "")
                found_literals = literals(expression) if isinstance(expression, str) else []
                urls = ([target] if target else []) + [literal.rstrip(".,;") for literal in found_literals]
                if any(url_safety.is_always_blocked_url(url) for url in urls):
                    return json.dumps({"success": False, "error": "Blocked: URL targets a cloud metadata endpoint"})
                return native_dispatch(name, args, **kwargs)
        except (ComputerError, lease.HumanHasControl) as exc:
            return json.dumps({"success": False, "error": str(exc)})
    registry.dispatch = dispatch
    registry._agent_interface_computer = computer
    return computer


def install(server):
    computer = install_tools()
    def request(rid, params):
        try:
            if computer is None:
                if params.get("action", "status") != "status":
                    raise ComputerError("The household computer is not configured on this Hermes host.")
                return server._ok(rid, {"available": False, "running": False, "browserReady": False,
                    "label": "Household computer", "reason": "The household computer is not configured on this Hermes host.",
                    "control": {"kind": "idle"}, "terminal": {"available": False, "target": "Hermes host"}})
            return server._ok(rid, computer.request(params))
        except ComputerError as exc:
            return server._err(rid, 409, str(exc))
    server.register_method("agent-interface.computer", request)
    if computer is None:
        return
    native_ask = server._ask
    @functools.wraps(native_ask)
    def ask(method, sid, params, timeout=300):
        if method not in ("vault.save_login", "vault.code", "vault.unlock_prompt", "secret"):
            return native_ask(method, sid, params, timeout=timeout)
        with computer.suspend_for_prompt():
            return native_ask(method, sid, params, timeout=timeout)
    server._ask = ask
    # Official display viewers must receive the same home in their native tickets.
    # Unwrap the qualified profile decorator only for display resource operations.
    for name, handler in list(server._methods.items()):
        if not name.startswith("display."):
            continue
        if name in ("display.lease.acquire", "display.lease.release", "display.stop", "display.install", "display.switchSandboxImage"):
            server.register_method(name, lambda rid, params: server._err(rid, 409, "Manage the shared household computer from WildBots."))
            continue
        cells = dict(zip(handler.__code__.co_freevars, handler.__closure__ or ()))
        if "handler" not in cells or not callable(cells["handler"].cell_contents):
            raise ComputerError("Native display profile wrapper requires qualification.")
        native = cells["handler"].cell_contents
        def shared(rid, params, _native=native):
            with resource_scope(computer.home):
                return _native(rid, params)
        server.register_method(name, shared)
