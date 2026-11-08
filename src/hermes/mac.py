"""WildBots for Mac tools: personal assistants act on their owner's linked Mac.

Each tool asks the WildBots app server on this host, which routes the request to the Mac
over the Mac's own outbound link. The Mac decides what each assistant may do; see
docs/MacLink.md. The assistant is the profile of the running Hermes session, never a model
argument, and a run counts as unattended unless it is a WildBots chat with nothing scheduled.
"""
import base64
import ipaddress
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

TOOLSET = "wildbots_mac"
KEY_ENV = "HERMES_AGENT_INTERFACE_MAC_LINK_KEY"
URL_ENV = "HERMES_AGENT_INTERFACE_APP_URL"
ROUTE = "/api/agent-link/mac"
# The server waits an action's own timeout plus 15 seconds for the Mac; this leaves room for that answer.
SLACK_SECONDS = 30
QUICK_SECONDS = 60
SCREENSHOT_TTL_SECONDS = 3600


class LinkError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def configured(environ=None):
    """The app's loopback URL and the link key, or None when Mac links are not set up here."""
    environ = os.environ if environ is None else environ
    key, url = environ.get(KEY_ENV, ""), environ.get(URL_ENV, "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", key):
        return None
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        local = host == "localhost" or ipaddress.ip_address(host).is_loopback
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme != "http" or not local or not port or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
        return None
    return f"http://{parsed.netloc}", key


def session_context():
    """The running session's assistant and whether a person is in a WildBots chat with it."""
    from gateway.session_context import get_session_env
    from hermes_constants import get_hermes_home, profile_name_for_home
    home = get_hermes_home()
    attended = bool(get_session_env("HERMES_UI_SESSION_ID")) and not get_session_env("HERMES_CRON_SESSION")
    return dict(assistant=profile_name_for_home(home) or "default", home=Path(home), scheduled=not attended)


def failure(code, message, **details):
    return json.dumps({"ok": False, "error": dict(code=code, message=message, **details)})


def post(base, key, body, timeout, opener=urllib.request.urlopen):
    request = urllib.request.Request(base + ROUTE, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with opener(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise LinkError("link_misconfigured", "The WildBots app server refused this Hermes host's Mac link key. "
                            "Tell the user the installer must give the app and Hermes the same MAC_LINK_KEY.") from None
        if error.code == 400:
            try:
                issues = json.loads(error.read()).get("issues", [])
            except ValueError:
                issues = []
            raise LinkError("invalid_arguments", "The request was malformed" + (": " + ", ".join(map(str, issues)) if issues else ".")) from None
        raise LinkError("link_unreachable", f"The WildBots app server answered HTTP {error.code}. Try again shortly.") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        raise LinkError("link_unreachable", "The WildBots app server did not answer. Whether the action ran is unknown; "
                        "check before repeating anything that changes files.") from None


def save_screenshot(home, invocation_id, value, now=None):
    """Writes the PNG privately and returns where, so the image never fills the conversation as text."""
    now = time.time() if now is None else now
    folder = Path(home) / "cache" / "mac-screenshots"
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(folder, 0o700)
    for old in folder.glob("*.png"):
        try:
            if now - old.stat().st_mtime > SCREENSHOT_TTL_SECONDS:
                old.unlink()
        except OSError:
            pass
    data = base64.b64decode(value.get("pngBase64", ""), validate=True)
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("not a PNG")
    path = folder / (invocation_id + ".png")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as file:
        file.write(data)
    return {"path": str(path), "width": value.get("width"), "height": value.get("height"),
            "next": "Call vision_analyze with image_url set to this path to see it. It is deleted after an hour."}


# Each tool's arguments, beyond the optional device, and how long its call may take.
ARGUMENTS = {
    "mac_list": ("list", set()),
    "mac_run": ("run", {"command", "cwd", "timeoutSeconds"}),
    "mac_read_file": ("read_file", {"path", "offset", "length"}),
    "mac_write_file": ("write_file", {"path", "content", "encoding", "expectedSha256", "createOnly"}),
    "mac_list_dir": ("list_dir", {"path", "offset", "limit"}),
    "mac_screenshot": ("screenshot", set()),
}


def handle(tool, args, opener=urllib.request.urlopen, environ=None, context=None):
    setup = configured(environ)
    if setup is None:
        return failure("link_unavailable", "Mac links are not set up on this Hermes host.")
    action, allowed = ARGUMENTS[tool]
    if not isinstance(args, dict) or set(args) - allowed - {"device"}:
        return failure("invalid_arguments", "Pass only " + ", ".join(sorted(allowed | {"device"})) + ".")
    device = args.get("device")
    if device is not None and (not isinstance(device, str) or not 1 <= len(device) <= 200):
        return failure("invalid_arguments", "device must be a Mac's name from mac_list.")
    timeout = args.get("timeoutSeconds", 120) if action == "run" else QUICK_SECONDS
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 600:
        return failure("invalid_arguments", "timeoutSeconds must be a whole number from 1 to 600.")
    context = context or session_context()
    invocation_id = "inv-" + uuid.uuid4().hex
    body = {"invocationId": invocation_id, "assistantId": context["assistant"], "scheduled": context["scheduled"],
            "action": action, "args": {key: value for key, value in args.items() if key != "device"}}
    if device is not None:
        body["device"] = device
    try:
        result = post(*setup, body, timeout + 15 + SLACK_SECONDS, opener)
    except LinkError as error:
        return failure(error.code, str(error))
    if action == "screenshot" and result.get("ok"):
        try:
            result = {"ok": True, "value": save_screenshot(context["home"], invocation_id, result.get("value") or {})}
        except (ValueError, OSError):
            return failure("failed", "The Mac sent an image that could not be saved.")
    return json.dumps(result)


DEVICE = dict(type="string", description="The Mac's name from mac_list. Needed only when more than one Mac is linked.")
OUTCOMES = (" Results are {ok:true,value} or {ok:false,error:{code,message}}. Codes: not_allowed or unattended_not_allowed "
            "(the user has not allowed this in WildBots for Mac; tell them), paused, mac_offline (asleep or offline; try later), "
            "outside_folders or protected_path (only granted folders are reachable), uncertain (it may have run; check before "
            "repeating anything that changes files).")
SCHEMAS = {
    "mac_list": ("List the user's linked Macs: whether each is online, its granted folders and what you may do there. "
                 "Call this first to learn the folders.", {}),
    "mac_run": ("Run a shell command on the user's Mac with /bin/zsh, confined to the granted folders: it can read and write "
                "there and in a private temporary folder, read system and developer tools, and use the network. It cannot "
                "read the rest of the home folder or control other apps. Returns exitCode, stdout, stderr (last 64 KiB each) "
                "and timedOut.", {
                    "command": dict(type="string", description="The command line, up to 16384 characters."),
                    "cwd": dict(type="string", description="Working folder: absolute, ~/..., or relative to the first granted folder. Default the first granted folder."),
                    "timeoutSeconds": dict(type="integer", minimum=1, maximum=600, description="Default 120."),
                }),
    "mac_read_file": ("Read a file in a granted folder on the user's Mac. Text comes back as utf8, other files as base64. "
                      "Returns sha256 of the whole file; pass it to mac_write_file as expectedSha256 to replace exactly that version.", {
                          "path": dict(type="string"),
                          "offset": dict(type="integer", minimum=0, description="Byte offset. Default 0."),
                          "length": dict(type="integer", minimum=1, maximum=1048576, description="Bytes to read. Default 262144."),
                      }),
    "mac_write_file": ("Create or replace a file in a granted folder on the user's Mac, atomically. Up to 1 MiB.", {
                           "path": dict(type="string"),
                           "content": dict(type="string"),
                           "encoding": dict(type="string", enum=["utf8", "base64"], description="Default utf8."),
                           "expectedSha256": dict(type="string", description="Replace only if the file still has this sha256."),
                           "createOnly": dict(type="boolean", description="Fail if the file exists."),
                       }),
    "mac_list_dir": ("List a folder inside a granted folder on the user's Mac.", {
                         "path": dict(type="string"),
                         "offset": dict(type="integer", minimum=0),
                         "limit": dict(type="integer", minimum=1, maximum=500, description="Default 200."),
                     }),
    "mac_screenshot": ("Take a screenshot of the user's Mac's main display. It shows every visible app, so use it only when "
                       "the task needs the screen. Returns a file path for vision_analyze. Fails while the screen is locked.", {}),
}
REQUIRED = {"mac_run": ["command"], "mac_read_file": ["path"], "mac_write_file": ["path", "content"], "mac_list_dir": ["path"]}


def register():
    """Adds the tools to this process's registry and the toolset to the assistant tool checklist."""
    from tools.registry import registry
    from hermes_cli import tools_config
    if not any(row[0] == TOOLSET for row in tools_config.CONFIGURABLE_TOOLSETS):
        tools_config.CONFIGURABLE_TOOLSETS.append((TOOLSET, "WildBots Mac", "Act on your linked Mac: files, commands and screenshots, as WildBots for Mac allows"))
    for name, (description, properties) in SCHEMAS.items():
        parameters = dict(type="object", properties=dict(properties, device=DEVICE), additionalProperties=False)
        if name in REQUIRED:
            parameters["required"] = REQUIRED[name]
        schema = dict(name=name, description=description + OUTCOMES, parameters=parameters)
        registry.register(name=name, toolset=TOOLSET, schema=schema, emoji="💻",
                          handler=lambda args, _name=name, **_kwargs: handle(_name, args),
                          check_fn=lambda: configured() is not None)
