"""Mints OpenAI Realtime client secrets on the household ChatGPT sign-in.

The WildBots add-on (src/hermes/voice.py) loads this file through the plugins
link, ~/.hermes/plugins/wildbots-voice/realtime.py, never through the release
path. Hermes checks that the nearest calling frame lives inside an installed
plugin whose manifest requires openai-codex, so credentialed_provider_request
must be called from this file directly. Hermes attaches the credential itself;
nothing here sees it.

Errors carry only a fixed sentence and, for upstream failures, the HTTP status.
An upstream body can echo request details, so it is never read into a message.
"""

URL = "https://api.openai.com/v1/realtime/client_secrets"
PROVIDER = "openai-codex"


class SignedOut(Exception):
    """The launch profile has no ChatGPT sign-in."""


class Refused(Exception):
    """Hermes refused the credentialed request, as for a plugin that is not installed or enabled."""


class UpstreamFailure(Exception):
    """OpenAI answered with an error or an unreadable secret."""

    def __init__(self, status=None):
        super().__init__("OpenAI did not issue a voice session" + (f" (HTTP {status})." if status else "."))
        self.status = status


def _secret(payload):
    """The secret's value and expiry, whether the answer nests them under client_secret or not."""
    if not isinstance(payload, dict):
        raise UpstreamFailure()
    nested = payload.get("client_secret")
    source = nested if isinstance(nested, dict) else payload
    value, expires = source.get("value"), source.get("expires_at")
    if not isinstance(value, str) or not 8 <= len(value) <= 4096 or any(ch.isspace() for ch in value):
        raise UpstreamFailure()
    if isinstance(expires, bool) or not isinstance(expires, int) or expires <= 0:
        raise UpstreamFailure()
    return {"value": value, "expires_at": expires}


def mint_client_secret(session, *, request=None, timeout=20):
    """POSTs the session to OpenAI and returns {"value", "expires_at"}.

    Blocking: call it off the event loop. ``request`` is for tests; production
    resolves Hermes's credentialed_provider_request here so the call stays in
    this file's frame.
    """
    try:
        from hermes_cli.plugin_provider_requests import ProviderNotSignedIn
    except ImportError:  # An older Hermes: the call below cannot exist either.
        ProviderNotSignedIn = None
    if request is None:
        try:
            from hermes_cli.plugin_provider_requests import credentialed_provider_request as request
        except ImportError:
            raise Refused("This Hermes version cannot share its ChatGPT sign-in with plugins.") from None
    try:
        response = request(PROVIDER, "POST", URL, json={"session": session},
                           headers={"Content-Type": "application/json"}, timeout=timeout)
    except PermissionError:
        raise Refused("Hermes refused the voice plugin's request.") from None
    except Exception as error:
        if ProviderNotSignedIn is not None and isinstance(error, ProviderNotSignedIn) or type(error).__name__ == "ProviderNotSignedIn":
            raise SignedOut("Sign in to ChatGPT in Hermes.") from None
        raise UpstreamFailure() from None
    status = getattr(response, "status", None)
    if not isinstance(status, int) or not 200 <= status < 300:
        raise UpstreamFailure(status if isinstance(status, int) else None)
    try:
        payload = response.json()
    except Exception:
        raise UpstreamFailure(status) from None
    return _secret(payload)
