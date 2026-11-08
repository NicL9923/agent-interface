#!/usr/bin/env python3
"""Renew the private Google verification session that guarded releases use.

Run on a desktop with a browser. It prints a local start link that begins Hermes's RFC 8252
native sign-in with PKCE and a loopback redirect when clicked, so Hermes's ten-minute sign-in
window opens only then. It waits up to an hour for an allowed household member, redeems
the one-time code at /auth/native/token, and writes the session over SSH to the host file the
release tooling reads (deploy-config googleSessionFile). The write takes the same owner-private
lock and atomic replace as the host's live-google-check.py. Tokens are never printed.

    python3 .agents/tools/renew-google-verification-session.py --host hermes-prod \\
        --session-file /home/nicolas/.local/share/agent-interface/shared/google-session.json
"""
import argparse
import base64
import hashlib
import http.server
import json
import secrets
import shlex
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

ORIGIN = "https://agent.wildflowersranch.com"
PROVIDER = "google-family"
WAIT_SECONDS = 3600

# Runs on the host: reads the session JSON from stdin and replaces the file under its lock.
HOST_WRITE = r'''
import fcntl, json, os, stat, sys, tempfile
from pathlib import Path
path = Path(sys.argv[1])
value = json.load(sys.stdin)
lock = os.open(str(path) + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
info = os.fstat(lock)
if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
    sys.exit("Google session lock must be owner-private")
fcntl.flock(lock, fcntl.LOCK_EX)
fd, name = tempfile.mkstemp(prefix=".google-session-", dir=path.parent)
try:
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    os.fsync(directory)
    os.close(directory)
finally:
    if os.path.exists(name):
        os.unlink(name)
print("written")
'''


def pkce():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def wait_for_code(state, authorize):
    """Serve /start, which redirects to Hermes, and one /callback. Rejects a mismatched state."""
    result = {}
    done = threading.Event()

    class Callback(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            path = urllib.parse.urlsplit(self.path).path
            if path == "/start" and not done.is_set():
                # Each click starts a fresh Hermes sign-in window with the same PKCE challenge.
                self.send_response(302)
                self.send_header("Location", authorize(self.server.server_address[1]))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path != "/callback":
                self.send_error(404)
                return
            if query.get("state", [""])[0] != state or not query.get("code"):
                result["error"] = "The sign-in answer did not match this request."
            else:
                result["code"] = query["code"][0]
            body = ("Signed in. You can close this tab." if "code" in result else result["error"]).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            done.set()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Callback)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, done, result


def redeem(origin, code, verifier):
    request = urllib.request.Request(origin + "/auth/native/token", method="POST",
                                     data=json.dumps({"code": code, "code_verifier": verifier}).encode(),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    if payload.get("provider") != PROVIDER or not payload.get("access_token") or not payload.get("refresh_token"):
        raise SystemExit("Hermes did not return a Google session with a refresh token.")
    return payload


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--host", required=True, help="SSH alias of the Hermes host")
    parser.add_argument("--session-file", required=True, help="absolute host path of googleSessionFile")
    parser.add_argument("--origin", default=ORIGIN)
    parser.add_argument("--open", action="store_true", help="also open the start link in the default browser")
    args = parser.parse_args()
    origin = args.origin.rstrip("/")
    if not args.session_file.startswith("/"):
        parser.error("--session-file must be an absolute host path")

    verifier, challenge = pkce()
    state = secrets.token_urlsafe(24)

    def authorize(port):
        return origin + "/auth/native/authorize?" + urllib.parse.urlencode({
            "provider": PROVIDER, "code_challenge": challenge, "code_challenge_method": "S256",
            "redirect_uri": f"http://127.0.0.1:{port}/callback", "state": state})

    server, done, result = wait_for_code(state, authorize)
    start = f"http://127.0.0.1:{server.server_address[1]}/start"
    print("On this computer, open this link and sign in with an allowed household Google account:")
    print(start, flush=True)
    if args.open:
        webbrowser.open(start)
    if not done.wait(WAIT_SECONDS):
        server.shutdown()
        raise SystemExit("No sign-in finished within an hour.")
    server.shutdown()
    if "error" in result:
        raise SystemExit(result["error"])

    session = {**redeem(origin, result["code"], verifier), "url": origin}
    # SSH joins arguments into one remote shell line, so the script travels base64-encoded.
    script = base64.b64encode(HOST_WRITE.encode()).decode()
    remote = f"python3 -I -c 'import base64; exec(base64.b64decode(\"{script}\"))' {shlex.quote(args.session_file)}"
    written = subprocess.run(["ssh", args.host, remote],
                             input=json.dumps(session), text=True, capture_output=True, timeout=60, check=False)
    if written.returncode or written.stdout.strip() != "written":
        raise SystemExit("Writing the session on the host failed: " + (written.stderr.strip()[-300:] or "no detail"))
    print(f"Renewed the {PROVIDER} verification session on {args.host}.")


if __name__ == "__main__":
    sys.exit(main())
