"""WildBots live voice plugin for Hermes.

The plugin exists so its directory holds a manifest declaring requires_auth:
[openai-codex]. Hermes then lets code in this directory, realtime.py, make a
credentialed request on the household ChatGPT sign-in. It registers nothing.
"""


def register(ctx):
    """Hermes calls this when the plugin is enabled. Live voice needs no tools or hooks."""
    return None
