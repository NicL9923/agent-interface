"""Real native preflight and owned Chrome rehearsal in a marked disposable HOME.

Set HERMES_COMPUTER_PROBE_BROWSER to a sandboxed Chrome executable. No live
profile, desktop service, credentials or remote device is used. Only the native
desktop start is a fixture, since macOS has no Linux Bot Desktop.
"""
import contextlib
import http.server
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import threading
import time

home = Path(os.environ.get("HERMES_HOME", ""))
if (not home.is_absolute() or Path.home() != home
        or (home / ".agent-interface-isolated").read_text() != "agent-interface-disposable-spike"):
    raise SystemExit("Local-network probe requires the same marked disposable HOME and HERMES_HOME")
root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("computer_local_network_addon", root / "src/hermes/computer.py")
addon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(addon)
with socket.socket() as port:
    port.bind(("127.0.0.1", 0))
    endpoint = "http://127.0.0.1:" + str(port.getsockname()[1])
resource = home / "computer"
os.environ.update(HERMES_AGENT_INTERFACE_COMPUTER_HOME=str(resource),
    HERMES_AGENT_INTERFACE_COMPUTER_CDP_URL=endpoint)
(home / "config.yaml").write_text(json.dumps({"plugins": {"enabled": []}}))

from hermes_constants import set_hermes_home_override, reset_hermes_home_override
from tools import browser_tool as bt, browser_tool_cloud as cloud, browser_tool_cdp as cdp, browser_use_cli
from tools.bot_desktop import runtime
from tools.registry import registry
from tools.browser_supervisor import SUPERVISOR_REGISTRY
from tools.terminal_scope import (build_profile_terminal_scope, set_terminal_scope,
    reset_terminal_scope, TerminalPolicyRefusal)

computer = addon.install_tools()
runtime.start = lambda: None
checks = {}
decisions = {}
kvm = "https://comet-pro-kvm.mesh.wildflowersranch.com"
private = "https://100.100.0.5"

@contextlib.contextmanager
def profile(name, *, authorized=False, terminal="local", website=False, scope=True):
    path = home / "profiles" / name
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    config = {"browser": {"cloud_provider": "local", "engine": "chrome", "allow_private_urls": False,
        "agent_interface": {"allow_local_network": authorized}}, "terminal": {"backend": terminal},
        "security": {"website_blocklist": {"enabled": True, "domains": ["100.100.0.5"] if website else []}}}
    (path / "config.yaml").write_text(json.dumps(config))
    token = set_hermes_home_override(str(path))
    policy = set_terminal_scope(build_profile_terminal_scope(path) if scope else None)
    try:
        yield
    finally:
        reset_terminal_scope(policy)
        reset_hermes_home_override(token)

def blocked(url=private):
    error = bt.evaluate_url_safety(url)
    assert error and "private or internal" in error["error"], error
    return error["error"]

def write_receipt(status):
    source = Path(bt.__file__).resolve().parents[1]
    result = {"status": status, "checks": checks, "decisions": decisions,
        "desktopHardware": "native desktop start fixture; actual disposable Chrome and native policy/dispatch",
        "revision": subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip(),
        "trackedPatchSha256": hashlib.sha256(subprocess.check_output(
            ["git", "-c", "core.abbrev=10", "-C", str(source), "diff", "HEAD"])).hexdigest()}
    (home / "computer-local-network-probe.json").write_text(json.dumps(result, indent=2) + "\n")
    return result

child = None
recovery = []
server = None
try:
    with profile("patch", authorized=True):
        decisions["authorized_without_registration"] = blocked()
    chrome = os.environ["HERMES_COMPUTER_PROBE_BROWSER"]
    child = subprocess.Popen([chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--user-data-dir=" + str(resource / "chrome"),
        "--remote-debugging-port=" + str(endpoint.rsplit(":", 1)[1]), "--remote-debugging-address=127.0.0.1",
        "about:blank"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=(home / "chrome.log").open("w"))
    deadline = time.monotonic() + 25
    while not computer._browser_ready():
        assert child.poll() is None and time.monotonic() < deadline, "Disposable Chrome did not start"
        time.sleep(.1)
    # An actual local Chrome is still insufficient without supervisor provenance.
    with profile("patch", authorized=True):
        decisions["arbitrary_loopback_browser"] = blocked()
    computer.register_browser(child)
    assert computer.verified_local_browser()
    checks["live_owned_browser_registration"] = True
    # A gateway-side reader must validate a different process's registration.
    subprocess.run([sys.executable, "-c", "import importlib.util, sys; "
        "spec = importlib.util.spec_from_file_location('checker', sys.argv[1]); "
        "addon = importlib.util.module_from_spec(spec); spec.loader.exec_module(addon); "
        "home, endpoint = addon.configured(); "
        "assert addon.Computer(home, endpoint, None, None).verified_local_browser()",
        str(root / "src/hermes/computer.py")], check=True, timeout=15)
    checks["separate_process_verifies_supervisor_registration"] = True
    with profile("patch", authorized=True):
        for url in (private, kvm):
            assert bt.evaluate_url_safety(url) is None
            assert browser_use_cli._code_url_verdict(f'goto_url("{url}")').blocked is None
        assert not cloud._allow_private_urls()
        decisions["authorized_owned_local_browser"] = "admitted by real native URL and browser_exec preflight"
        for url in ("http://169.254.169.254/latest/meta-data", "http://169.254.170.2",
                    "http://metadata.google.internal"):
            assert "metadata" in bt.evaluate_url_safety(url)["error"]
            assert "metadata" in browser_use_cli._code_url_verdict(f'goto_url("{url}")').blocked
        checks["navigation_and_browser_exec_metadata_floor_preserved"] = True
        for name, args in (
            ("browser_console", {"expression": 'fetch("http://169.254.169.254/latest/meta-data")'}),
            ("browser_cdp", {"method": "Page.navigate", "params": {"url": "http://169.254.170.2"}}),
            ("browser_cdp", {"method": "Runtime.evaluate", "params": {
                "expression": 'fetch("http://metadata.google.internal")'}}),
        ):
            result = json.loads(registry.dispatch(name, args, task_id="metadata-literal-probe"))
            assert not result["success"] and "metadata" in result["error"], result
        checks["dispatch_console_and_cdp_metadata_literals_blocked"] = True
        from tools import browser_tool_eval_policy
        assert not browser_tool_eval_policy._eval_ssrf_guard_active("metadata-literal-probe")
        checks["native_local_current_page_guard_gap_confirmed"] = True
        original_override = cdp._get_cdp_override_raw
        try:
            for arbitrary in ("http://external.example:9222", "http://127.0.0.1:1"):
                cdp._get_cdp_override_raw = lambda _url=arbitrary: _url
                assert not cloud._is_local_backend()
                blocked()
        finally:
            cdp._get_cdp_override_raw = original_override
        checks["arbitrary_remote_and_loopback_cdp_untrusted"] = True
    for name in ("other", "patch-disabled", "other-again"):
        with profile(name):
            decisions[name] = blocked(kvm)
            assert browser_use_cli._code_url_verdict(f'goto_url("{private}")').blocked
    checks["unrelated_profiles_and_disabled_consent_blocked"] = True
    with profile("patch"):
        decisions["patch_consent_revoked"] = blocked(kvm)
    for terminal in ("ssh", "docker", "modal", "singularity"):
        with profile("patch-" + terminal, authorized=True, terminal=terminal):
            decisions[terminal + "_terminal"] = blocked()
    with profile("patch-missing-scope", authorized=True, scope=False):
        blocked()
    with profile("patch-refused-scope", authorized=True):
        policy = set_terminal_scope(TerminalPolicyRefusal("probe unreadable config"))
        try:
            blocked()
        finally:
            reset_terminal_scope(policy)
    checks["remote_container_missing_and_refused_terminal_policy_blocked"] = True
    with profile("patch-website", authorized=True, website=True):
        assert "website policy" in bt.evaluate_url_safety(private)["error"]
        assert "website policy" in browser_use_cli._code_url_verdict(f'goto_url("{private}")').blocked
    checks["native_website_policy_preserved"] = True
    record = computer._read("computer-browser.json", None)
    computer._write("computer-browser.json", {**record, "websocket": record["websocket"] + "wrong-generation"})
    with profile("patch", authorized=True):
        blocked()
    computer._write("computer-browser.json", record)
    checks["browser_generation_mismatch_blocked"] = True

    # Native registry/lease dispatch is still real for an authorized profile.
    with profile("patch", authorized=True):
        viewer = "disposable-local-network-viewer"
        computer.lease.acquire(viewer, profile_key=str(resource))
        try:
            result = json.loads(registry.dispatch("browser_exec", {"code": f'goto_url("{private}")'}))
            assert not result["success"] and "human" in result["error"].lower(), result
        finally:
            computer.lease.release(viewer, profile_key=str(resource))
        with computer.operation():
            # The second open-file lock must refuse even in this process.
            try:
                with computer.operation(timeout=0):
                    raise AssertionError("The operation lock admitted a second owner")
            except addon.ComputerError:
                pass
    checks["authorized_profile_still_obeys_human_and_operation_fences"] = True
    write_receipt("policy_verified_browser_acceptance_pending")

    # Self-signed loopback TLS fixture. No HTTP request may cross the failed handshake.
    key, certificate = home / "tls-key.pem", home / "tls-cert.pem"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost", "-keyout", str(key), "-out", str(certificate)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    requests = []
    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 2
        def handle(self):
            try:
                super().handle()
            except (ssl.SSLError, ConnectionError, TimeoutError):
                pass  # Chrome's rejected handshake is the expected outcome.
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200); self.end_headers(); self.wfile.write(b"TLS must not reach this")
        def log_message(self, *args): pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(certificate, key)
    # Chrome can preconnect without completing a handshake. Let each request
    # thread do its own handshake rather than blocking the accept loop.
    server.socket = tls.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    native_cli = computer._run_harness_cli
    def observed_cli(command, code, env, timeout):
        result = native_cli(command, code, env, timeout)
        recovery.append(computer._read("computer-recovery.json", None))
        return result
    computer._run_harness_cli = observed_cli
    tls_url = "https://127.0.0.1:" + str(server.server_port)
    with profile("patch", authorized=True):
        result = json.loads(registry.dispatch("browser_exec", {
            "code": f'import json\nprint(json.dumps(goto_url("{tls_url}")))',
            "timeout_s": 30}, task_id="local-network-probe"))
        assert result.get("success"), result
        checks["real_native_browser_exec_uses_owned_browser"] = True
        navigation = json.loads(result["output"].strip())
        error = navigation.get("errorText", "")
        assert "ERR_CERT_" in error, navigation
        assert requests == [], requests
        decisions["invalid_tls"] = error
    checks["real_native_browser_exec_rejects_invalid_tls"] = True
finally:
    try:
        for record in recovery:
            assert computer.recover_harness(record), "Disposable browser daemon recovery failed"
    finally:
        SUPERVISOR_REGISTRY.stop_all()
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
        if server is not None:
            server.shutdown(); server.server_close()
        (computer.state / "computer-browser.json").unlink(missing_ok=True)

with profile("patch", authorized=True):
    assert not computer.verified_local_browser()
    blocked()
checks["shutdown_revokes_provenance"] = True
print(json.dumps(write_receipt("passed"), indent=2))
