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
import ipaddress
import json
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import time
import threading
from urllib.parse import unquote_to_bytes, urlsplit
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


# This matcher is defense in depth: literal text cannot show every URL a script builds. See
# docs/SharedComputer.md for the network-level control.
#
# WHATWG URL parsing removes tabs and newlines anywhere, reads a special scheme case-insensitively,
# treats "\" as "/" and accepts any number of slashes, none included, before the authority:
# "http:/169.254.169.254/", "HTTP:169.254.169.254" and "http:\\169.254.169.254" all reach that host
# from a page with another scheme. Native Hermes's literal scan finds only "http(s)://" and "//host".
# A JavaScript string spells the same forms with "\/" or the "\t", "\n" and "\r" escapes.
_SCHEME_COLON_RE = re.compile(r"(?<![A-Za-z0-9+.\-])(?:https?|wss?):[/\\]*", re.IGNORECASE)
_URL_WHITESPACE_RE = re.compile(r"\\[tnr]|[\t\n\r]")
# A special-scheme authority ends at the first of these.
_AUTHORITY_END = frozenset("/\\?#\n")
# Where a literal in script text plausibly ends: a quote or whitespace. WHATWG would read on, but a
# host holding one of these is either rejected or no metadata host. Userinfo may hold them, so an "@"
# after one is read as well.
_SOFT_END = frozenset("'\"`<> \t\r\f\v")


def _first(text, characters, start=0):
    return next((index for index in range(start, len(text)) if text[index] in characters), len(text))


def scheme_colon_hosts(text):
    """Each host a special-scheme URL literal in text can name, read as WHATWG reads an authority.

    The userinfo ends at the last "@" before the first "/", "\\", "?" or "#", and a bracketed host stays
    whole. When an "@" follows a quote or space inside that span, both readings come back. A scheme
    inside an earlier literal, such as a query parameter, is part of that literal, as native reads it.
    """
    if not isinstance(text, str):
        return []
    hosts = []
    for variant in dict.fromkeys((text, _URL_WHITESPACE_RE.sub("", text.replace("\\/", "/")))):
        consumed = 0
        for match in _SCHEME_COLON_RE.finditer(variant):
            if match.start() < consumed:
                continue
            start = match.end()
            span = variant[start:_first(variant, _AUTHORITY_END, start)]
            consumed = _first(variant, _SOFT_END, start)
            soft = _first(span, _SOFT_END)
            readings = [span[:soft]] + ([span] if "@" in span[soft:] else [])
            for authority in readings:
                host = authority.rpartition("@")[2]
                host = host[:_first(host, _SOFT_END)]
                if host:
                    hosts.append(host)
    return list(dict.fromkeys(hosts))


# IPv6 prefixes that carry an IPv4 address in their low 32 bits: IPv4-compatible (::/96), the
# NAT64 well-known prefix and 6to4 (bits 16-48). Native already reads IPv4-mapped and -translated.
_NAT64 = ipaddress.IPv6Network("64:ff9b::/96")


def embedded_ipv4(ip):
    """IPv4 addresses an IPv6 address can stand for."""
    found = [ip.ipv4_mapped, ip.sixtofour]
    if ip in _NAT64 or (int(ip) >> 32 == 0 and int(ip) > 0xFFFF):
        found.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    if int(ip) >> 32 == 0xFFFF0000:  # ::ffff:0:a.b.c.d
        found.append(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
    return [address for address in found if address is not None]


# WHATWG forbidden domain code points: a special-scheme host holding one is a parse failure.
_FORBIDDEN_DOMAIN = frozenset("\x00\t\n\r #/:<>?@[\\]^|%\x7f") | frozenset(chr(code) for code in range(0x20))


def uts46_ascii(name):
    """WHATWG domain to ASCII for a non-ASCII name: UTS 46 mapping, nontransitional, without STD3 rules.

    None when the ``idna`` package is missing or cannot map the name. The caller then blocks.
    """
    try:
        import idna
    except ImportError:
        return None
    try:
        mapped = idna.uts46_remap(name, std3_rules=False, transitional=False)
        return mapped if mapped.isascii() else idna.encode(mapped, uts46=False).decode("ascii")
    except (idna.IDNAError, UnicodeError, ValueError):
        return None


def host_targets_metadata(host, judge):
    """Whether a host from ``scheme_colon_hosts`` is one WHATWG accepts and that names a metadata address.

    ``judge`` is native ``literal_targets_metadata``, which reads metadata names and every IPv4
    spelling without DNS. A host WHATWG rejects fetches nothing and passes: an unclosed, empty or
    invalid bracketed host such as ``[]`` from ``{https:[]}``, an empty host, a non-numeric port or a
    forbidden code point. A non-ASCII name goes through UTS 46 first; one it can't map is blocked.
    """
    if host.startswith("["):
        inner, closed, after = host[1:].partition("]")
        if not closed or not re.fullmatch(r"(?::[0-9]*)?", after):
            return False
        try:
            ip = ipaddress.IPv6Address(inner)
        except ValueError:
            return False
        return judge("//[" + inner + "]/") or any(judge("//" + str(address) + "/") for address in embedded_ipv4(ip))
    name, colon, port = host.rpartition(":")
    if not colon:
        name = host
    elif port and not port.isdigit():
        return False
    name = unquote_to_bytes(name).decode("utf-8", "replace")
    if not name:
        return False
    if not name.isascii():
        name = uts46_ascii(name)
        if name is None:
            return True
    name = name.lower()
    if not name or any(c in _FORBIDDEN_DOMAIN for c in name):
        return False
    return judge("//" + name + "/")


def param_strings(value):
    """Every string in CDP params at any depth."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in param_strings(item)]
    if isinstance(value, (list, tuple)):
        return [text for item in value for text in param_strings(item)]
    return []


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
        if action == "handoff":
            return decline_handoff(params)
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
        from tools import browser_session_cdp as cdp, browser_session_cloud as cloud, browser_url_policy as browser_policy, browser_cdp_tool
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
        # Native browser_cdp's own metadata floor: every URL a fetching method's params name,
        # including scheme-relative //host and userinfo forms, judged without DNS for //host.
        required += ((cdp, dialog_name), (browser_policy, "url_literals"), (browser_policy, "literal_targets_metadata"),
                     (browser_cdp_tool, "_fetched_param_urls"))
        # Native's methods whose params are never fetched: text input, block lists, cookie scopes.
        if (not isinstance(getattr(browser_cdp_tool, "_TEXT_INPUT_METHOD_PREFIX", None), str)
                or not isinstance(getattr(browser_cdp_tool, "_CDP_NON_FETCHING_METHODS", None), frozenset)):
            raise ComputerError("Shared computer native tool seams require qualification.")
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
    def metadata_target(name, args):
        """Whether the call names a cloud metadata address. Native eval guards skip all checks for
        local backends, so this keeps the metadata floor for explicit literals using native parsing."""
        if name == "browser_cdp" and modern:
            # The same URLs and matcher native browser_cdp applies before its private-address guard.
            params = args.get("params") or {}
            method = args.get("method")
            if not isinstance(params, dict) or not isinstance(method, str):
                return False
            judge = browser_policy.literal_targets_metadata
            if any(judge(url) for url in browser_cdp_tool._fetched_param_urls(method, params)):
                return True
            if method.startswith(browser_cdp_tool._TEXT_INPUT_METHOD_PREFIX) or method in browser_cdp_tool._CDP_NON_FETCHING_METHODS:
                return False
            # Forms native's scan misses that a browser still reads as a special-scheme authority.
            return any(host_targets_metadata(host, judge) for text in param_strings(params) for host in scheme_colon_hosts(text))
        # An older revision: its browser_console expression and the two CDP methods it can fetch with.
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
        return any(url_safety.is_always_blocked_url(url) for url in urls)
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
                if metadata_target(name, args):
                    return json.dumps({"success": False, "error": "Blocked: URL targets a cloud metadata endpoint"})
                return native_dispatch(name, args, **kwargs)
        except (ComputerError, lease.HumanHasControl) as exc:
            return json.dumps({"success": False, "error": str(exc)})
    registry.dispatch = dispatch
    registry._agent_interface_computer = computer
    return computer


HANDOFF = "agent_interface.computer_handoff"
HANDOFF_TOOL = "computer_request_handoff"
# A card nobody takes over closes after this long. Once someone has control, it waits for them.
HANDOFF_WAIT = 600
# How long a handoff about to be sent keeps the watcher alive before its ask registers.
HANDOFF_REGISTER = 5
HIDDEN = re.compile(r"[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]")
_journal = None
_handoffs_lock = threading.Lock()
# Open handoff request ID -> {"opened": monotonic time, "taken": bool}, while the watcher runs.
_handoffs = {}
_watcher = None


def bind_journal(journal):
    """The add-on journal, which maps a live session to its profile and tells whether a person is waiting."""
    global _journal
    _journal = journal


def handoff_failure(error_type, message):
    return json.dumps({"success": False, "error_type": error_type, "error": message})


def person_waiting(sid, journal=None):
    """A member's app message started this session's current turn, so someone can see the card."""
    journal = journal or _journal
    if journal is None:
        return False
    profile = journal.live_profile_for_session(sid)
    if profile is None or journal.canonical_session(profile) != sid:
        return False
    with journal.lock:
        return journal.db.execute("SELECT 1 FROM receipts WHERE session_id=? AND terminal=0 AND steering=0 LIMIT 1",
                                  (sid,)).fetchone() is not None


def handoff_text(args, name, limit):
    value = " ".join(args.get(name).split()) if isinstance(args.get(name), str) else ""
    if not 1 <= len(value) <= limit or HIDDEN.search(value):
        raise ComputerError(f"Give {name} as 1 to {limit} visible characters.")
    return value


def settle_handoff(request_id, outcome):
    from tui_gateway import server_requests
    return server_requests.resolve_response({"jsonrpc": "2.0", "id": request_id, "result": {"value": outcome}})


def watch_handoffs(computer):
    """Settles open handoffs from the lease: taken once a person holds the computer, handed back when they release it.

    The lease is the one record every path shares: the card, Settings > Computer, a closed
    viewer and the iOS screen. Any takeover answers every open handoff, because each asked a
    person to use the same computer.
    """
    global _watcher
    from tui_gateway import server_requests
    while True:
        try:
            human = computer._lease().holder == computer.lease.HUMAN
        except Exception:
            human = False
        now, settle = time.monotonic(), []
        with server_requests._lock:
            open_ids = {request_id for request_id, request in server_requests._open.items() if request.method == HANDOFF}
        with _handoffs_lock:
            for request_id in list(_handoffs):
                if request_id not in open_ids and now - _handoffs[request_id]["opened"] > HANDOFF_REGISTER:
                    _handoffs.pop(request_id)
            for request_id in open_ids:
                state = _handoffs.setdefault(request_id, {"opened": now, "taken": False})
                if human:
                    state["taken"] = True
                elif state["taken"]:
                    settle.append((request_id, "handed_back"))
                elif now - state["opened"] >= HANDOFF_WAIT:
                    settle.append((request_id, "timed_out"))
            for request_id, _ in settle:
                _handoffs.pop(request_id, None)
            # Decided under the lock a new ask's placeholder takes, so a handoff registered after
            # this starts its own watcher.
            done = not _handoffs
            if done:
                _watcher = None
        # Settle before exiting: the last handoff's outcome is what lets its tool return.
        for request_id, outcome in settle:
            settle_handoff(request_id, outcome)
        if done:
            return
        time.sleep(.5)


def start_handoff_watch(computer):
    global _watcher
    with _handoffs_lock:
        # The watcher exits once nothing is open. This placeholder keeps it running until the ask
        # about to be sent registers, and it is added under the lock the exit decision takes.
        _handoffs["pending:" + secrets.token_hex(8)] = {"opened": time.monotonic(), "taken": False}
        if _watcher is None:
            _watcher = threading.Thread(target=watch_handoffs, args=(computer,), name="agent-interface-computer-handoff", daemon=True)
            _watcher.start()


HANDOFF_RESULTS = {
    "handed_back": dict(success=True, status="handed_back", next=(
        "A person took control of the household computer and has handed it back. They may have changed the "
        "screen, the open page or the signed-in account, and may or may not have done what you asked. Take a new "
        "screenshot or page snapshot before acting, check whether the step is done, and tell the user what you "
        "found.")),
    "declined": dict(success=False, error_type="declined", error=(
        "The person chose Not now, so nobody used the computer. Continue without that step, or tell them what it "
        "blocks. Do not ask again unless they ask you to.")),
    "timed_out": dict(success=False, error_type="timed_out", error=(
        "Nobody took over the computer within 10 minutes, so the request closed. Tell the user what is waiting and "
        "ask them to reply when they are ready.")),
}


def request_handoff(computer, args, **_kwargs):
    """Asks a person in WildBots to take over the household computer, and waits until they hand it back."""
    vault = sibling_module("vault")
    try:
        if not isinstance(args, dict) or set(args) - {"reason", "what_to_do"}:
            raise ComputerError("Pass only reason and what_to_do.")
        reason, todo = handoff_text(args, "reason", 200), handoff_text(args, "what_to_do", 300)
    except ComputerError as error:
        return handoff_failure("invalid_arguments", str(error))
    from gateway.session_context import get_session_env
    sid = get_session_env("HERMES_UI_SESSION_ID")
    if not sid or not person_waiting(sid):
        return handoff_failure("no_person", "Nobody is waiting in this WildBots conversation to take over, as in a "
                               "scheduled or messaging run. Tell the user what needs a person on the household computer "
                               "and ask them to open Computer in WildBots when they can.")
    try:
        status = computer.status()
    except ComputerError as error:
        status = {"available": False, "reason": str(error)}
    if not status.get("available") or not status.get("running") or status.get("reason"):
        return handoff_failure("computer_unavailable", "The household computer cannot be taken over right now: "
                               + (status.get("reason") or "it is not running.") + " Tell the user what is blocked.")
    from tui_gateway import server_requests
    start_handoff_watch(computer)
    with vault.watched_asks() as asks:
        # Bot computer actions stay paused for the person; this tool holds no browser lock of its own.
        with computer.suspend_for_prompt():
            result = server_requests.send(HANDOFF, sid, {"reason": reason, "what_to_do": todo}, timeout=None)
    value = (result or {}).get("value", "")
    if value in HANDOFF_RESULTS:
        return json.dumps(HANDOFF_RESULTS[value])
    if vault.replied_in_chat(asks):
        return handoff_failure("user_replied_in_chat", "The user sent a chat message instead of taking over, so the "
                               "request closed and nobody used the computer. Their message is the next user message: read "
                               "it before doing anything else. If they still want help, ask again with what they corrected.")
    return handoff_failure("cancelled", "The request closed without an answer, for example because the task was "
                           "stopped. Do not continue the step that needed a person.")


HANDOFF_SCHEMA = dict(name=HANDOFF_TOOL, description=(
    "Ask a person to take over the household computer. Use it for a step you cannot or should not do yourself: a "
    "CAPTCHA, a sign-in that needs their phone or a passkey, a payment or purchase confirmation, or a choice only they "
    "can make. Use it only while your task uses the household computer's browser or desktop, and leave the screen on "
    "the step they need. "
    "The person sees a card in WildBots with your reason and what you want them to do, and buttons for Take over and "
    "Not now. While they have control, your browser and computer actions are refused. The call waits until they hand "
    "the computer back. "
    "Results: status handed_back: take a new screenshot or snapshot before acting, because the screen may have "
    "changed, and check whether the step is done. declined: they chose Not now; continue without it or explain what "
    "it blocks, and do not ask again unless they ask you to. user_replied_in_chat: they sent a message instead; read "
    "it next and ask again only if they still want this. timed_out: nobody took over within 10 minutes; tell them "
    "what is waiting. computer_unavailable or no_person: nobody can take over now; explain what is blocked. "
    "invalid_arguments: fix the arguments and call again. cancelled: the task was stopped; do not continue that step. "
    "Never ask the person to type passwords or codes into chat; they type them on the computer itself."),
    parameters=dict(type="object", additionalProperties=False, required=["reason", "what_to_do"], properties=dict(
        reason=dict(type="string", description="Why you need a person, in one short sentence the user sees, such as "
                    "The bank wants a code from your phone. At most 200 characters."),
        what_to_do=dict(type="string", description="What the person should do before handing back, such as Enter the "
                        "code, then press Hand back. At most 300 characters."))))


def register_handoff(computer):
    """Registers the ask's wire contract and its tool. Older Hermes revisions without either seam get no tool."""
    from tui_gateway.contracts import registry as contracts
    from tui_gateway.contracts.server_requests import ServerRequestParams, ValueResult
    if HANDOFF not in contracts.SERVER_REQUESTS:
        class ComputerHandoffParams(ServerRequestParams):
            reason: str
            what_to_do: str
        contracts.server_request(HANDOFF, params=ComputerHandoffParams, result=ValueResult,
                                 doc="WildBots: ask a person to take over the household computer and hand it back.")
    from tools.registry import registry
    # An ask-the-user tool: it rides with clarify, and a session nobody can answer refuses at call time.
    registry.register(name=HANDOFF_TOOL, toolset="clarify", schema=HANDOFF_SCHEMA, emoji="🖥️",
                      handler=lambda args, **kwargs: request_handoff(computer, args, **kwargs))


def decline_handoff(params):
    """Not now on a handoff card. Only this executor's open handoff for that profile's conversation settles."""
    from tui_gateway import server_requests
    request_id, sid, epoch, profile = (params.get(key) for key in ("requestId", "sessionId", "epoch", "profile"))
    if params.get("decision") != "decline" or not all(isinstance(value, str) and 1 <= len(value) <= 200
                                                      for value in (request_id, sid, epoch, profile)):
        raise ComputerError("This computer request is invalid.")
    with server_requests._lock:
        request = server_requests._open.get(request_id)
    if request is None:
        return {"status": "expired"}
    journal = _journal
    if (journal is None or request.method != HANDOFF or request.sid != sid or epoch != journal.epoch
            or journal.live_profile_for_session(sid) != profile or journal.canonical_session(profile) != sid):
        raise ComputerError("This computer request changed. Refresh the conversation.")
    return {"status": "ok" if settle_handoff(request_id, "declined") else "expired"}


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
    try:
        register_handoff(computer)
    except ImportError:
        pass  # A revision without the contract seam keeps the computer without the handoff tool.
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
