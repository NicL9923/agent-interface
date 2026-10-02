"""Production dashboard wrapper. Run with the existing PM-managed Hermes Python.

hermes --run-module agent_interface_dashboard dashboard --host 127.0.0.1 --port 9119 --no-open
Install agent_interface_dashboard.py as a symlink to this file beside hermes_cli.
The original CLI owns configuration, plugins, auth, owner registration, UI and lifecycle.
"""
import os
import sys
import importlib.util
import subprocess
from pathlib import Path


def main():
    if len(sys.argv) < 2 or sys.argv[1] != "dashboard" or "--isolated" in sys.argv:
        raise SystemExit("This wrapper starts the existing supervised dashboard only.")
    if os.environ.get("HERMES_SERVE_HEADLESS") == "1":
        raise SystemExit("A production dashboard must preserve its UI. Remove HERMES_SERVE_HEADLESS.")
    def sibling(name):
        spec = importlib.util.spec_from_file_location("agent_interface_" + name, Path(__file__).resolve().with_name(name + ".py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    extension, service = sibling("extension"), sibling("service_auth")
    secret = os.environ.get("HERMES_AGENT_INTERFACE_TOKEN", "")
    qualified = True
    try:
        service.validate_secret(secret)
        extension.source_state()
    except (SystemExit, OSError, subprocess.SubprocessError):
        # This check is pure. Preserve the native dashboard if its separately
        # deployed integration needs requalification or credential repair.
        print("Agent Interface add-on disabled: source qualification or service key unavailable. Native dashboard continues.", file=sys.stderr)
        qualified = False
    # Let the native entrypoint initialize the same environment before importing the web app.
    from hermes_cli import main as cli
    if qualified:
        import hermes_cli.web_server as web
        sibling("computer").install_tools()
        journal = extension.install()
        sibling("experience").install(web, journal)
        sibling("vault").install(web, journal)
        sibling("integrations").install(web)
        service.install_service_auth(web, secret)
    cli.main()


if __name__ == "__main__":
    main()
