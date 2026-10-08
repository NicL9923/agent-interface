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


UPDATE_HANDOFF_MESSAGE = ("Hermes updates are managed by WildBots. Check for and install them "
                          "from Hermes updates in the app.")


def hand_updates_to_app():
    """Turn off the native dashboard's own Hermes updater.

    A native update moves Hermes past the app's qualification, which disables this
    add-on until an installer recovers it. The app's updater qualifies first. Uses
    the native switch for externally managed installs, so the update control, check
    and install routes all refuse. Returns False, leaving the native updater on, when
    this Hermes revision lacks the switch; qualification requires True.
    """
    try:
        import hermes_cli.web_server_files as files
        import hermes_cli.web_routers.actions as actions
    except ImportError:
        return False
    if not hasattr(files, "_dashboard_local_update_managed_externally") or not hasattr(actions, "_MANAGED_EXTERNALLY_MESSAGE"):
        return False
    files._dashboard_local_update_managed_externally = lambda: True
    actions._MANAGED_EXTERNALLY_MESSAGE = UPDATE_HANDOFF_MESSAGE
    return True


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
        print("WildBots add-on disabled: source qualification or service key unavailable. Native dashboard continues.", file=sys.stderr)
        qualified = False
    # Let the native entrypoint initialize the same environment before importing the web app.
    from hermes_cli import main as cli
    # Applies even while the add-on is disabled, so a second native update cannot
    # move Hermes further from the app's last qualification.
    if not hand_updates_to_app():
        print("WildBots could not turn off the native Hermes updater. Update Hermes from the app only.", file=sys.stderr)
    if qualified:
        import hermes_cli.web_server as web
        from tui_gateway import server
        sibling("computer").install_tools()
        journal = extension.install()
        sibling("experience").install(web, journal, server._history_to_messages)
        sibling("vault").install(web, journal)
        sibling("integrations").install(web)
        service.install_service_auth(web, secret)
    cli.main()


if __name__ == "__main__":
    main()
