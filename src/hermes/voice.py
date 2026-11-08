"""Live voice: OpenAI Realtime client secrets on the household ChatGPT sign-in.

Two service-token routes, admitted only through src/hermes/service_auth.py:
  GET  /api/agent-interface/voice/status         {available, reason?}
  POST /api/agent-interface/voice/client-secret  {model, voice, instructions, tools}

The app sends only the parts it owns: the voice, a short persona and its one tool.
This module builds the rest of the Realtime session from fixed values, so a
caller cannot change the model, turn detection or transcription.

Hermes lets only code inside an installed plugin that declares requires_auth:
[openai-codex] make a request on that sign-in. The plugin is this release's
src/hermes/wildbots_voice, linked as <HERMES_HOME>/plugins/wildbots-voice by the
release activation. Its realtime.py is loaded through that link path, so the
frame Hermes checks names a file under the plugins root. Secrets are never logged.
"""
import asyncio
import importlib.util
import json
import os
import re
from pathlib import Path

PLUGIN = "wildbots-voice"
PLUGIN_SOURCE = Path(__file__).resolve().with_name("wildbots_voice")
MODEL = "gpt-realtime-2.1"
# src/shared/voice.ts TALK_VOICES must match.
VOICES = ("alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar")
MAX_INSTRUCTIONS = 6000
MAX_TOOLS = 4
MAX_TOOLS_JSON = 8 * 1024
TOOL_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
ENABLE_HINT = "Run `hermes plugins enable wildbots-voice` on the Hermes host, then restart the dashboard."


class VoiceError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def plugins_root():
    """The launch profile's plugins folder, where Hermes looks for installed plugins."""
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(home) / "plugins"


def plugin_state(root=None, source=PLUGIN_SOURCE):
    """(available, reason). Checks the link without contacting OpenAI or refreshing a sign-in."""
    link = (root or plugins_root()) / PLUGIN
    if not link.is_symlink() and not link.exists():
        return False, f"The WildBots voice plugin is not linked into Hermes at {link}. Activate a current WildBots release."
    try:
        target = link.resolve(strict=True)
    except (OSError, RuntimeError):
        return False, "The WildBots voice plugin link is broken. Activate a current WildBots release."
    if target != source.resolve():
        # A link to another release would run code this add-on was not qualified with.
        return False, "The WildBots voice plugin links to a different release than the running add-on. Activate the current release again."
    try:
        manifest = (link / "plugin.yaml").read_text()
    except OSError:
        return False, "The WildBots voice plugin has no readable manifest."
    if not declares_codex(manifest):
        return False, "The WildBots voice plugin manifest does not ask for the ChatGPT sign-in."
    # Hermes lets a linked plugin use the sign-in whether or not it is enabled, so enabling is
    # checked here: it is the person's consent, and disabling must stop new sessions at once.
    if not plugin_enabled():
        return False, "Enable the wildbots-voice plugin in Hermes. " + ENABLE_HINT
    if importlib.util.find_spec("hermes_cli.plugin_provider_requests") is None:
        return False, "This Hermes version cannot share its ChatGPT sign-in with plugins. Update Hermes."
    return True, None


def plugin_enabled():
    """Whether the launch profile's config enables the plugin, as Hermes's plugin loader decides.

    Uses Hermes's own readers of plugins.enabled and plugins.disabled in config.yaml, read on every
    call, so a change applies without a restart. Anything unreadable counts as not enabled.
    """
    try:
        from hermes_cli.plugins import _get_disabled_plugins, _get_enabled_plugins
        enabled, disabled = _get_enabled_plugins(), _get_disabled_plugins()
    except Exception:
        return False
    # None means the allow-list is missing or malformed: Hermes then loads nothing opt-in.
    return isinstance(enabled, set) and PLUGIN in enabled and isinstance(disabled, set) and PLUGIN not in disabled


def declares_codex(manifest):
    """Whether a plugin.yaml lists openai-codex under requires_auth, in block or flow style."""
    block = re.search(r"(?m)^requires_auth:[ \t]*\n((?:[ \t]+-[^\n]*\n?)+)", manifest)
    flow = re.search(r"(?m)^requires_auth:[ \t]*\[([^\]\n]*)\]", manifest)
    items = re.findall(r"-[ \t]*([^\s#]+)", block.group(1)) if block else [part.strip() for part in flow.group(1).split(",")] if flow else []
    return "openai-codex" in [item.strip("'\"") for item in items]


def load_realtime(root=None):
    """realtime.py loaded by its path under the plugins root, not the release path it resolves to.

    Python records the path it was given as each frame's co_filename, which Hermes
    compares with the plugins root. A fresh module each time keeps no state between mints.
    """
    path = (root or plugins_root()) / PLUGIN / "realtime.py"
    spec = importlib.util.spec_from_file_location("wildbots_voice_realtime", path)
    if spec is None or spec.loader is None:
        raise VoiceError(503, "The WildBots voice plugin could not be loaded. " + ENABLE_HINT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_session(data):
    """The complete Realtime session, from a validated request."""
    if not isinstance(data, dict) or set(data) - {"model", "voice", "instructions", "tools"}:
        raise VoiceError(400, "Send only model, voice, instructions and tools.")
    model, voice, instructions, tools = data.get("model"), data.get("voice"), data.get("instructions"), data.get("tools", [])
    if model != MODEL:
        raise VoiceError(400, f"Live voice uses {MODEL}.")
    if voice not in VOICES:
        raise VoiceError(400, "Choose one of the supported voices.")
    if not isinstance(instructions, str) or not instructions.strip() or len(instructions) > MAX_INSTRUCTIONS:
        raise VoiceError(400, f"Voice instructions must be 1 to {MAX_INSTRUCTIONS} characters.")
    if not isinstance(tools, list) or len(tools) > MAX_TOOLS or len(json.dumps(tools)) > MAX_TOOLS_JSON:
        raise VoiceError(400, f"Send at most {MAX_TOOLS} small function tools.")
    for tool in tools:
        if (not isinstance(tool, dict) or set(tool) - {"type", "name", "description", "parameters"} or tool.get("type") != "function"
                or not isinstance(tool.get("name"), str) or not TOOL_NAME.fullmatch(tool["name"])
                or not isinstance(tool.get("description", ""), str) or len(tool.get("description", "")) > 1000
                or not isinstance(tool.get("parameters"), dict) or tool["parameters"].get("type") != "object"):
            raise VoiceError(400, "Each voice tool must be a named function with an object schema.")
    return {
        "type": "realtime", "model": MODEL, "instructions": instructions,
        "audio": {
            "input": {
                "noise_reduction": {"type": "near_field"},
                "turn_detection": {"type": "semantic_vad", "eagerness": "auto", "create_response": True, "interrupt_response": True},
                "transcription": {"model": "gpt-4o-mini-transcribe"},
            },
            "output": {"voice": voice},
        },
        "tools": tools, "tool_choice": "auto",
    }


def mint(data, root=None):
    """Validates, mints and returns the app's answer. Blocking."""
    session = build_session(data)
    available, reason = plugin_state(root)
    if not available:
        raise VoiceError(503, reason)
    realtime = load_realtime(root)
    try:
        secret = realtime.mint_client_secret(session)
    except realtime.SignedOut:
        raise VoiceError(409, "Sign in to ChatGPT in Hermes to use live voice.") from None
    except (realtime.Refused, PermissionError):
        raise VoiceError(503, "Hermes refused the WildBots voice plugin. " + ENABLE_HINT) from None
    except realtime.UpstreamFailure as error:
        raise VoiceError(502, str(error)) from None
    return {"clientSecret": secret["value"], "expiresAt": secret["expires_at"], "model": MODEL, "voice": session["audio"]["output"]["voice"]}


def install(web):
    from fastapi import Request
    from starlette.responses import JSONResponse

    def answer(value, status=200):
        return JSONResponse(value, status_code=status, headers={"Cache-Control": "no-store"})

    def service(request):
        return getattr(request.state, "agent_interface_service_authenticated", False) is True

    async def status_endpoint(request: Request):
        if not service(request):
            return answer({"error": "Service authentication required"}, 401)
        try:
            available, reason = await asyncio.to_thread(plugin_state)
        except Exception:
            available, reason = False, "Hermes could not check the WildBots voice plugin."
        return answer({"available": available, **({"reason": reason} if reason else {})})

    async def secret_endpoint(request: Request):
        if not service(request):
            return answer({"error": "Service authentication required"}, 401)
        try:
            raw = await request.body()
            if len(raw) > 32 * 1024:
                raise VoiceError(400, "This voice session request is too large.")
            try:
                data = json.loads(raw)
            except ValueError:
                raise VoiceError(400, "Send a JSON voice session request.") from None
            return answer(await asyncio.to_thread(mint, data))
        except VoiceError as error:
            return answer({"error": str(error)}, error.status)
        except Exception:
            # Unreviewed exception text can carry request or credential details.
            return answer({"error": "Hermes could not start a voice session."}, 502)

    globals()["Request"] = Request
    web.app.add_api_route("/api/agent-interface/voice/status", status_endpoint, methods=["GET"])
    web.app.add_api_route("/api/agent-interface/voice/client-secret", secret_endpoint, methods=["POST"])
