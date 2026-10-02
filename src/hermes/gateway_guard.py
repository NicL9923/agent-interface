"""Persistent installer maintenance gate around the original native gateway.

Install agent_interface_gateway.py beside hermes_cli as a symlink to this file.
Use the native managed launcher --run-module agent_interface_gateway, retaining
its existing gateway.run arguments. Hermes still owns execution and shutdown.
"""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys


def maintenance_active(path):
    """Any present or unreadable lease is closed, including malformed files."""
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def install(drain, startup, status, path, inbound):
    path = Path(path)
    if not path.is_absolute():
        raise RuntimeError("Persistent gateway maintenance file must be absolute")
    runner = startup.GatewayStartupMixin
    ingress = inbound.GatewayInboundMixin
    for target, name in ((drain, "drain_requested"), (runner, "start"),
                         (runner, "_serving_state"), (runner, "_run_startup_resume_event"),
                         (status, "_get_code_identity_fields"), (ingress, "_handle_message"), (inbound, "t")):
        if not callable(getattr(target, name, None)):
            raise RuntimeError("Native gateway maintenance seams require qualification")
    previous = getattr(drain, "_agent_interface_persistent_gate", None)
    if previous is not None:
        if previous != str(path): raise RuntimeError("Gateway maintenance was already bound to another file")
        return
    requested = drain.drain_requested
    start = runner.start
    serving = runner._serving_state
    resume = runner._run_startup_resume_event
    identity = status._get_code_identity_fields
    handle_message = ingress._handle_message
    pending_ingress = 0

    def guarded_drain(*args, **kwargs):
        return maintenance_active(path) or requested(*args, **kwargs)

    async def guarded_start(self, *args, **kwargs):
        # The fresh native runner inherits this shared startup method. Set before
        # adapters and cron start, after its constructor initializes lifecycle.
        if maintenance_active(path): self._external_drain_active = True
        return await start(self, *args, **kwargs)

    def guarded_serving(self, *args, **kwargs):
        return "draining" if maintenance_active(path) else serving(self, *args, **kwargs)

    async def guarded_resume(self, *args, **kwargs):
        # Keep native resume ownership and its pending work. Never execute the
        # synthetic startup turn while the installer still holds maintenance.
        while maintenance_active(path): await asyncio.sleep(.25)
        return await resume(self, *args, **kwargs)

    async def guarded_message(self, event, *args, **kwargs):
        nonlocal pending_ingress
        # Native preflight awaits before reserving a turn, and internal/idle
        # commands can bypass its later drain check. Fence every inbound path.
        if maintenance_active(path):
            return None if getattr(event, "internal", False) else inbound.t("gateway.busy.draining_maintenance")
        pending_ingress += 1
        try:
            return await handle_message(self, event, *args, **kwargs)
        finally:
            pending_ingress -= 1

    def guarded_identity():
        return dict(identity(), agent_interface_gateway_guard={"schemaVersion": 1, "maintenanceFile": str(path), "pendingIngress": pending_ingress})

    drain.drain_requested = guarded_drain
    runner.start = guarded_start
    runner._serving_state = guarded_serving
    runner._run_startup_resume_event = guarded_resume
    ingress._handle_message = guarded_message
    status._get_code_identity_fields = guarded_identity
    drain._agent_interface_persistent_gate = str(path)


def bootstrap():
    configured = os.environ.get("HERMES_AGENT_INTERFACE_MAINTENANCE_FILE", "")
    if not configured or not Path(configured).is_absolute():
        raise SystemExit("Configure the fixed persistent gateway maintenance file before starting this wrapper")
    # The same exact revision/repair receipt as the dashboard protects these
    # native method seams. An unqualified gateway cannot bypass a held lease.
    spec = importlib.util.spec_from_file_location("agent_interface_extension", Path(__file__).resolve().with_name("extension.py"))
    extension = importlib.util.module_from_spec(spec); spec.loader.exec_module(extension)
    extension.source_state()
    computer_spec = importlib.util.spec_from_file_location("agent_interface_computer", Path(__file__).resolve().with_name("computer.py"))
    computer = importlib.util.module_from_spec(computer_spec); computer_spec.loader.exec_module(computer)
    computer.install_tools()
    integration_spec = importlib.util.spec_from_file_location("agent_interface_integrations", Path(__file__).resolve().with_name("integrations.py"))
    integrations = importlib.util.module_from_spec(integration_spec); integration_spec.loader.exec_module(integrations)
    integrations.register_file_tool()
    integrations.register_google_tasks_tool()
    integrations.register_tool_catalog()
    import gateway.drain_control as drain
    import gateway.run_startup as startup
    import gateway.status as status
    import gateway.run_inbound as inbound
    install(drain, startup, status, Path(configured), inbound)


def native_command(source, python, args):
    """Truthful native run_path entry, recognized by Hermes' process identity."""
    source = Path(source).resolve()
    code = (
        f"import sys, runpy; sys.path.insert(0, {str(source)!r}); import os; "
        "os.environ.pop('PYTHONHOME', None); os.environ.pop('PYTHONPATH', None); "
        "os.environ.pop('VIRTUAL_ENV', None); "
        "os.environ['HERMES_HOME'] = os.environ.get('HERMES_HOME') or "
        "str(__import__('hermes_constants').get_default_hermes_root()); "
        "import hermes_bootstrap; import agent_interface_gateway; "
        "agent_interface_gateway.bootstrap(); "
        f"runpy.run_path({str(source / 'gateway/run.py')!r}, run_name='__main__')"
    )
    return [str(python), "-I", "-c", code, *args]


def main():
    # Exec retains the service's PID and its original native gateway arguments.
    # The process command must name the entry point it really executes, otherwise
    # native status can miss the owner and another CLI can start a second gateway.
    import hermes_cli
    from hermes_cli._launchers import runtime_command
    source = Path(hermes_cli.__file__).resolve().parents[1]
    bootstrap()
    python = runtime_command(source, module="gateway.run")[0]
    command = native_command(source, python, sys.argv[1:])
    os.execv(command[0], command)


if __name__ == "__main__": main()
