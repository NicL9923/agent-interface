"""SSH and scp from the local release tools to the Hermes host, never waiting on a prompt.

BatchMode refuses password and unknown host-key prompts that would stall an unattended
loop. ConnectTimeout bounds connecting, ServerAlive ends a session whose network went
away, and every call names a subprocess timeout sized for its own operation. Programs
the tools send to the host stay in the tools as source.
"""
import subprocess

OPTIONS = ("-o", "BatchMode=yes", "-o", "ConnectTimeout=30",
           "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4")


def plain(argument):
    """A host or transfer path that ssh or scp cannot read as an option."""
    if not isinstance(argument, str) or not argument or argument.startswith("-"):
        raise ValueError("SSH host and transfer paths must not be empty or start with '-': " + repr(argument))
    return argument


def ssh(host, command, *, timeout, input=None, check=True, capture=False):
    """Run ``command`` on ``host`` and return the CompletedProcess, with text output.

    ``command`` is one shell string, or words ssh joins with spaces. ``capture`` keeps
    stdout and stderr instead of streaming them to this terminal.
    """
    words = [command] if isinstance(command, str) else list(command)
    return subprocess.run(["ssh", *OPTIONS, plain(host), *words], input=input, timeout=timeout,
                          check=check, capture_output=capture, text=True)


def scp(source, destination, *, timeout, recursive=False, check=True):
    """Copy quietly between this machine and ``host:path``; ``recursive`` copies a directory."""
    return subprocess.run(["scp", "-q", *OPTIONS, *(["-r"] if recursive else []), plain(source), plain(destination)],
                          timeout=timeout, check=check)
